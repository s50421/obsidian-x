import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { logAudit } from "@/lib/audit";
import { applyProposal, rejectProposalById } from "@/lib/proposals";
import { reprojectItemToVault } from "@/lib/vault-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v4.0 W3 — the swipe deck's action endpoint. One POST for both modes:
//   daily:  keep (audit deck_reviewed) | archive (status=archived, audit
//           deck_archived) | edit (persist inline edits, card stays in deck)
//   import: approve (-> lib/proposals.applyProposal, the SHARED apply logic —
//           W2 owns retitle/split support there; today it returns "unsupported
//           proposal kind" for both, which this route surfaces as ok:false
//           without touching proposal state, so it's a safe no-op until W2
//           lands) | reject (-> lib/proposals.rejectProposalById) | edit
//           (merges into proposals.payload so an eventual approve applies the
//           owner's edited values)
// `undo` reverses the previous action using the `undo` descriptor that action
// returned (the client echoes it back verbatim as `edits.undo` on the follow-up
// call) — a 5s toast window on the client, not a time limit enforced here.

const ITEM_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event", "memory"];
const PRIORITIES = ["low", "medium", "high"];

type Mode = "daily" | "import";
type Action = "keep" | "archive" | "approve" | "reject" | "undo" | "edit";

type DailyEdits = { title?: string; type?: string; tags?: string[]; priority?: string | null };
type ImportEdits = Record<string, unknown>; // shallow-merged into the proposal payload

type UndoDescriptor =
  | { kind: "daily_keep"; itemId: string }
  | { kind: "daily_archive"; itemId: string; prevStatus: string }
  | { kind: "import_approve"; proposalId: string }
  | { kind: "import_reject"; proposalId: string };

type Body = {
  mode?: Mode;
  id?: string;
  action?: Action;
  edits?: (DailyEdits & ImportEdits & { undo?: UndoDescriptor }) | null;
};

function sanitizeDailyEdits(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const e = raw as DailyEdits;
  const out: Record<string, unknown> = {};
  if (typeof e.title === "string" && e.title.trim()) out.title = e.title.trim().slice(0, 200);
  if (typeof e.type === "string" && ITEM_TYPES.includes(e.type)) out.type = e.type;
  if (Array.isArray(e.tags)) out.tags = e.tags.filter((t): t is string => typeof t === "string").slice(0, 20);
  if (e.priority === null || (typeof e.priority === "string" && PRIORITIES.includes(e.priority)))
    out.priority = e.priority;
  return out;
}

// ---- daily mode -------------------------------------------------------------

