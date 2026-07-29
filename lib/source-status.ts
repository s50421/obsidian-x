import type { SupabaseClient } from "@supabase/supabase-js";

// Obsidian-X v4.1 — the trust surface behind the completeness law.
//
// "A channel is either fully in or explicitly out. The brief always declares
//  its own coverage." (v4-vision.md)
//
// Every sync job reports here. The /ops coverage panel and the morning brief's
// coverage footer read straight off `source_status`, which is why a source that
// breaks shows ⚠ instead of quietly disappearing from the brief — the failure
// mode the completeness law exists to prevent.

export type SourceScope = "declared" | "out";

export type SourceStatusRow = {
  source: string;
  channel: string;
  label: string | null;
  scope: SourceScope;
  connected: boolean;
  last_sync: string | null;
  last_ok: string | null;
  events_24h: number;
  last_error: string | null;
  detail: Record<string, unknown>;
};

/** How stale a declared source may be before the panel/footer flags it. */
export const STALE_AFTER_MS = 24 * 3600 * 1000;

/**
 * The declared source registry — the single place that answers "what is this
 * system claiming to see?". Sources marked `out` are rendered explicitly as
 * not-connected rather than omitted, per the completeness law.
 *
 * `channel` rows (individual mailboxes, individual calendars) are created at
 * sync time; these are the parent rows.
 */
/**
 * `pull` — we control the cadence (we fetch it). If we haven't successfully
 *          synced in 24h, the source is genuinely broken → ⚠.
 * `push`  — it arrives when it arrives (a webhook, an agent posting in). Silence
 *          is not failure: a quiet Tuesday on Telegram must not raise a false
 *          alarm, or the ⚠ stops meaning anything. These are healthy while
 *          connected and error-free, and are health-checked directly where a
 *          probe exists (Telegram's getWebhookInfo).
 */
export type SourceKind = "pull" | "push";

export const DECLARED_SOURCES: {
  source: string;
  label: string;
  scope: SourceScope;
  kind: SourceKind;
  note?: string;
}[] = [
  { source: "gmail", label: "Gmail", scope: "declared", kind: "pull" },
  { source: "calendar", label: "Calendars", scope: "declared", kind: "pull" },
  { source: "telegram", label: "Telegram", scope: "declared", kind: "push" },
  { source: "granola", label: "Granola", scope: "declared", kind: "pull" },
  { source: "email", label: "Forward-to-brain", scope: "declared", kind: "push" },
  {
    source: "imessage",
    label: "iMessage",
    scope: "out",
    kind: "push",
    note: "phase 2 — local Mac agent",
  },
  {
    source: "whatsapp",
    label: "WhatsApp",
    scope: "out",
    kind: "push",
    note: "phase 2 — no acceptable path",
  },
  { source: "drive", label: "Google Drive", scope: "out", kind: "pull", note: "phase 2" },
];

const KIND_OF = new Map(DECLARED_SOURCES.map((s) => [s.source, s.kind]));

export function kindOf(source: string): SourceKind {
  return KIND_OF.get(source) ?? "pull";
}

export type SourceHealth = "ok" | "stale" | "error" | "disconnected" | "out";

/** One rule for "is this source healthy", shared by /ops and the brief footer. */
export function healthOf(row: SourceStatusRow, now = Date.now()): SourceHealth {
  if (row.scope === "out") return "out";
  if (!row.connected) return "disconnected";
  if (row.last_error) return "error";
  // Granola is scheduled (an agent posts daily), so silence IS failure — the
  // agent heartbeats even on a day with no meetings. Push sources don't.
  if (kindOf(row.source) === "push") return "ok";
  if (!row.last_ok) return "stale";
  if (now - new Date(row.last_ok).getTime() > STALE_AFTER_MS) return "stale";
  return "ok";
}

export const HEALTH_GLYPH: Record<SourceHealth, string> = {
  ok: "✓",
  stale: "⚠",
  error: "⚠",
  disconnected: "✗",
  out: "✗",
};

/**
 * Record the outcome of a sync. Never throws — a status-write failure must not
 * fail the sync itself, exactly like `logAudit`.
 *
 * A successful sync clears `last_error` and advances `last_ok`; a failed one
 * advances `last_sync` but leaves `last_ok` where it was, so staleness keeps
 * accumulating and the ⚠ eventually fires even if the job keeps "running".
 */
