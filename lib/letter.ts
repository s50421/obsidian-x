import type { SupabaseClient } from "@supabase/supabase-js";
import { detectConflicts, type CalConflict, type CalEvent } from "@/lib/calendar";
import { coverageFooter, type SourceStatusRow } from "@/lib/source-status";
import { MENTION_THRESHOLD, MIN_CONFIDENCE, SURFACE_THRESHOLD } from "@/lib/rank-mail";
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
  /**
   * Where the message ended up, when the system filed it itself.
   *
   * "board" is only claimed when a ClickUp reference actually exists on the
   * item — an auto-created `reference` (a security alert, say) is filed in the
   * brain and never reaches a kanban board, and saying otherwise would be a
   * line the owner has to go and check. Populated by loadInflow; composeLetter
   * stays pure.
   */
  filed?: { where: "board" | "brain"; type: string };
};

export type ActionItem = { id: string; title: string; due_at: string | null; overdue: boolean };

/** Below this a message is "worth knowing" rather than "needs you". */
/** Shared with the ranker, which needs it to guarantee a VIP a mention. */
const WORTH_KNOWING_FLOOR = MENTION_THRESHOLD;
const MAX_NEEDS_YOU = 7;
const MAX_WORTH_KNOWING = 3;
const MAX_ACTIONS = 8;
/** How many messages one sender may contribute to NEEDS YOU. */
const MAX_PER_SENDER = 2;

/**
 * Collapse near-identical messages.
 *
 * On 2026-07-31 the same f-bb.de acknowledgement appeared twice in WORTH
 * KNOWING with the same sender and subject, and Canvas sends batches whose
 * subjects differ only by a trailing course-code repeat. Matching on the exact
 * string misses all of that, so the key is normalised: reply/forward prefixes
 * stripped, punctuation and case flattened, and only the first ~50 characters
 * compared — which is what makes "same thing, again" collapse.
 *
 * The highest-ranked copy survives; `dupes` counts what it stands for so the
 * line can say "(x3)" rather than silently hiding mail.
 */
export function dedupeInflow(rows: InflowRow[]): (InflowRow & { dupes: number })[] {
  const byKey = new Map<string, InflowRow & { dupes: number }>();
  const order: string[] = [];

  for (const r of rows) {
    const subject = (r.subject ?? "")
      .replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/gi, "") // Re:/Fwd:/AW:/WG: chains
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);
    const key = `${senderKey(r.sender)}|${subject}`;

    const seen = byKey.get(key);
    if (seen) {
      seen.dupes += 1;
      // Keep the best-scoring copy's own fields.
      if ((r.ranked_score ?? 0) > (seen.ranked_score ?? 0)) {
        byKey.set(key, { ...r, dupes: seen.dupes });
      }
      continue;
    }
    byKey.set(key, { ...r, dupes: 1 });
    order.push(key);
  }
  return order.map((k) => byKey.get(k)!);
}

/** Keep the top `n` per sender, preserving overall rank order. */
export function capPerSender(rows: InflowRow[], n: number): InflowRow[] {
  const seen = new Map<string, number>();
  const out: InflowRow[] = [];
  for (const r of rows) {
    const key = senderKey(r.sender);
    const count = seen.get(key) ?? 0;
    if (count >= n) continue;
    seen.set(key, count + 1);
    out.push(r);
  }
  return out;
}

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
 * Who this is really from, for grouping. The ADDRESS, not the display name.
 *
 * This distinction is the whole reason the per-sender cap failed on 2026-08-01.
 * Canvas sends every course from notifications@instructure.com but rewrites the
 * display name per course — "UBC Canvas", "MGMT_O 599A COMM_O 399A 101 2026SS
 * AI for Business" — so a cap keyed on the display name saw three different
 * senders and let all three into NEEDS YOU, which is precisely what the cap had
 * been added to prevent the day before.
 */
export function senderKey(s: string | null): string {
  const m = (s ?? "").match(/<([^>]+)>/);
  if (m?.[1]) return m[1].trim().toLowerCase();
  const bare = (s ?? "").trim();
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) return bare.toLowerCase();
  return senderName(s).toLowerCase();
}

