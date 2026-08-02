import type { SupabaseClient } from "@supabase/supabase-js";
import { clickupConfigured } from "@/lib/clickup";
import { applyProposal, notifyClickUpProposal, proposeClickUpTaskForItem } from "@/lib/proposals";
import { logAudit } from "@/lib/audit";
import type { ActionItem } from "@/lib/letter";

// Obsidian-X v4.2 workstream B — ClickUp as the TASK PROJECTION of the brain.
//
// The vision's corrected verdict: "ClickUp is David's working task surface...
// It sat empty not from lack of need but because nothing flowed into it — it
// was built ahead of its supply chain." This is the supply chain. Every
// morning, the letter's action items ARE the board.
//
// Trust dial (v1.5's `rules` table, finally used for what it was built for):
//   mode='ask'  (default) — each task becomes a proposal the owner approves
//   mode='auto'           — the task is created immediately
// Starting on 'ask' is the propose-approve law; the owner flips it to 'auto'
// after a clean week, which is exactly the graduated-trust pattern the vision
// describes rather than a permanent tax on every single task.

export const PROJECTION_SOURCE = "brief";
export const PROJECTION_KIND = "clickup_task";

export type ProjectionMode = "ask" | "auto" | "off";

export type ProjectionResult = {
  mode: ProjectionMode;
  considered: number;
  proposed: number;
  created: number;
  skipped: number;
};

/**
 * Read the trust dial. Absent rule = 'ask', which is the safe default: a
 * missing config must never silently escalate to auto-creating things.
 */
export async function projectionMode(
  admin: SupabaseClient,
  userId: string
): Promise<ProjectionMode> {
  const { data } = await admin
    .from("rules")
    .select("mode,enabled")
    .eq("user_id", userId)
    .eq("kind", PROJECTION_KIND)
    .eq("source", PROJECTION_SOURCE)
    .maybeSingle();
  if (!data) return "ask";
  if (data.enabled === false) return "off";
  return data.mode === "auto" ? "auto" : "ask";
}

/**
 * The dial, resolved for ONE task.
 *
 * Owner rule (2026-08-02): "all tasks that are noted as to do with a due date
 * in my brain should automatically exist in clickup." A dated task is a
 * commitment the owner has already made to himself, so asking him to approve
 * it again is asking the same question twice — this is the trust dial the v4.2
 * brief always intended to be flipped, scoped to the class he named.
 *
 * An UNDATED task still follows the dial: "maybe someday" is exactly the kind
 * of item that should not silently populate a kanban board.
 *
 * `off` still wins over everything. It is the kill switch, and a kill switch
 * that a due date can override is not a kill switch.
 */
export function effectiveMode(dial: ProjectionMode, hasDueDate: boolean): ProjectionMode {
  if (dial === "off") return "off";
  return hasDueDate ? "auto" : dial;
}

/** Set the dial (there's no UI yet — scripts/ops or a future settings screen). */
export async function setProjectionMode(
  admin: SupabaseClient,
  userId: string,
  mode: ProjectionMode
): Promise<void> {
  await admin.from("rules").delete().eq("user_id", userId).eq("kind", PROJECTION_KIND).eq("source", PROJECTION_SOURCE);
  await admin.from("rules").insert({
    user_id: userId,
    kind: PROJECTION_KIND,
    source: PROJECTION_SOURCE,
    mode: mode === "off" ? "ask" : mode,
    enabled: mode !== "off",
  });
}

/**
 * Project a freshly-captured task the moment it's created.
 *
 * Without this, a task typed at noon sat in the brain until the next morning's
 * letter — which failed the brief's own exit test ("a task item created via
 * Telegram at noon -> on the ClickUp board same minute"). Inbound email has
 * done capture-time projection since v1.5; every other capture surface was
 * waiting a whole day.
 *
 * Respects the same trust dial, so on 'ask' this raises one approval rather
 * than silently creating tasks. Returns the created/proposed count.
 */
export async function projectNewCaptures(
  admin: SupabaseClient,
  userId: string,
  created: { item: { id: string; type: string } }[],
  source: string
): Promise<{ proposed: number; created: number }> {
  const out = { proposed: 0, created: 0 };
  if (!clickupConfigured()) return out;
  const tasks = created.filter((c) => c.item.type === "task");
  if (!tasks.length) return out;

  const dial = await projectionMode(admin, userId);
  if (dial === "off") return out;

  // The caller only carries id + type, so the due dates come from the rows that
  // were just written. One query, not one per task.
  const { data: dated } = await admin
    .from("items")
    .select("id,due_at")
    .in("id", tasks.map((t) => t.item.id));
  const hasDue = new Set((dated ?? []).filter((r) => r.due_at).map((r) => r.id as string));

  for (const t of tasks) {
    const mode = effectiveMode(dial, hasDue.has(t.item.id));
    const proposal = await proposeClickUpTaskForItem(admin, userId, t.item.id, source);
    if (!proposal) continue;
    out.proposed += 1;
    if (mode === "auto") {
      const applied = await applyProposal(admin, userId, proposal.id);
      if (applied.ok) out.created += 1;
    } else {
      // 'ask' — surface it where the owner already is, one tap to approve.
      await notifyClickUpProposal(proposal);
    }
  }
  return out;
}

