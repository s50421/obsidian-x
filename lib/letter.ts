import type { SupabaseClient } from "@supabase/supabase-js";
import { detectConflicts, type CalConflict, type CalEvent } from "@/lib/calendar";
import { coverageFooter, type SourceStatusRow } from "@/lib/source-status";
import { MIN_CONFIDENCE, SURFACE_THRESHOLD } from "@/lib/rank-mail";
import { localDateStr } from "@/lib/tz";
import { localDayBoundsUtc } from "@/app/deck/day-window";
import type { InlineButton, InlineKeyboard } from "@/lib/telegram";
import type { NewsDigest } from "@/lib/news";
import type { Episode } from "@/lib/podcast";

// Obsidian-X v4.2 — the daily letter.
//
// "The brief IS the product. Everything else exists to make that one message
//  worth reading." (v4-vision.md)
//
// The shape change from v4.1 is the whole point: this is a DECISION QUEUE, not
// a recap. The landscape research was blunt about it — recap briefs get skimmed
// and then ignored, briefs that ask for decisions get used. So every section
// leads with what the owner must DO, and the things that merely happened are
// demoted to one collapsible line at the bottom.
//
// Fixed section order, always the same, and an empty section says so in one
// quiet line rather than vanishing. Predictable structure is what makes it
// scannable in ten minutes — and a section that silently disappears is
// indistinguishable from a section that broke.

/** Plain text only. Dynamic content can't be trusted to be valid Markdown. */
export type Letter = {
  text: string;
  keyboard: InlineKeyboard | undefined;
  localDate: string;
  counts: {
    needsYou: number;
    events: number;
    conflicts: number;
    actions: number;
    worthKnowing: number;
  };
  coverage: string;
  /** Inflow rows surfaced this morning — the caller marks them `surfaced`. */
  surfacedInflowIds: string[];
};

/** The world outside the owner's own inbox. Optional — the letter works without it. */
export type Briefing = {
  digest: NewsDigest | null;
  episode: Episode | null;
  /** Set when the news fetch failed, so the section can say so honestly. */
  error?: string | null;
};

export type InflowRow = {
  id: string;
  subject: string | null;
  sender: string | null;
  snippet: string | null;
  ranked_score: number | null;
  ranked_reason: {
    signals?: string[];
    confidence?: number;
    reason?: string;
    vip?: boolean;
    question?: boolean;
  } | null;
  item_id: string | null;
  account: string | null;
};

export type ActionItem = { id: string; title: string; due_at: string | null; overdue: boolean };

/** Below this a message is "worth knowing" rather than "needs you". */
const WORTH_KNOWING_FLOOR = 30;
const MAX_NEEDS_YOU = 7;
const MAX_WORTH_KNOWING = 3;
const MAX_ACTIONS = 8;

function timeFmt(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
}

/** "Jane Doe <jane@acme.com>" → "Jane Doe" */
export function senderName(s: string | null): string {
  if (!s) return "unknown";
  const stripped = s.replace(/\s*<[^>]+>\s*/, "").replace(/^"|"$/g, "").trim();
  return stripped || s.replace(/[<>]/g, "").trim() || "unknown";
}

/**
 * One short imperative for what this message wants. Derived from the ranker's
 * own signals rather than another model call — the ranking already decided
 * this, and re-asking would risk the letter disagreeing with itself.
 */
export function suggestedAction(r: InflowRow): string {
  const signals = new Set(r.ranked_reason?.signals ?? []);
  if (signals.has("awaiting my reply")) return "reply owed";
  if (signals.has("direct question")) return "answer";
  if (signals.has("deadline")) return "deadline";
  if (signals.has("money/legal")) return "review";
  if (signals.has("VIP sender")) return "read";
  return "review";
}

/** True when a reply is what's actually being asked for. */
export function wantsReply(r: InflowRow): boolean {
  const signals = new Set(r.ranked_reason?.signals ?? []);
  return signals.has("direct question") || signals.has("awaiting my reply");
}

// ---- section builders --------------------------------------------------------

function sectionNeedsYou(rows: InflowRow[]): string {
  if (!rows.length) return "Nothing needs you.";
  return rows
    .map((r) => {
      const who = senderName(r.sender);
      const subject = (r.subject ?? "(no subject)").trim();
      return `• ${who} — ${subject}\n   → ${suggestedAction(r)}`;
    })
    .join("\n");
}