/**
 * One short imperative for what this message wants. Derived from the ranker's
 * own signals rather than another model call — the ranking already decided
 * this, and re-asking would risk the letter disagreeing with itself.
 */
export function suggestedAction(r: InflowRow): string {
  // Mail that already cleared the auto-create bar has been turned into a task.
  // Saying so is the point: until 2026-08-02 that mail was EXCLUDED from the
  // letter entirely (auto-create flips inflow state to 'actioned', and the
  // letter only loaded 'new'/'surfaced'), so the messages that cleared the
  // STRICTEST bar were the ones most likely to go unmentioned. A shareholder
  // vote with a real September deadline was found, ranked, filed as a task —
  // and never once appeared in a letter. That is the no-surprises rule failing
  // at its most expensive point.
  //
  // The distinction is checked, not assumed: item_id means the message became
  // an item in the brain, which is NOT the same claim as "it is on your board".
  // Only task-type items carry a ClickUp reference, so the Crypto.com passkey
  // alert — filed as a `reference` — would otherwise have been described as
  // sitting on a kanban board it never reached. A letter that overstates by one
  // word is a letter that has to be checked, which is the whole thing this
  // product exists to avoid.
  // Say WHAT it was classified as and WHERE it went. "already filed" on its own
  // was opaque (owner, 2026-08-02: "I dont know what already filed means, make
  // it clear where it was clasified as what") — and vagueness here is expensive,
  // because this line is the only notice that the system acted on your behalf.
  if (r.filed) {
    const place = r.filed.where === "board" ? "on your ClickUp board" : "in the brain";
    return `filed as ${r.filed.type} · ${place}`;
  }
  if (r.item_id) return "filed in the brain";
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

/** Mail subjects can be enormous — one Canvas notification repeated its full
 *  course code twice and ran past 200 characters, which is unreadable on a
 *  phone. Keep the informative head, drop the rest. */
const SUBJECT_MAX = 78;

export function tidySubject(subject: string | null): string {
  const s = (subject ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "(no subject)";
  if (s.length <= SUBJECT_MAX) return s;
  // Cut on a word boundary so it doesn't end mid-token.
  const cut = s.slice(0, SUBJECT_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function dupeSuffix(r: InflowRow & { dupes?: number }): string {
  return (r.dupes ?? 1) > 1 ? ` (x${r.dupes})` : "";
}

function sectionNeedsYou(rows: (InflowRow & { dupes?: number })[]): string {
  if (!rows.length) return "Nothing needs you.";
  return rows
    .map(
      (r) =>
        `• ${senderName(r.sender)} — ${tidySubject(r.subject)}${dupeSuffix(r)}\n   → ${suggestedAction(r)}`
    )
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

function sectionWorthKnowing(rows: (InflowRow & { dupes?: number })[]): string {
  if (!rows.length) return "Nothing else of note.";
  return rows
    .map((r) => `• ${senderName(r.sender)} — ${tidySubject(r.subject)}${dupeSuffix(r)}`)
    .join("\n");
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
    // Things worth KNOWING, kept visually distinct from things that HAPPENED.
    // Owner ask: material that makes him sound informed rather than merely
    // current — merging the two just produced more headlines.
    if (b.digest.knowledge?.length) {
      lines.push("");
      lines.push("Worth knowing about:");
      for (const k of b.digest.knowledge) lines.push(`◦ ${k}`);
    }
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

  if (b.digest) {
    lines.push("");
    lines.push("Ask me about any of these — just reply, e.g. \"tell me more about the oil story\".");
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
  // Dedupe FIRST, so a repeated message can't consume a slot in either section
  // and can't be counted twice.
  const confident = dedupeInflow(
    inflow.filter((r) => Number(r.ranked_reason?.confidence ?? 0) >= MIN_CONFIDENCE)
  );
  // One noisy sender must not eat the whole section. On 2026-08-01 all three
  // NEEDS YOU slots were near-identical Canvas notifications, which is what a
  // VIP floor does to an automated sender — the owner asked for those to always
  // surface, so the fix is to show one and count the rest, not to drop them.
  const needsYou = capPerSender(
    confident.filter((r) => (r.ranked_score ?? 0) >= SURFACE_THRESHOLD),
    MAX_PER_SENDER
  ).slice(0, MAX_NEEDS_YOU);
  const needsYouIds = new Set(needsYou.map((r) => r.id));
  // The same per-sender cap applies here. Demoting a noisy automated sender out
  // of NEEDS YOU only moves the problem if it can then fill WORTH KNOWING
  // instead — which is exactly what Canvas did once its VIP floor was relaxed.
  const worthKnowing = capPerSender(
    confident.filter(
      (r) =>
        !needsYouIds.has(r.id) &&
        (r.ranked_score ?? 0) >= WORTH_KNOWING_FLOOR &&
        (r.ranked_score ?? 0) < SURFACE_THRESHOLD
    ),
    MAX_PER_SENDER
  ).slice(0, MAX_WORTH_KNOWING);

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
    // Labelled, because three bare "✓ Handled" rows are indistinguishable —
    // exactly what the 2026-08-02 letter looked like on the phone.
    row.push({ text: `✓ ${label}`, callback_data: `mdone:${r.id}` });
    rows.push(row);
  }

  for (const a of shownActions.slice(0, 6)) {
    rows.push([{ text: `✓ ${a.title.slice(0, 40)}`, callback_data: `done:${a.id}` }]);
  }

  // v4.2.2 — the episode goes behind a button so the tracking URL never shows.
  //
  // TWO buttons, because they do different jobs (owner, 2026-08-02: "the morning
  // brew letter should be a link to the podcast"). The enclosure URL is a raw
  // megaphone tracking .mp3, so tapping it hands you a bare audio file rather
  // than a podcast. Megaphone's feed carries no per-episode <link>, so the show
  // page is the closest thing to "the podcast" that actually exists — it opens
  // properly and hands off to a podcast app.
  const ep = input.briefing?.episode;
  if (ep) {
    const podRow: InlineButton[] = [];
    if (ep.audioUrl) podRow.push({ text: "🎧 Play episode", url: ep.audioUrl });
    if (ep.showUrl) podRow.push({ text: "Morning Brew ↗", url: ep.showUrl });
    if (podRow.length) rows.push(podRow);
  }

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
    // 'actioned' is included on purpose: it is the state auto-create sets, and
    // that mail still has to be reported (see suggestedAction). What must NOT
    // come back is mail the OWNER dealt with — that is 'dismissed', which is
    // what the letter's "✓ Handled" button now writes.
    .in("state", ["new", "surfaced", "actioned"])
    .gte("ts", since.toISOString())
    .gte("ranked_score", WORTH_KNOWING_FLOOR)
    .order("ranked_score", { ascending: false })
    .limit(40);

  const rows = (data ?? []) as InflowRow[];

  // Resolve what actually happened to the mail the system filed itself. One
  // query for the whole letter, not one per row.
  const itemIds = rows.map((r) => r.item_id).filter((id): id is string => !!id);
  if (itemIds.length) {
    const { data: items } = await admin
      .from("items")
      .select("id,external,type")
      .in("id", itemIds);
    const filedAs = new Map<string, { where: "board" | "brain"; type: string }>();
    for (const it of items ?? []) {
      const ext = (it.external ?? {}) as { clickup?: { id?: string } };
      filedAs.set(it.id as string, {
        where: ext.clickup?.id ? "board" : "brain",
        type: (it.type as string) ?? "note",
      });
    }
    for (const r of rows) {
      if (!r.item_id) continue;
      const f = filedAs.get(r.item_id);
      if (f) r.filed = f;
    }
  }
  return rows;
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
  // type='task' ONLY. Anything with a due date used to qualify, so a dated
  // EVENT ("Sandrine French pastry — weekend visit with Anna") was listed as an
  // OVERDUE action item. An event you attend is not a task you failed to do.
  const { data } = await admin
    .from("items")
    .select("id,title,due_at")
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("type", "task")
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
