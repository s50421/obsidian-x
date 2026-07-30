// Obsidian-X v4.2 — the letter composer's contract, plus a printable sample.
//
//   node --experimental-strip-types --no-warnings scripts/test-letter.mjs
//   node --experimental-strip-types --no-warnings scripts/test-letter.mjs --sample
//
// composeLetter is deliberately PURE — no I/O — so the exact message the owner
// will receive can be asserted here and previewed without touching Telegram,
// the database, or a model. The section order and the "empty sections still
// appear" rule are contract, not style: a section that silently vanishes is
// indistinguishable from a section that broke, and the letter's whole value is
// that it can be trusted at a glance.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { composeLetter, senderName, suggestedAction, wantsReply } = await import("../lib/letter.ts");

const TZ = "America/Vancouver";
// Fixed instant so the rendered sample is byte-stable: 2026-07-29 06:30 local.
const NOW = new Date("2026-07-29T13:30:00.000Z");

const ev = (h, m, summary, opts = {}) => {
  const start = new Date(Date.UTC(2026, 6, 29, h, m));
  return {
    calendar: opts.calendar ?? "Work",
    summary,
    start,
    end: opts.end ?? new Date(start.getTime() + (opts.mins ?? 60) * 60000),
    location: opts.location ?? null,
    allDay: opts.allDay ?? false,
  };
};

const mail = (o) => ({
  id: o.id,
  subject: o.subject,
  sender: o.sender,
  snippet: o.snippet ?? "",
  ranked_score: o.score,
  ranked_reason: { signals: o.signals ?? [], confidence: o.confidence ?? 0.9 },
  item_id: null,
  account: "david@manhartgroup.com",
});

const STATUS = [
  { source: "gmail", channel: "", label: "Gmail", scope: "declared", connected: true,
    last_sync: NOW.toISOString(), last_ok: NOW.toISOString(), events_24h: 47, last_error: null, detail: {} },
  { source: "calendar", channel: "", label: "Calendars", scope: "declared", connected: true,
    last_sync: NOW.toISOString(), last_ok: NOW.toISOString(), events_24h: 3, last_error: null,
    detail: { total: 20, ok: 20 } },
  { source: "telegram", channel: "", label: "Telegram", scope: "declared", connected: true,
    last_sync: NOW.toISOString(), last_ok: NOW.toISOString(), events_24h: 0, last_error: null, detail: {} },
  { source: "imessage", channel: "", label: "iMessage", scope: "out", connected: false,
    last_sync: null, last_ok: null, events_24h: 0, last_error: null, detail: {} },
];

const FULL = {
  tz: TZ,
  now: NOW,
  events: [
    ev(16, 0, "V-Bank weekly", { calendar: "Meetings" }),
    ev(17, 30, "Dani — quarterly review", { location: "Zoom", mins: 60 }),
    ev(18, 0, "Dentist", { location: "Dr. Reyes", mins: 45 }),
  ],
  statusRows: STATUS,
  inflow: [
    mail({ id: "i1", sender: "Beate Manhart <beate@example.com>", subject: "Father's lawsuit — need your signature by Friday",
      score: 92, signals: ["VIP sender", "direct to me", "deadline", "money/legal"] }),
    mail({ id: "i2", sender: "Dani <dani@vbank.example>", subject: "Re: Q3 numbers — can you confirm?",
      score: 78, signals: ["VIP sender", "direct to me", "awaiting my reply", "direct question"] }),
    mail({ id: "i3", sender: "Canvas <notifications@instructure.com>", subject: "MGMT_O 599: Problem Set 4 due Sunday",
      score: 61, signals: ["VIP sender", "deadline", "bulk"] }),
    mail({ id: "i4", sender: "Stripe <no-reply@stripe.com>", subject: "Your July invoice is available",
      score: 38, signals: ["bulk"], confidence: 0.95 }),
    mail({ id: "i5", sender: "Some Newsletter <news@shop.example>", subject: "🔥 FINAL HOURS",
      score: 12, signals: ["bulk", "promotions"] }),
    // Scored high but the model wasn't sure — must be WITHHELD entirely.
    mail({ id: "i6", sender: "Unknown <x@y.example>", subject: "urgent???",
      score: 88, signals: ["direct to me"], confidence: 0.2 }),
  ],
  actions: [
    { id: "a1", title: "Send Marcus the roof repair quote", due_at: "2026-07-28T17:00:00Z", overdue: true },
    { id: "a2", title: "Pay the V-Bank invoice", due_at: "2026-07-29T23:00:00Z", overdue: false },
  ],
  prep: new Map([[`${new Date(Date.UTC(2026, 6, 29, 17, 30)).toISOString()}|Dani — quarterly review`,
    "you have notes: Dani works at V-Bank via Manhart"]]),
  draftedInflowIds: new Set(["i2"]),
};

// ---------------------------------------------------------------------------

test("sender names are cleaned of angle-bracket addresses", () => {
  assert.equal(senderName("Beate Manhart <beate@example.com>"), "Beate Manhart");
  assert.equal(senderName("<solo@example.com>"), "solo@example.com");
  assert.equal(senderName(null), "unknown");
});