export async function reportSourceStatus(
  admin: SupabaseClient,
  userId: string,
  p: {
    source: string;
    channel?: string;
    label?: string;
    scope?: SourceScope;
    connected?: boolean;
    events24h?: number;
    error?: string | null;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const ok = !p.error;
    const row: Record<string, unknown> = {
      user_id: userId,
      source: p.source,
      channel: p.channel ?? "",
      scope: p.scope ?? "declared",
      last_sync: nowIso,
      last_error: p.error ?? null,
    };
    if (p.label !== undefined) row.label = p.label;
    if (p.connected !== undefined) row.connected = p.connected;
    if (p.events24h !== undefined) row.events_24h = p.events24h;
    if (p.detail !== undefined) row.detail = p.detail;
    if (ok) row.last_ok = nowIso;

    await admin.from("source_status").upsert(row, { onConflict: "user_id,source,channel" });
  } catch {
    // swallow — coverage bookkeeping must never break a sync
  }
}

/**
 * Seed the declared registry so the panel shows every in-scope source from the
 * very first render, including ones that have never synced (they read as
 * "not connected" rather than being absent). Idempotent, and deliberately
 * non-destructive: it only inserts rows that don't exist yet.
 */
export async function ensureDeclaredSources(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    const { data: existing } = await admin
      .from("source_status")
      .select("source,channel")
      .eq("user_id", userId)
      .eq("channel", "");
    const have = new Set((existing ?? []).map((r) => r.source as string));
    const missing = DECLARED_SOURCES.filter((s) => !have.has(s.source)).map((s) => ({
      user_id: userId,
      source: s.source,
      channel: "",
      label: s.label,
      scope: s.scope,
      connected: false,
      detail: { kind: s.kind, ...(s.note ? { note: s.note } : {}) },
    }));
    if (missing.length) await admin.from("source_status").insert(missing);
  } catch {
    // swallow
  }
}

/** All status rows for the owner, declared registry order first. */
export async function loadSourceStatus(
  admin: SupabaseClient,
  userId: string
): Promise<SourceStatusRow[]> {
  const { data } = await admin
    .from("source_status")
    .select("source,channel,label,scope,connected,last_sync,last_ok,events_24h,last_error,detail")
    .eq("user_id", userId);
  const rows = (data ?? []) as SourceStatusRow[];
  const order = new Map(DECLARED_SOURCES.map((s, i) => [s.source, i]));
  return rows.sort((a, b) => {
    const oa = order.get(a.source) ?? 99;
    const ob = order.get(b.source) ?? 99;
    if (oa !== ob) return oa - ob;
    return a.channel.localeCompare(b.channel);
  });
}

/**
 * Count inflow events per source in the trailing 24h. Used both to refresh
 * `events_24h` and to render the footer counts.
 */
export async function countInflow24h(
  admin: SupabaseClient,
  userId: string
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data } = await admin
    .from("inflow_events")
    .select("source")
    .eq("user_id", userId)
    .gte("ts", since);
  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.source as string] = (out[r.source as string] ?? 0) + 1;
  return out;
}

/**
 * The brief's coverage footer — one line, every declared source, never silent.
 * e.g. "Gmail ✓ 47 · Calendars ✓ 20/20 · Telegram ✓ · Granola ✓ 2 · iMessage ✗"
 */
export function coverageFooter(rows: SourceStatusRow[], now = Date.now()): string {
  const parents = rows.filter((r) => r.channel === "");
  const parts = parents.map((r) => {
    const health = healthOf(r, now);
    const glyph = HEALTH_GLYPH[health];
    const label = r.label ?? r.source;

    // Calendars report as a fraction (20/20) — "some of my calendars synced" is
    // exactly the half-coverage the law forbids being hidden.
    if (r.source === "calendar") {
      const total = Number(r.detail?.total ?? 0);
      const okCount = Number(r.detail?.ok ?? 0);
      if (total) return `${label} ${glyph} ${okCount}/${total}`;
    }
    if (health === "out" || health === "disconnected") return `${label} ${glyph}`;
    return r.events_24h > 0 ? `${label} ${glyph} ${r.events_24h}` : `${label} ${glyph}`;
  });
  return parts.join(" · ");
}

/** True when every declared source is healthy — KPI #3 ("coverage 100%"). */
export function coverageComplete(rows: SourceStatusRow[], now = Date.now()): boolean {
  return rows
    .filter((r) => r.channel === "" && r.scope === "declared")
    .every((r) => healthOf(r, now) === "ok");
}