async function dailyAction(admin: SupabaseClient, userId: string, itemId: string, action: Action, edits: unknown) {
  const { data: item } = await admin
    .from("items")
    .select("id,status,title,type,tags,priority")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!item) return NextResponse.json({ ok: false, message: "Item not found" }, { status: 404 });

  if (action === "edit") {
    const patch = sanitizeDailyEdits(edits);
    if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true, message: "Nothing to save" });
    await admin.from("items").update(patch).eq("id", itemId).eq("user_id", userId);
    await reprojectItemToVault(admin, itemId).catch(() => {});
    await logAudit(admin, { user_id: userId, item_id: itemId, action: "deck_edit", actor: "user", detail: { patch } });
    return NextResponse.json({ ok: true, message: "Saved" });
  }

  if (action === "keep") {
    const patch = sanitizeDailyEdits(edits);
    if (Object.keys(patch).length > 0) {
      await admin.from("items").update(patch).eq("id", itemId).eq("user_id", userId);
      await reprojectItemToVault(admin, itemId).catch(() => {});
    }
    await logAudit(admin, {
      user_id: userId,
      item_id: itemId,
      action: "deck_reviewed",
      actor: "user",
      detail: Object.keys(patch).length ? { edited: true, patch } : {},
    });
    const undo: UndoDescriptor = { kind: "daily_keep", itemId };
    return NextResponse.json({ ok: true, message: "Kept", undo });
  }

  if (action === "archive") {
    const prevStatus = item.status;
    if (prevStatus !== "archived") {
      await admin.from("items").update({ status: "archived" }).eq("id", itemId).eq("user_id", userId);
      await reprojectItemToVault(admin, itemId).catch(() => {});
    }
    await logAudit(admin, {
      user_id: userId,
      item_id: itemId,
      action: "deck_archived",
      actor: "user",
      detail: { prevStatus },
    });
    const undo: UndoDescriptor = { kind: "daily_archive", itemId, prevStatus };
    return NextResponse.json({ ok: true, message: "Archived", undo });
  }

  if (action === "undo") {
    const d = (edits as { undo?: UndoDescriptor } | null)?.undo;
    if (!d) return NextResponse.json({ ok: false, message: "Nothing to undo" }, { status: 400 });
    if (d.kind === "daily_keep") {
      await logAudit(admin, { user_id: userId, item_id: itemId, action: "deck_reviewed_undo", actor: "user" });
      return NextResponse.json({ ok: true, message: "Undone" });
    }
    if (d.kind === "daily_archive") {
      const restore = d.prevStatus === "archived" ? "open" : d.prevStatus;
      await admin.from("items").update({ status: restore }).eq("id", itemId).eq("user_id", userId);
      await reprojectItemToVault(admin, itemId).catch(() => {});
      await logAudit(admin, {
        user_id: userId,
        item_id: itemId,
        action: "deck_archived_undo",
        actor: "user",
        detail: { restoredStatus: restore },
      });
      return NextResponse.json({ ok: true, message: "Undone" });
    }
    return NextResponse.json({ ok: false, message: "Undo descriptor doesn't match this mode" }, { status: 400 });
  }

  return NextResponse.json({ ok: false, message: "Unsupported action for daily mode" }, { status: 400 });
}

// ---- import mode --------------------------------------------------------------