/**
 * Push today's action items onto the board.
 *
 * Idempotent by construction: `proposeClickUpTaskForItem` already refuses an
 * item that carries `external.clickup`, and a pending proposal for the same
 * item is skipped here — so running this every morning can't produce duplicate
 * tasks for a multi-day to-do.
 */
/** How many new board proposals one run may ask the owner to approve. */
export const MAX_PROJECTIONS_PER_RUN = 5;

/**
 * Open tasks that belong on the board but would never get there.
 *
 * The letter's ACTION ITEMS section is deliberately "what's due today" — that
 * is what a morning briefing is for. The BOARD is a different question, and
 * conflating them meant a task with a real future deadline never got projected:
 * the Nano Nuclear annual-meeting vote was captured, correctly typed as a task
 * and correctly dated Sept 14, and then sat invisible in the brain because the
 * projection only ever saw today's items (owner, 2026-08-02: "the NNE vote
 * should be a task in my clickup").
 *
 * Soonest deadline first, undated last, and CAPPED per run: the trust dial is
 * 'ask', so every projection costs the owner a Telegram approval. A backlog of
 * open tasks would otherwise arrive as one indiscriminate burst the first time
 * this ran. The cap lets it drain over a few days instead, newest deadlines
 * first, and the caller reports what was left behind rather than hiding it.
 */
export async function loadProjectableTasks(
  admin: SupabaseClient,
  userId: string,
  limit = MAX_PROJECTIONS_PER_RUN
): Promise<{ tasks: ActionItem[]; remaining: number }> {
  const { data } = await admin
    .from("items")
    .select("id,title,due_at,external")
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("type", "task")
    .is("valid_to", null)
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(200);

  const unlinked = (data ?? []).filter(
    (r) => !(r.external as { clickup?: { id?: string } } | null)?.clickup?.id
  );
  const nowMs = Date.now();
  const toAction = (r: Record<string, unknown>): ActionItem => ({
    id: r.id as string,
    title: (r.title as string) ?? "(untitled)",
    due_at: (r.due_at as string) ?? null,
    overdue: r.due_at ? new Date(r.due_at as string).getTime() < nowMs : false,
  });

  // The cap exists to protect the owner's attention, so it only applies to the
  // items that will actually ask for it. A DATED task is auto-created under the
  // owner's rule and costs no approval, so capping those would just delay the
  // board for no benefit — "should automatically exist in clickup" means today,
  // not five a day until the backlog clears.
  const dated = unlinked.filter((r) => r.due_at).map(toAction);
  const undatedAll = unlinked.filter((r) => !r.due_at);
  const undated = undatedAll.slice(0, limit).map(toAction);

  return {
    tasks: [...dated, ...undated],
    remaining: Math.max(0, undatedAll.length - undated.length),
  };
}

export async function projectActionItems(
  admin: SupabaseClient,
  userId: string,
  actions: ActionItem[]
): Promise<ProjectionResult> {
  // Read the dial FIRST. Reporting "off" on the nothing-to-do path would be a
  // false statement about how the system is configured — the kind of small
  // ops-surface lie that later costs an hour of debugging the wrong thing.
  // The dial. The per-item decision is effectiveMode(dial, hasDueDate) below —
  // a dated task ignores 'ask' by owner rule.
  const mode = clickupConfigured() ? await projectionMode(admin, userId) : "off";
  const result: ProjectionResult = {
    mode,
    considered: actions.length,
    proposed: 0,
    created: 0,
    skipped: 0,
  };
  if (mode === "off" || !actions.length) return result;

  const ids = actions.map((a) => a.id);

  // Items already linked, or already awaiting a decision — either way, leave
  // them alone.
  const [{ data: linked }, { data: pending }] = await Promise.all([
    admin.from("items").select("id,external").eq("user_id", userId).in("id", ids),
    admin
      .from("proposals")
      .select("source_item_id")
      .eq("user_id", userId)
      .eq("kind", PROJECTION_KIND)
      .eq("status", "pending")
      .in("source_item_id", ids),
  ]);

  const hasTask = new Set(
    (linked ?? [])
      .filter((r) => (r.external as { clickup?: { id?: string } } | null)?.clickup?.id)
      .map((r) => r.id as string)
  );
  const awaiting = new Set((pending ?? []).map((r) => r.source_item_id as string));

  for (const a of actions) {
    if (hasTask.has(a.id) || awaiting.has(a.id)) {
      result.skipped += 1;
      continue;
    }
    const proposal = await proposeClickUpTaskForItem(admin, userId, a.id, PROJECTION_SOURCE);
    if (!proposal) {
      result.skipped += 1;
      continue;
    }
    result.proposed += 1;

    // Per-item, not per-run: a dated task is created outright under the owner's
    // rule, while an undated one still waits for a tap.
    if (effectiveMode(mode, !!a.due_at) === "auto") {
      const applied = await applyProposal(admin, userId, proposal.id);
      if (applied.ok) result.created += 1;
    } else {
      await notifyClickUpProposal(proposal);
    }
  }

  if (result.proposed > 0) {
    await logAudit(admin, {
      user_id: userId,
      action: "tasks_projected",
      actor: "system",
      detail: { ...result },
    });
  }
  return result;
}
