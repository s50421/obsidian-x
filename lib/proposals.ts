import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage } from "@/lib/telegram";
import { createClickUpTask } from "@/lib/clickup";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { logAudit } from "@/lib/audit";
import { embedText } from "@/lib/embed";
import { writeVaultNote } from "@/lib/vault";
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