async function importAction(admin: SupabaseClient, userId: string, proposalId: string, action: Action, edits: unknown) {
  const { data: proposal } = await admin
    .from("proposals")
    .select("id,kind,status,payload,source_item_id")
    .eq("id", proposalId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!proposal) return NextResponse.json({ ok: false, message: "Proposal not found" }, { status: 404 });

  const isEditable = proposal.kind === "retitle" || proposal.kind === "split";

  if (action === "edit") {
    if (!isEditable) return NextResponse.json({ ok: false, message: "Not editable" }, { status: 400 });
    const raw = (edits ?? {}) as Record<string, unknown>;
    const { undo: _undo, ...patchFields } = raw;
    void _undo;
    if (Object.keys(patchFields).length === 0) return NextResponse.json({ ok: true, message: "Nothing to save" });
    const merged = { ...(proposal.payload ?? {}), ...patchFields };
    await admin.from("proposals").update({ payload: merged }).eq("id", proposalId).eq("user_id", userId);
    await logAudit(admin, {
      user_id: userId,
      item_id: proposal.source_item_id,
      action: "deck_edit",
      actor: "user",
      detail: { proposal_id: proposalId, patch: patchFields },
    });
    return NextResponse.json({ ok: true, message: "Saved" });
  }

  if (action === "approve") {
    if (proposal.status !== "pending") {
      return NextResponse.json({ ok: false, message: "Already handled" }, { status: 409 });
    }
    const raw = (edits ?? {}) as Record<string, unknown>;
    const { undo: _undo2, ...patchFields } = raw;
    void _undo2;
    if (isEditable && Object.keys(patchFields).length > 0) {
      const merged = { ...(proposal.payload ?? {}), ...patchFields };
      await admin.from("proposals").update({ payload: merged }).eq("id", proposalId).eq("user_id", userId);
    }
    // Shared apply logic — W2 owns retitle/split support in lib/proposals.ts.
    // Until that lands this returns { ok:false, message:"Unsupported proposal
    // kind" } and nothing here mutates proposal/item state, so it's a safe,
    // idempotent no-op the client can retry once W2 merges.
    const result = await applyProposal(admin, userId, proposalId);
    if (!result.ok) return NextResponse.json({ ok: false, message: result.message });
    await logAudit(admin, {
      user_id: userId,
      item_id: proposal.source_item_id,
      action: "deck_approved",
      actor: "user",
      detail: { proposal_id: proposalId, kind: proposal.kind },
    });
    const undo: UndoDescriptor = { kind: "import_approve", proposalId };
    return NextResponse.json({ ok: true, message: result.message, undo });
  }

  if (action === "reject") {
    const rejected = await rejectProposalById(admin, userId, proposalId);
    if (!rejected) return NextResponse.json({ ok: false, message: "Already handled" }, { status: 409 });
    await logAudit(admin, {
      user_id: userId,
      item_id: proposal.source_item_id,
      action: "deck_rejected",
      actor: "user",
      detail: { proposal_id: proposalId, kind: proposal.kind },
    });
    const undo: UndoDescriptor = { kind: "import_reject", proposalId };
    return NextResponse.json({ ok: true, message: "Rejected", undo });
  }

  if (action === "undo") {
    const d = (edits as { undo?: UndoDescriptor } | null)?.undo;
    if (!d) return NextResponse.json({ ok: false, message: "Nothing to undo" }, { status: 400 });
    if (d.kind === "import_reject") {
      const { data } = await admin
        .from("proposals")
        .update({ status: "pending", decided_at: null })
        .eq("id", proposalId)
        .eq("user_id", userId)
        .eq("status", "rejected")
        .select("id")
        .maybeSingle();
      if (!data) return NextResponse.json({ ok: false, message: "Can't undo — no longer rejected" }, { status: 409 });
      await logAudit(admin, {
        user_id: userId,
        item_id: proposal.source_item_id,
        action: "deck_reject_undo",
        actor: "user",
        detail: { proposal_id: proposalId },
      });
      return NextResponse.json({ ok: true, message: "Undone" });
    }
    if (d.kind === "import_approve") {
      // Best-effort: flips the proposal back to pending. Any side-effect the
      // shared applyProposal already performed (a ClickUp task today; a
      // retitle/split item write once W2's apply logic lands) is NOT
      // automatically reverted — see the integration note in the deck's
      // final report. Safe today because retitle/split apply is a no-op.
      const { data } = await admin
        .from("proposals")
        .update({ status: "pending", decided_at: null, result: null })
        .eq("id", proposalId)
        .eq("user_id", userId)
        .eq("status", "approved")
        .select("id")
        .maybeSingle();
      if (!data) return NextResponse.json({ ok: false, message: "Can't undo — no longer approved" }, { status: 409 });
      await logAudit(admin, {
        user_id: userId,
        item_id: proposal.source_item_id,
        action: "deck_approve_undo",
        actor: "user",
        detail: { proposal_id: proposalId, note: "proposal state reverted; any applied item/external write is not" },
      });
      return NextResponse.json({ ok: true, message: "Undone" });
    }
    return NextResponse.json({ ok: false, message: "Undo descriptor doesn't match this mode" }, { status: 400 });
  }

  return NextResponse.json({ ok: false, message: "Unsupported action for import mode" }, { status: 400 });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { mode, id, action, edits } = body;
  if ((mode !== "daily" && mode !== "import") || !id || typeof id !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!action || !["keep", "archive", "approve", "reject", "undo", "edit"].includes(action)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  // "keep"/"archive" only make sense in daily mode; "approve"/"reject" only in
  // import mode — "edit" and "undo" apply to both.
  if ((action === "keep" || action === "archive") && mode !== "daily") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if ((action === "approve" || action === "reject") && mode !== "import") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const admin = createAdminClient();
  return mode === "daily"
    ? dailyAction(admin, user.id, id, action, edits)
    : importAction(admin, user.id, id, action, edits);
}
