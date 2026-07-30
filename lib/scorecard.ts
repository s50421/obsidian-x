import type { SupabaseClient } from "@supabase/supabase-js";
import { coverageComplete, loadSourceStatus } from "@/lib/source-status";

// Obsidian-X v4.2 workstream C — the vision's 8 KPIs, made measurable.
//
// The rule that shapes this file: **no fake numbers.** A KPI that can't be
// computed from a real signal reports `measurable: false` and says what it
// would take, rather than showing a plausible-looking figure. A scorecard that
// invents its own numbers is worse than no scorecard — it's the no-half-baked
// law applied to the system's self-assessment.

export type Kpi = {
  n: number;
  name: string;
  target: string;
  /** Null when this KPI has no real signal behind it yet. */
  value: string | null;
  /** ok = meeting target, warn = short of it, unknown = not measurable yet. */
  state: "ok" | "warn" | "unknown";
  note: string;
};

const WEEK_MS = 7 * 24 * 3600 * 1000;

export async function buildScorecard(
  admin: SupabaseClient,
  userId: string,
  now = new Date()
): Promise<Kpi[]> {
  const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();

  const [statusRows, ratings, briefs, projections, corrections, itemsDue] = await Promise.all([
    loadSourceStatus(admin, userId),
    admin
      .from("audit")
      .select("detail,created_at")
      .eq("user_id", userId)
      .eq("action", "letter_rated")
      .gte("created_at", weekAgo),
    admin
      .from("audit")
      .select("created_at")
      .eq("user_id", userId)
      .eq("action", "brief_sent")
      .gte("created_at", weekAgo),
    admin
      .from("audit")
      .select("detail")
      .eq("user_id", userId)
      .eq("action", "tasks_projected")
      .gte("created_at", weekAgo),
    // Every time the owner had to fix the machine's output by hand.
    admin
      .from("audit")
      .select("action")
      .eq("user_id", userId)
      .in("action", ["deck_edit", "retitle_undone", "split_undone", "review_merge", "review_delete"])
      .gte("created_at", weekAgo),
    admin
      .from("items")
      .select("id,external")
      .eq("user_id", userId)
      .eq("type", "task")
      .eq("status", "open")
      .gte("created_at", weekAgo),
  ]);

  const rated = (ratings.data ?? []) as { detail: { rating?: string } | null }[];
  const ups = rated.filter((r) => r.detail?.rating === "up").length;
  const downs = rated.filter((r) => r.detail?.rating === "down").length;
  const sent = (briefs.data ?? []).length;

  const tasks = (itemsDue.data ?? []) as { id: string; external: { clickup?: { id?: string } } | null }[];
  const onBoard = tasks.filter((t) => t.external?.clickup?.id).length;

  const projected = (projections.data ?? []).reduce(
    (a, r) => a + Number((r.detail as { proposed?: number } | null)?.proposed ?? 0),
    0
  );
  const correctionCount = (corrections.data ?? []).length;

  const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 100));

  return [
    {
      n: 1,
      name: "Brief accuracy",
      target: "≥ 9 of 10 mornings with nothing wrong",
      value: rated.length ? `${ups}/${rated.length} rated good` : null,
      state: !rated.length ? "unknown" : ups / rated.length >= 0.9 ? "ok" : "warn",
      note: rated.length
        ? `${downs} flagged as off this week`
        : sent
          ? `${sent} letters sent, none rated yet — tap 👍/👎`
          : "no letters sent this week",
    },
    {
      n: 2,
      name: "No surprises",
      target: "0/week you find something important the brief missed",
      value: null,
      state: "unknown",
      note: "only you can report this — 👎 on a letter is the closest proxy",
    },
    {
      n: 3,
      name: "Coverage",
      target: "100% of declared sources ingested in 24h",
      value: coverageComplete(statusRows, now.getTime()) ? "100%" : "incomplete",
      state: coverageComplete(statusRows, now.getTime()) ? "ok" : "warn",
      note: "live from the coverage panel above",
    },
    {
      n: 4,
      name: "Title quality",
      target: "0 unusable titles in a 20-item sample",
      value: null,
      state: "unknown",
      note: "manual weekly sample — open the deck and judge 20",
    },
    {
      n: 5,
      name: "Go-back rate",
      target: "≤ 1/week you return to the source anyway",
      value: null,
      state: "unknown",
      note: "manual — the anti-'85%' metric, worth tracking honestly",
    },
    {
      n: 6,
      name: "Upkeep",
      target: "< 15 min/week maintaining or correcting",
      value: `${correctionCount} manual corrections`,
      state: correctionCount <= 10 ? "ok" : "warn",
      note: "proxy: edits, undos, merges and deletes you had to make",
    },
    {
      n: 7,
      name: "Voluntary use",
      target: "brief opened daily without forcing",
      value: sent ? `${sent} letters sent, ${rated.length} engaged` : null,
      state: !sent ? "unknown" : rated.length >= sent * 0.7 ? "ok" : "warn",
      note: "a tap on any letter button counts as engagement",
    },
    {
      n: 8,
      name: "Task flow",
      target: "≥ 90% of the day's action items on the board by brief time",
      value: tasks.length ? `${pct(onBoard, tasks.length)}% (${onBoard}/${tasks.length})` : null,
      state: !tasks.length ? "unknown" : (onBoard / tasks.length) >= 0.9 ? "ok" : "warn",
      note: tasks.length ? `${projected} proposed this week` : "no open tasks this week",
    },
  ];
}