function sectionYourDay(
  events: CalEvent[],
  conflicts: CalConflict[],
  tz: string,
  todayStr: string,
  prep: Map<string, string>
): string {
  if (!events.length) return "Nothing scheduled.";

  const tomorrowStr = localDateStr(tz, new Date(Date.now() + 24 * 3600 * 1000));
  const dayLabel = (d: Date): string => {
    const s = localDateStr(tz, d);
    if (s === todayStr) return "Today";
    if (s === tomorrowStr) return "Tomorrow";
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  };

  const inConflict = new Set<string>();
  for (const c of conflicts) {
    inConflict.add(eventKey(c.a));
    inConflict.add(eventKey(c.b));
  }

  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  const groups: { label: string; items: CalEvent[] }[] = [];
  for (const e of sorted) {
    const label = dayLabel(e.start);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }

  return groups
    .map(
      (g) =>
        `${g.label}\n` +
        g.items
          .map((e) => {
            const when = e.allDay ? "All day" : timeFmt(tz, e.start);
            const clash = inConflict.has(eventKey(e)) ? " ⚠" : "";
            const where = e.location ? ` @ ${e.location}` : "";
            const note = prep.get(eventKey(e));
            return `  ${when} — ${e.summary}${where}${clash}` + (note ? `\n     ↳ ${note}` : "");
          })
          .join("\n")
    )
    .join("\n\n");
}

export function eventKey(e: CalEvent): string {
  return `${e.start.toISOString()}|${e.summary}`;
}

function sectionActions(items: ActionItem[]): string {
  if (!items.length) return "Nothing due.";
  return items
    .map((a) => `• ${a.overdue ? "OVERDUE — " : ""}${a.title}`)
    .join("\n");
}

function sectionWorthKnowing(rows: InflowRow[]): string {
  if (!rows.length) return "Nothing else of note.";
  return rows.map((r) => `• ${senderName(r.sender)} — ${(r.subject ?? "(no subject)").trim()}`).join("\n");
}

/**
 * The world section. Deliberately last before the footer: it is the only part
 * of the letter that asks nothing of the owner, so it must never push a
 * decision below the fold.
 *
 * A failed fetch SAYS so rather than disappearing — an absent section and a
 * broken one look identical otherwise, which is the same trap the coverage
 * footer exists to avoid.
 */
function sectionBriefing(b: Briefing | undefined): string {
  if (!b) return "";
  const lines: string[] = [];

  if (b.digest) {
    if (b.digest.markets) lines.push(`Markets — ${b.digest.markets}`);
    if (b.digest.geopolitics) lines.push(`World — ${b.digest.geopolitics}`);
    if (b.digest.tech) lines.push(`Tech — ${b.digest.tech}`);
    for (const s of b.digest.smalltalk) lines.push(`• ${s}`);
    // Plain text, not Markdown — the letter is sent with parse_mode "plain"
    // (dynamic content can't be trusted to be valid Markdown), so underscores
    // would render literally.
    if (b.digest.sources.length) lines.push(`via ${b.digest.sources.join(" · ")}`);
  } else {
    lines.push(`Couldn't fetch the news this morning${b.error ? ` (${b.error})` : ""}.`);
  }

  if (b.episode) {
    const mins = b.episode.durationMin ? ` · ${b.episode.durationMin} min` : "";
    lines.push(`🎧 Morning Brew Daily: ${b.episode.title}${mins}`);
  }

  return lines.join("\n");
}

// ---- assembly ------------------------------------------------------------------

export type ComposeInput = {
  tz: string;
  now: Date;
  events: CalEvent[];
  statusRows: SourceStatusRow[];
  inflow: InflowRow[];
  actions: ActionItem[];
  /** eventKey -> one-line prep note from the brain. */
  prep?: Map<string, string>;
  /** Inflow ids that already have a draft waiting (button says "ready"). */
  draftedInflowIds?: Set<string>;
  /** News + podcast. Omit entirely to leave the section out. */
  briefing?: Briefing;
};

/**
 * Pure composition — no I/O, so the exact letter the owner will receive can be
 * asserted in tests and previewed without sending anything.
 */
