import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage } from "@/lib/telegram";
import { createClickUpTask } from "@/lib/clickup";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { applyEntityMerge } from "@/lib/entities";
import { logAudit } from "@/lib/audit";
import { embedText } from "@/lib/embed";
import { writeVaultNote, deleteVaultNote } from "@/lib/vault";
import {
  cleanTitle,
  mergeTags,
  coerceType,
  isValidISODate,
  capSplitParts,
} from "@/lib/title-standard.mjs";

// v1.5 T2/T4: turn an actionable item (e.g. a task captured from an email) into a
// pending proposal to create a ClickUp task, surface it to the owner (Telegram +
// /approvals), and apply/reject it. Approving runs the action.
//
// v4.0 W2 adds two more kinds, both produced by scripts/reprocess-corpus.mjs and
// consumed by the swipe deck:
//   • 'retitle' — one item, one clean topic-first title + type + tags (+ due
//                 date / entities), re-embedded so retrieval follows the title.
//   • 'split'   — one item that holds several distinct topics becomes N new
//                 items; the original is archived and superseded by part 1.
// Rejecting either leaves the item completely untouched; both are reversible
// from the audit trail, which carries the full before-state.

export type ProposalRow = { id: string; title: string | null };

// ---------------------------------------------------------------------------
// PAYLOAD CONTRACT (v4.0 W2 — fixed; the swipe deck builds against exactly this)
// ---------------------------------------------------------------------------

export type RetitlePayload = {
  itemId: string;
  oldTitle: string | null;
  newTitle: string;
  newType: string;
  newTags: string[];
  dueAt?: string | null; // ISO timestamptz, or absent/null
  entities?: { name: string; kind: string }[];
  confidence: number; // 0..1, the classifier's certainty
  reason: string; // one sentence, shown on the card
  junkScore?: number; // 0..10; 5-7 reached the deck as "possible junk"
};

export type SplitPart = {
  title: string;
  body: string;
  type: string;
  tags: string[];
};

export type SplitPayload = {
  itemId: string;
  oldTitle: string | null;
  parts: SplitPart[]; // always >= 2, never more than MAX_SPLIT_PARTS (6)
  confidence: number;
  reason: string;
  junkScore?: number;
};

// Injection seam so the apply path can be exercised end-to-end against a scratch
// Postgres with no network (tests pass a deterministic fake embedder). Callers
// in app/** pass nothing and get the real OpenAI-backed embedText.
export type ApplyDeps = {
  embed?: (text: string, userId?: string) => Promise<number[]>;
};

type ClickUpPayload = {
  name?: string;
  description?: string | null;
  due_at?: string | null;
  priority?: string | null;
};

export type ApplyResult = {
  ok: boolean;
  message: string;
  url?: string;
  alreadyHandled?: boolean;
};

// Create a `clickup_task` proposal from an existing item. Returns the row, or
// null if the item is missing.
export async function proposeClickUpTaskForItem(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  source: string
): Promise<ProposalRow | null> {
  const { data: item } = await admin
    .from("items")
    .select("id, title, body, due_at, priority, type, external")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!item) return null;
  // Reconcile: don't propose a second ClickUp task for an item already linked.
  const external = item.external as { clickup?: { id?: string } } | null;
  if (external?.clickup?.id) return null;

  const payload: ClickUpPayload = {
    name: item.title,
    description: item.body ?? null,
    due_at: item.due_at ?? null,
    priority: item.priority ?? null,
  };

  const { data: p } = await admin
    .from("proposals")
    .insert({
      user_id: userId,
      kind: "clickup_task",
      status: "pending",
      title: item.title,
      payload,
      source,
      source_item_id: item.id,
    })
    .select("id, title")
    .single();

  return p ?? null;
}

