import type { SupabaseClient } from "@supabase/supabase-js";
import { clickupConfigured } from "@/lib/clickup";
import { applyProposal, proposeClickUpTaskForItem } from "@/lib/proposals";
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
 * Push today's action items onto the board.
 *
 * Idempotent by construction: `proposeClickUpTaskForItem` already refuses an
 * item that carries `external.clickup`, and a pending proposal for the same
 * item is skipped here — so running this every morning can't produce duplicate
 * tasks for a multi-day to-do.
 */
export async function projectActionItems(
  admin: SupabaseClient,
  userId: string,
  actions: ActionItem[]
): Promise<ProjectionResult> {
  const result: ProjectionResult = {
    mode: "off",
    considered: actions.length,
    proposed: 0,
    created: 0,
    skipped: 0,
  };
  if (!clickupConfigured() || !actions.length) return result;

  const mode = await projectionMode(admin, userId);
  result.mode = mode;
  if (mode === "off") return result;

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

    if (mode === "auto") {
      const applied = await applyProposal(admin, userId, proposal.id);
      if (applied.ok) result.created += 1;
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