test("the suggested action comes from the ranker's own signals", () => {
  assert.equal(suggestedAction({ ranked_reason: { signals: ["awaiting my reply"] } }), "reply owed");
  assert.equal(suggestedAction({ ranked_reason: { signals: ["direct question"] } }), "answer");
  assert.equal(suggestedAction({ ranked_reason: { signals: ["deadline"] } }), "deadline");
  assert.equal(suggestedAction({ ranked_reason: { signals: ["money/legal"] } }), "review");
  assert.equal(suggestedAction({ ranked_reason: { signals: [] } }), "review");
});

test("only genuine reply-wanting mail offers a draft", () => {
  assert.equal(wantsReply({ ranked_reason: { signals: ["direct question"] } }), true);
  assert.equal(wantsReply({ ranked_reason: { signals: ["awaiting my reply"] } }), true);
  assert.equal(wantsReply({ ranked_reason: { signals: ["deadline"] } }), false);
});

test("sections appear in the fixed order, always", () => {
  const t = composeLetter(FULL).text;
  const order = ["NEEDS YOU", "YOUR DAY", "ACTION ITEMS", "WORTH KNOWING", "Coverage:"];
  let at = -1;
  for (const s of order) {
    const i = t.indexOf(s);
    assert.ok(i > at, `${s} must come after the previous section`);
    at = i;
  }
});

test("an EMPTY letter still shows every section — silence must be explicit", () => {
  const empty = composeLetter({
    tz: TZ, now: NOW, events: [], statusRows: STATUS, inflow: [], actions: [],
  });
  const t = empty.text;
  for (const s of ["NEEDS YOU (0)", "YOUR DAY (0)", "ACTION ITEMS (0)", "WORTH KNOWING (0)"]) {
    assert.ok(t.includes(s), `missing ${s}`);
  }
  assert.ok(t.includes("Nothing needs you."));
  assert.ok(t.includes("Nothing scheduled."));
  assert.ok(t.includes("Nothing due."));
  // A letter with no content still gets a rating row — KPI #1 needs every day.
  assert.equal(empty.keyboard.inline_keyboard.length, 1);
});

test("NO-HALF-BAKED: a high score with low confidence is withheld entirely", () => {
  const l = composeLetter(FULL);
  assert.ok(!l.text.includes("urgent???"), "a low-confidence read must never reach the letter");
  assert.ok(!l.surfacedInflowIds.includes("i6"));
});

test("needs-you is ranked, capped, and split from worth-knowing at the threshold", () => {
  const l = composeLetter(FULL);
  assert.equal(l.counts.needsYou, 3, "92/78/61 clear the bar; 38 and 12 do not; 88 is unconfident");
  assert.equal(l.counts.worthKnowing, 1, "only the 38 sits in the worth-knowing band");
  assert.ok(l.text.indexOf("Beate Manhart") < l.text.indexOf("Dani"), "highest score first");
  assert.ok(l.text.includes("Stripe"), "the 38 belongs in worth-knowing");
  assert.ok(!l.text.includes("FINAL HOURS"), "12 is below the worth-knowing floor");
});

test("overdue action items are called out as overdue", () => {
  const t = composeLetter(FULL).text;
  assert.ok(t.includes("OVERDUE — Send Marcus the roof repair quote"));
  assert.ok(t.includes("• Pay the V-Bank invoice"));
  assert.ok(!t.includes("OVERDUE — Pay the V-Bank invoice"));
});

test("overlapping meetings are flagged in place and counted", () => {
  const l = composeLetter(FULL);
  assert.equal(l.counts.conflicts, 1, "17:30-18:30 overlaps 18:00-18:45");
  assert.ok(l.text.includes("YOUR DAY (3, 1 overlap)"));
  assert.ok(l.text.includes("⚠"));
});

test("a prep note is attached to the meeting it belongs to", () => {
  const t = composeLetter(FULL).text;
  assert.ok(t.includes("↳ you have notes: Dani works at V-Bank via Manhart"));
});

test("every decision is one tap, and a pre-made draft is marked as ready", () => {
  const l = composeLetter(FULL);
  const labels = l.keyboard.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((x) => x.startsWith("📝 Draft") && x.includes("Dani")), "i2 was pre-drafted");
  assert.ok(!labels.some((x) => x.includes("Draft") && x.includes("Beate")), "a deadline isn't a reply");
  assert.ok(labels.filter((x) => x.startsWith("✓")).length >= 2, "handled + done buttons");
  assert.ok(labels.includes("👍 Good letter") && labels.includes("👎 Something's off"));
});

test("the coverage footer is carried through verbatim", () => {
  const l = composeLetter(FULL);
  assert.ok(l.text.includes(l.coverage));
  assert.ok(l.coverage.includes("Calendars ✓ 20/20"));
  assert.ok(l.coverage.includes("iMessage ✗"), "declared-out sources stay visible");
});

test("plain text only — no markdown the Telegram client could choke on", () => {
  const t = composeLetter(FULL).text;
  assert.ok(!/\*\*/.test(t), "no bold markers");
  assert.ok(!/^#{1,6}\s/m.test(t), "no headers");
  assert.ok(!/`/.test(t), "no backticks");
});

// --sample prints the populated letter so it can be reviewed as the owner
// would actually receive it.
if (process.argv.includes("--sample")) {
  const l = composeLetter(FULL);
  console.log("=".repeat(58));
  console.log(l.text);
  console.log("=".repeat(58));
  console.log("\nButtons:");
  for (const row of l.keyboard.inline_keyboard) {
    console.log("  [ " + row.map((b) => b.text).join(" ] [ ") + " ]");
  }
  console.log("\ncounts:", JSON.stringify(l.counts));
}