// Push a pending clickup_task proposal to Telegram with Approve/Reject buttons.
export async function notifyClickUpProposal(p: ProposalRow): Promise<void> {
  await sendMessage(`📋 Proposed task: ${p.title ?? "(untitled)"}\n\nAdd this to ClickUp?`, {
    parse_mode: "plain",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${p.id}` },
          { text: "✖ Reject", callback_data: `reject:${p.id}` },
        ],
      ],
    },
  });
}

// Approve a pending proposal → run its action. Currently: create a ClickUp task,
// record the ref back on the source item, and audit it. Shared by Telegram +
// the /approvals page. Never throws — returns a structured result.
export async function applyProposal(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  deps: ApplyDeps = {}
): Promise<ApplyResult> {
  const { data: p } = await admin
    .from("proposals")
    .select("id, kind, status, payload, source_item_id, title")
    .eq("id", proposalId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!p) return { ok: false, alreadyHandled: true, message: "This request is no longer available" };
  if (p.status !== "pending") return { ok: false, alreadyHandled: true, message: "Already handled" };

  // v4.0 W2 — the swipe deck's two kinds. Both are wrapped so a failure leaves
  // the proposal pending and the item untouched (the deck can safely retry).
  if (p.kind === "retitle" || p.kind === "split") {
    try {
      return p.kind === "retitle"
        ? await applyRetitle(admin, userId, proposalId, (p.payload ?? {}) as RetitlePayload, deps)
        : await applySplit(admin, userId, proposalId, (p.payload ?? {}) as SplitPayload, deps);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Brain-quality Phase 2 — merging two canonical entities. Judgement calls
  // only: the deterministic resolver already folds exact/alias/case matches
  // without asking. A merge is close to irreversible (the losing row's evidence
  // becomes an alias), which is exactly why it goes through this queue.
  if (p.kind === "entity_merge") {
    const m = (p.payload ?? {}) as { fromId?: string; intoId?: string; fromName?: string; intoName?: string };
    if (!m.fromId || !m.intoId) return { ok: false, message: "Merge is missing its entities" };
    try {
      const res = await applyEntityMerge(admin, userId, m.fromId, m.intoId);
      if (!res.ok) return { ok: false, message: "One of those entities no longer exists" };
      await admin
        .from("proposals")
        .update({ status: "approved", decided_at: new Date().toISOString(), result: { moved: res.moved } })
        .eq("id", proposalId);
      // The surviving row is settled now, so drop the "under question" flag on
      // whatever is left.
      await admin.from("entities").update({ needs_review: false }).eq("id", m.intoId);
      await logAudit(admin, {
        user_id: userId,
        action: "entity_merged",
        actor: "user",
        detail: { proposal_id: proposalId, from: m.fromName, into: m.intoName, links_moved: res.moved },
      });
      return { ok: true, message: `Merged "${m.fromName}" into "${m.intoName}" (${res.moved} link${res.moved === 1 ? "" : "s"} moved)` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (p.kind !== "clickup_task") return { ok: false, message: "Unsupported proposal kind" };

  const payload = (p.payload ?? {}) as ClickUpPayload;
  try {
    const task = await createClickUpTask({
      name: payload.name ?? p.title ?? "Task",
      description: payload.description ?? null,
      dueAt: payload.due_at ?? null,
      priority: payload.priority ?? null,
    });
    await admin
      .from("proposals")
      .update({
        status: "approved",
        decided_at: new Date().toISOString(),
        result: { clickup_id: task.id, url: task.url },
      })
      .eq("id", proposalId);
    if (p.source_item_id) {
      await admin
        .from("items")
        .update({ external: { clickup: { id: task.id, url: task.url } } })
        .eq("id", p.source_item_id)
        .eq("user_id", userId);
      await reprojectItemToVault(admin, p.source_item_id); // project the ClickUp link into the vault
    }
    await logAudit(admin, {
      user_id: userId,
      item_id: p.source_item_id,
      action: "clickup_task_created",
      actor: "user",
      detail: { proposal_id: proposalId, clickup_id: task.id, url: task.url },
    });
    return { ok: true, message: `Created in ClickUp: ${task.name}`, url: task.url };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// v4.0 W2 — retitle / split apply
// ---------------------------------------------------------------------------

type ItemForApply = {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  raw: string | null;
  tags: string[] | null;
  priority: string | null;
  source: string;
  status: string;
  due_at: string | null;
  entities: { name: string; kind: string }[] | null;
  links: string[] | null;
  created_at: string;
  vault_path: string | null;
  sensitive: boolean | null;
};

const ITEM_APPLY_COLS =
  "id,type,title,body,raw,tags,priority,source,status,due_at,entities,links,created_at,vault_path,sensitive";

async function loadItem(
  admin: SupabaseClient,
  userId: string,
  itemId: string | null | undefined
): Promise<ItemForApply | null> {
  if (!itemId) return null;
  const { data } = await admin
    .from("items")
    .select(ITEM_APPLY_COLS)
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as ItemForApply | null) ?? null;
}

// Re-embedding after a retitle/split is best-effort: the title is part of the
// embedding basis, so a stale vector only degrades retrieval — it must never
// roll back a change the owner already approved.
async function reembed(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  title: string,
  body: string,
  deps: ApplyDeps
): Promise<boolean> {
  try {
    const embed = deps.embed ?? embedText;
    const vector = await embed(`${title}\n\n${body}`, userId);
    const { error } = await admin.from("items").update({ embedding_v2: vector }).eq("id", itemId);
    return !error;
  } catch {
    return false;
  }
}

async function markApproved(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  result: Record<string, unknown>
): Promise<void> {
  await admin
    .from("proposals")
    .update({ status: "approved", decided_at: new Date().toISOString(), result })
    .eq("id", proposalId)
    .eq("user_id", userId);
}

/**
 * 'retitle' — the same memory, correctly titled. Title/type/tags (+ due date and
 * entities when the payload carries them) are written in place; the item keeps
 * its id, so links, ClickUp refs and the vault file all stay valid. NOT a
 * supersede: nothing about the memory itself changed.
 *
 * Reversibility: the audit entry carries the complete before-state.
 */
async function applyRetitle(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  payload: RetitlePayload,
  deps: ApplyDeps
): Promise<ApplyResult> {
  const item = await loadItem(admin, userId, payload.itemId);
  if (!item) return { ok: false, message: "The item this refers to no longer exists" };

  // The payload may have been edited in the deck, so everything is re-sanitised
  // here rather than trusted — same rules the classifier was held to.
  const title = cleanTitle(payload.newTitle);
  if (!title) return { ok: false, message: "That title is empty after cleanup — edit it first" };

  const patch: Record<string, unknown> = {
    title,
    type: coerceType(payload.newType, item.type),
    tags: mergeTags(item.tags, payload.newTags),
  };
  if (payload.dueAt !== undefined) {
    patch.due_at = isValidISODate(payload.dueAt)
      ? new Date(`${payload.dueAt}T09:00:00Z`).toISOString()
      : (payload.dueAt ?? null);
  }
  if (Array.isArray(payload.entities) && payload.entities.length) patch.entities = payload.entities;
  // The owner has now looked at it: whatever review flag put it here is cleared.
  patch.needs_review = false;
  patch.review_reason = null;

  const before = {
    title: item.title,
    type: item.type,
    tags: item.tags ?? [],
    due_at: item.due_at,
    entities: item.entities ?? [],
  };

  const { error } = await admin.from("items").update(patch).eq("id", item.id).eq("user_id", userId);
  if (error) return { ok: false, message: `Could not save: ${error.message}` };

  const reembedded = await reembed(admin, userId, item.id, title, item.body ?? "", deps);
  await reprojectItemToVault(admin, item.id);
  await markApproved(admin, userId, proposalId, { item_id: item.id, title, reembedded });
  await logAudit(admin, {
    user_id: userId,
    item_id: item.id,
    action: "retitle_applied",
    actor: "user",
    detail: {
      proposal_id: proposalId,
      before,
      after: { title, type: patch.type, tags: patch.tags },
      junk_score: payload.junkScore ?? null,
      reembedded,
    },
  });

  return { ok: true, message: `Retitled: ${title}` };
}

/**
 * 'split' — one captured note that held N distinct topics becomes N memories.
 *
 * Bi-temporal supersede, per the propose-then-approve law: the parts are NEW
 * rows (own ids, own embeddings, cross-linked to each other), and the original
 * is closed out rather than edited — status 'archived', `valid_to` set to the
 * split instant, `superseded_by` pointing at the first part. The original body
 * stays readable forever, and reversing the split is: clear valid_to /
 * superseded_by, restore status, delete the parts.
 */
async function applySplit(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  payload: SplitPayload,
  deps: ApplyDeps
): Promise<ApplyResult> {
  const item = await loadItem(admin, userId, payload.itemId);
  if (!item) return { ok: false, message: "The item this refers to no longer exists" };

  const { parts: capped } = capSplitParts(Array.isArray(payload.parts) ? payload.parts : []);
  const parts = capped
    .map((raw) => ({
      title: cleanTitle(raw?.title),
      body: typeof raw?.body === "string" ? raw.body.trim() : "",
      type: coerceType(raw?.type, item.type),
      tags: mergeTags(item.tags, raw?.tags),
    }))
    .filter((p) => p.title && p.body);
  if (parts.length < 2) return { ok: false, message: "A split needs at least two usable parts" };

  const now = new Date().toISOString();
  const createdIds: string[] = [];
  const createdTitles: string[] = [];

  for (const part of parts) {
    const { data: row, error } = await admin
      .from("items")
      .insert({
        user_id: userId,
        type: part.type,
        title: part.title,
        body: part.body,
        // The parts are readings of the SAME capture, so they all point back to
        // the one original text.
        raw: item.raw ?? item.body,
        status: "open",
        priority: item.priority ?? "medium",
        tags: part.tags,
        source: item.source,
        sensitive: item.sensitive ?? false,
        // The memory is as old as its capture; only the row is new.
        created_at: item.created_at,
        valid_from: now,
        entities: [],
        confidence: payload.confidence ?? null,
        needs_review: false,
      })
      .select("id,title")
      .single();
    if (error || !row) {
      // Partial failure: keep what was created (each is a valid memory), leave
      // the original untouched, and leave the proposal pending so it can be
      // retried after the owner has removed the duplicates.
      return {
        ok: false,
        message: `Created ${createdIds.length} of ${parts.length} parts, then failed: ${
          error?.message ?? "unknown"
        }`,
      };
    }
    createdIds.push(row.id as string);
    createdTitles.push(row.title as string);
  }

  // Cross-link the siblings, embed, and project each part into the vault.
  for (let i = 0; i < createdIds.length; i++) {
    const id = createdIds[i];
    const siblings = createdIds.filter((x) => x !== id);
    await admin.from("items").update({ links: siblings }).eq("id", id);
    await reembed(admin, userId, id, parts[i].title, parts[i].body, deps);
    try {
      const vaultPath = await writeVaultNote({
        id,
        type: parts[i].type,
        title: parts[i].title,
        body: parts[i].body,
        tags: parts[i].tags,
        priority: item.priority ?? "medium",
        source: item.source,
        createdAt: item.created_at,
        entities: [],
        links: siblings.map((sid, j) => ({ id: sid, title: createdTitles[j] })),
        status: "open",
      });
      await admin.from("items").update({ vault_path: vaultPath }).eq("id", id);
    } catch {
      // vault projection is best-effort; the DB is the source of truth
    }
  }

  // Close out the original (bi-temporal supersede — never a destructive edit).
  const beforeStatus = item.status;
  const { error: supErr } = await admin
    .from("items")
    .update({ status: "archived", valid_to: now, superseded_by: createdIds[0] })
    .eq("id", item.id)
    .eq("user_id", userId);
  if (supErr) {
    return { ok: false, message: `Parts created but the original could not be closed: ${supErr.message}` };
  }
  await reprojectItemToVault(admin, item.id);

  await markApproved(admin, userId, proposalId, { item_ids: createdIds, titles: createdTitles });
  await logAudit(admin, {
    user_id: userId,
    item_id: item.id,
    action: "split_applied",
    actor: "user",
    detail: {
      proposal_id: proposalId,
      before: { status: beforeStatus, title: item.title },
      parts: createdIds,
      titles: createdTitles,
      superseded_by: createdIds[0],
    },
  });

  return { ok: true, message: `Split into ${createdIds.length}: ${createdTitles.join(" · ")}` };
}

// Reject a pending proposal. Returns true if it was pending and is now rejected.
/* ---------------------------------------------------------------------------
   v4.0.1 item 3 — REAL reversal of an applied import proposal.

   The deck's undo used to flip the proposal row back to `pending` and stop
   there, leaving the item write in place. That is worse than having no undo:
   the toast says "Undone", the title stays changed, and the owner has no reason
   to doubt it. The brief's instruction was "honesty over fake undo" — either
   reverse it for real or drop the affordance.

   Reversing it for real turned out to be reachable: applyRetitle and applySplit
   both already write a complete `before` block into the audit trail, precisely
   so this would be possible. These read it back.
   --------------------------------------------------------------------------- */

type RetitleBefore = {
  title: string | null;
  type: string;
  tags: string[];
  due_at: string | null;
  entities: { name: string; kind: string }[];
};

/** The audit row an apply left behind, newest first. */
async function loadApplyAudit(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  action: "retitle_applied" | "split_applied"
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("audit")
    .select("detail")
    .eq("user_id", userId)
    .eq("action", action)
    .eq("detail->>proposal_id", proposalId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.detail as Record<string, unknown> | undefined) ?? null;
}

async function markPendingAgain(
  admin: SupabaseClient,
  userId: string,
  proposalId: string
): Promise<boolean> {
  const { data } = await admin
    .from("proposals")
    .update({ status: "pending", decided_at: null, result: null })
    .eq("id", proposalId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .select("id")
    .maybeSingle();
  return !!data;
}

/** Put the item's title/type/tags/due/entities back exactly as they were. */
export async function undoRetitle(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  itemId: string,
  deps: ApplyDeps = {}
): Promise<ApplyResult> {
  const detail = await loadApplyAudit(admin, userId, proposalId, "retitle_applied");
  const before = detail?.before as RetitleBefore | undefined;
  if (!before) {
    // No recorded before-state means we cannot honestly claim to reverse it.
    return { ok: false, message: "Can't undo — no recorded before-state" };
  }

  const item = await loadItem(admin, userId, itemId);
  if (!item) return { ok: false, message: "Can't undo — the item is gone" };

  const { error } = await admin
    .from("items")
    .update({
      title: before.title,
      type: before.type,
      tags: before.tags ?? [],
      due_at: before.due_at ?? null,
      entities: before.entities ?? [],
    })
    .eq("id", itemId)
    .eq("user_id", userId);
  if (error) return { ok: false, message: `Could not undo: ${error.message}` };

  // The title is part of the embedding basis, so the vector has to go back too.
  await reembed(admin, userId, itemId, before.title ?? "", item.body ?? "", deps);
  await reprojectItemToVault(admin, itemId);
  if (!(await markPendingAgain(admin, userId, proposalId))) {
    return { ok: false, message: "Item restored, but the proposal was already re-decided" };
  }

  await logAudit(admin, {
    user_id: userId,
    item_id: itemId,
    action: "retitle_undone",
    actor: "user",
    detail: { proposal_id: proposalId, restored: before },
  });
  return { ok: true, message: "Undone" };
}

/**
 * Reverse a split: delete the parts it created and un-supersede the original.
 *
 * Deleting is correct here rather than reckless — those rows were created by
 * the very action being undone, seconds earlier, and leaving them would double
 * the memory. The original was only ever archived + superseded, never
 * destroyed, so it comes back intact.
 */
export async function undoSplit(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  itemId: string
): Promise<ApplyResult> {
  const detail = await loadApplyAudit(admin, userId, proposalId, "split_applied");
  const before = detail?.before as { status?: string; title?: string | null } | undefined;
  const parts = Array.isArray(detail?.parts) ? (detail!.parts as string[]) : [];
  if (!before) return { ok: false, message: "Can't undo — no recorded before-state" };

  // Refuse rather than half-undo if the owner has since edited a part: silently
  // deleting work they did after the split would be far worse than no undo.
  if (parts.length) {
    const { data: partRows } = await admin
      .from("items")
      .select("id,vault_path,updated_at,created_at")
      .eq("user_id", userId)
      .in("id", parts);
    const edited = (partRows ?? []).filter(
      (r) => new Date(r.updated_at as string).getTime() - new Date(r.created_at as string).getTime() > 5000
    );
    if (edited.length) {
      return { ok: false, message: "Can't undo — one of the parts has been edited since" };
    }
    for (const r of partRows ?? []) {
      if (r.vault_path) {
        try {
          await deleteVaultNote(r.vault_path as string);
        } catch {
          // vault cleanup is best-effort; the DB is the source of truth
        }
      }
    }
    await admin.from("items").delete().eq("user_id", userId).in("id", parts);
  }

  const { error } = await admin
    .from("items")
    .update({ status: before.status ?? "open", valid_to: null, superseded_by: null })
    .eq("id", itemId)
    .eq("user_id", userId);
  if (error) return { ok: false, message: `Could not restore the original: ${error.message}` };

  await reprojectItemToVault(admin, itemId);
  if (!(await markPendingAgain(admin, userId, proposalId))) {
    return { ok: false, message: "Original restored, but the proposal was already re-decided" };
  }

  await logAudit(admin, {
    user_id: userId,
    item_id: itemId,
    action: "split_undone",
    actor: "user",
    detail: { proposal_id: proposalId, removed_parts: parts },
  });
  return { ok: true, message: `Undone — ${parts.length} part(s) removed` };
}

export async function rejectProposalById(
  admin: SupabaseClient,
  userId: string,
  proposalId: string
): Promise<boolean> {
  const { data: p } = await admin
    .from("proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id, source_item_id")
    .maybeSingle();
  if (p) {
    await logAudit(admin, {
      user_id: userId,
      item_id: p.source_item_id,
      action: "proposal_rejected",
      actor: "user",
      detail: { proposal_id: proposalId },
    });
  }
  return !!p;
}