export function composeLetter(input: ComposeInput): Letter {
  const { tz, now, events, statusRows, inflow, actions } = input;
  const prep = input.prep ?? new Map<string, string>();
  const drafted = input.draftedInflowIds ?? new Set<string>();

  const todayStr = localDateStr(tz, now);
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);

  // Only confident, high-scoring mail can demand attention. A low-confidence
  // read is withheld entirely (it goes to /ops for tuning) — the no-half-baked
  // law: a half-right "needs you" line is worse than no line.
  const confident = inflow.filter(
    (r) => Number(r.ranked_reason?.confidence ?? 0) >= MIN_CONFIDENCE
  );
  const needsYou = confident
    .filter((r) => (r.ranked_score ?? 0) >= SURFACE_THRESHOLD)
    .slice(0, MAX_NEEDS_YOU);
  const needsYouIds = new Set(needsYou.map((r) => r.id));
  const worthKnowing = confident
    .filter(
      (r) =>
        !needsYouIds.has(r.id) &&
        (r.ranked_score ?? 0) >= WORTH_KNOWING_FLOOR &&
        (r.ranked_score ?? 0) < SURFACE_THRESHOLD
    )
    .slice(0, MAX_WORTH_KNOWING);

  const conflicts = detectConflicts(events);
  const shownActions = actions.slice(0, MAX_ACTIONS);

  const parts: string[] = [
    `☀️ ${dateStr}`,
    "",
    `NEEDS YOU (${needsYou.length})`,
    sectionNeedsYou(needsYou),
    "",
    `YOUR DAY (${events.length}${conflicts.length ? `, ${conflicts.length} overlap` : ""})`,
    sectionYourDay(events, conflicts, tz, todayStr, prep),
    "",
    `ACTION ITEMS (${actions.length})`,
    sectionActions(shownActions),
  ];

  if (actions.length > shownActions.length) {
    parts.push(`  …and ${actions.length - shownActions.length} more on the board.`);
  }

  parts.push("", `WORTH KNOWING (${worthKnowing.length})`, sectionWorthKnowing(worthKnowing));

  const briefingText = sectionBriefing(input.briefing);
  if (briefingText) parts.push("", "BRIEFING", briefingText);

  parts.push("", "— — —", `Coverage: ${coverageFooter(statusRows, now.getTime())}`);

  // ---- buttons: every decision is one tap ----
  const rows: InlineButton[][] = [];

  for (const r of needsYou.slice(0, 5)) {
    const label = senderName(r.sender).slice(0, 18);
    const row: InlineButton[] = [];
    if (wantsReply(r)) {
      row.push({
        text: `${drafted.has(r.id) ? "📝" : "✍️"} Draft · ${label}`,
        callback_data: `mdraft:${r.id}`,
      });
    }
    row.push({ text: "✓ Handled", callback_data: `mdone:${r.id}` });
    rows.push(row);
  }

  for (const a of shownActions.slice(0, 6)) {
    rows.push([{ text: `✓ ${a.title.slice(0, 40)}`, callback_data: `done:${a.id}` }]);
  }

  // The episode goes behind a button so the tracking URL never shows.
  const audio = input.briefing?.episode?.audioUrl;
  if (audio) rows.push([{ text: "🎧 Play Morning Brew", url: audio }]);

  // Scorecard instrumentation (workstream C) — one tap, every morning. This is
  // the only source for KPI #1 (brief accuracy) that isn't guesswork.
  rows.push([
    { text: "👍 Good letter", callback_data: `lrate:up:${todayStr}` },
    { text: "👎 Something's off", callback_data: `lrate:down:${todayStr}` },
  ]);

  return {
    text: parts.join("\n"),
    keyboard: rows.length ? { inline_keyboard: rows } : undefined,
    localDate: todayStr,
    counts: {
      needsYou: needsYou.length,
      events: events.length,
      conflicts: conflicts.length,
      actions: actions.length,
      worthKnowing: worthKnowing.length,
    },
    coverage: coverageFooter(statusRows, now.getTime()),
    surfacedInflowIds: [...needsYou, ...worthKnowing].map((r) => r.id),
  };
}

// ---- data loading ----------------------------------------------------------------

/** Overnight inflow worth considering, best first. */
export async function loadInflow(
  admin: SupabaseClient,
  userId: string,
  since: Date
): Promise<InflowRow[]> {
  const { data } = await admin
    .from("inflow_events")
    .select("id,subject,sender,snippet,ranked_score,ranked_reason,item_id,account")
    .eq("user_id", userId)
    .in("state", ["new", "surfaced"])
    .gte("ts", since.toISOString())
    .gte("ranked_score", WORTH_KNOWING_FLOOR)
    .order("ranked_score", { ascending: false })
    .limit(40);
  return (data ?? []) as InflowRow[];
}

/**
 * Today's action items: open tasks due by end of the owner's local day, plus
 * anything already overdue. Overdue first — a missed deadline outranks a
 * scheduled one.
 */
export async function loadActionItems(
  admin: SupabaseClient,
  userId: string,
  tz: string,
  now: Date
): Promise<ActionItem[]> {
  const todayStr = localDateStr(tz, now);
  const { end } = localDayBoundsUtc(tz, todayStr);
  const { data } = await admin
    .from("items")
    .select("id,title,due_at")
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .not("due_at", "is", null)
    .lt("due_at", end)
    .order("due_at", { ascending: true })
    .limit(40);

  const nowMs = now.getTime();
  return (data ?? []).map((r) => ({
    id: r.id as string,
    title: (r.title as string) ?? "(untitled)",
    due_at: (r.due_at as string) ?? null,
    overdue: r.due_at ? new Date(r.due_at as string).getTime() < nowMs : false,
  }));
}
