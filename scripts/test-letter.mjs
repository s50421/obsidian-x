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
  briefing: {
    digest: {
      date: "2026-07-29",
      markets: "Brent crude rose 6% on Hormuz disruption fears.",
      geopolitics: "Iran struck US targets in Gulf states after fresh strikes.",
      tech: "New York now requires AI-generated people in ads to be labelled.",
      smalltalk: ["Paris reopened three Seine swimming sites.", "Typhoon Bavi strengthened near Taiwan."],
      sources: ["reuters.com", "bbc.com"],
      fetchedAt: NOW.toISOString(),
    },
    episode: {
      title: "AI Hedge Fund Prodigy Wiped Out",
      audioUrl: "https://example.com/ep.mp3",
      showUrl: "https://mbdailyshow.com",
      published: NOW,
      durationMin: 31,
    },
    error: null,
  },
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
  const order = ["NEEDS YOU", "YOUR DAY", "ACTION ITEMS", "WORTH KNOWING", "BRIEFING", "Coverage:"];
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

// --- the briefing block (v4.3) -------------------------------------------------
// News is the only part of the letter that asks nothing of the owner, so it
// must never push a decision below the fold — and a failed fetch must say so
// rather than looking like a quiet news day.

test("the briefing renders markets, world, tech, small talk and the podcast", () => {
  const t = composeLetter(FULL).text;
  assert.ok(t.includes("Markets — Brent crude"));
  assert.ok(t.includes("World — Iran struck"));
  assert.ok(t.includes("Tech — New York"));
  assert.ok(t.includes("• Paris reopened three Seine swimming sites."));
  assert.ok(t.includes("via reuters.com · bbc.com"), "sources are attributed");
  assert.ok(t.includes("🎧 Morning Brew Daily: AI Hedge Fund Prodigy Wiped Out · 31 min"));
});

test("the briefing sits AFTER every section that asks something of the owner", () => {
  const t = composeLetter(FULL).text;
  for (const decisionSection of ["NEEDS YOU", "ACTION ITEMS"]) {
    assert.ok(
      t.indexOf(decisionSection) < t.indexOf("BRIEFING"),
      `${decisionSection} must come before the news`
    );
  }
});

test("a failed news fetch says so — it never silently vanishes", () => {
  const t = composeLetter({
    ...FULL,
    briefing: { digest: null, episode: null, error: "search returned nothing usable" },
  }).text;
  assert.ok(t.includes("BRIEFING"), "the section header stays");
  assert.ok(t.includes("Couldn't fetch the news"), "and it says what happened");
  assert.ok(t.includes("search returned nothing usable"));
});

test("no briefing supplied — the section is omitted entirely, not left empty", () => {
  const { briefing: _omit, ...noBriefing } = FULL;
  void _omit;
  const t = composeLetter(noBriefing).text;
  assert.ok(!t.includes("BRIEFING"));
  assert.ok(t.includes("WORTH KNOWING"), "the rest of the letter is unaffected");
});

test("empty news fields are dropped rather than printed as blank rows", () => {
  const t = composeLetter({
    ...FULL,
    briefing: {
      ...FULL.briefing,
      digest: { ...FULL.briefing.digest, geopolitics: "", tech: "", smalltalk: [] },
    },
  }).text;
  assert.ok(t.includes("Markets —"));
  assert.ok(!t.includes("World —"), "an empty field must not render a dangling label");
  assert.ok(!t.includes("Tech —"));
});

test("the podcast is a button, so the tracking URL never shows in the text", () => {
  const l = composeLetter(FULL);
  assert.ok(!l.text.includes("example.com/ep.mp3"), "no raw audio URL in the body");
  const buttons = l.keyboard.inline_keyboard.flat();

  // Two buttons, because they do different jobs. The enclosure URL is a raw
  // tracking .mp3 — owner feedback on the first real letter was that tapping it
  // gives you an audio file, not a podcast — so the show page is offered too.
  const play = buttons.find((b) => b.text.includes("Play episode"));
  assert.ok(play, "a direct-play button exists");
  assert.equal(play.url, "https://example.com/ep.mp3");

  const show = buttons.find((b) => b.text.includes("Morning Brew"));
  assert.ok(show, "a link to the podcast itself exists");
  assert.equal(show.url, "https://mbdailyshow.com");
  assert.ok(!show.url.endsWith(".mp3"), "the podcast link must not be a bare audio file");
});

test("no podcast episode — no dead button", () => {
  const l = composeLetter({ ...FULL, briefing: { ...FULL.briefing, episode: null } });
  assert.ok(!l.keyboard.inline_keyboard.flat().some((b) => b.text.includes("Morning Brew")));
});

test("the briefing is plain text too — no markdown emphasis", () => {
  const t = composeLetter(FULL).text;
  const briefing = t.slice(t.indexOf("BRIEFING"));
  assert.ok(!/_[^_\n]+_/.test(briefing), "no _italics_ — parse_mode is plain");
  assert.ok(!/\*\*/.test(briefing));
});

// --- fixes driven by real screenshots (2026-08-02) -----------------------------

const { tidySubject, capPerSender } = await import("../lib/letter.ts");

test("REGRESSION: every Handled button is labelled with its sender", () => {
  // The 2026-08-02 letter showed three identical bare "✓ Handled" rows — you
  // could not tell which message each one belonged to.
  const l = composeLetter(FULL);
  const handled = l.keyboard.inline_keyboard.flat().filter((b) => b.text.startsWith("✓ "));
  const decisionLabels = handled.map((b) => b.text);
  assert.equal(new Set(decisionLabels).size, decisionLabels.length, "no two buttons may read the same");
  assert.ok(decisionLabels.some((x) => x.includes("Beate")), "labelled by sender");
});

test("REGRESSION: an enormous subject is trimmed on a word boundary", () => {
  const monster =
    "MGMT_O 599A COMM_O 399A 101 2026SS AI for Business — Assignment Graded: " +
    "Assignment #1 - Canvas Profile (Due July 11@11:59), MGMT_O 599A COMM_O 399A 101 2026SS AI for Business";
  const out = tidySubject(monster);
  assert.ok(out.length <= 80, `still ${out.length} chars`);
  assert.ok(out.endsWith("…"));
  assert.ok(!/\s…$/.test(out), "no dangling space before the ellipsis");
  assert.equal(tidySubject("Short one"), "Short one", "short subjects are untouched");
  assert.equal(tidySubject(null), "(no subject)");
  assert.equal(tidySubject("  spaced   out  "), "spaced out", "whitespace collapsed");
});

test("REGRESSION: one noisy sender can't take every NEEDS YOU slot", () => {
  // All three slots on 2026-08-01 were near-identical Canvas notifications.
  const canvas = (n) =>
    mail({ id: `c${n}`, sender: "UBC Canvas <no-reply@instructure.com>", subject: `Notification ${n}`, score: 70,
      signals: ["VIP sender"] });
  const l = composeLetter({
    ...FULL,
    inflow: [canvas(1), canvas(2), canvas(3), canvas(4),
      mail({ id: "real", sender: "Beate <b@x.com>", subject: "Signature needed", score: 65, signals: ["VIP sender", "direct to me"] })],
  });
  const shown = l.text.slice(l.text.indexOf("NEEDS YOU"), l.text.indexOf("YOUR DAY"));
  assert.equal((shown.match(/UBC Canvas/g) || []).length, 2, "capped at 2 per sender");
  assert.ok(shown.includes("Beate"), "a different sender still gets through");
});

test("capPerSender preserves rank order", () => {
  const r = (id, who, score) => mail({ id, sender: who, subject: id, score, signals: [] });
  const out = capPerSender([r("a", "X <x@x.com>", 90), r("b", "X <x@x.com>", 80), r("c", "X <x@x.com>", 70), r("d", "Y <y@y.com>", 60)], 2);
  assert.deepEqual(out.map((x) => x.id), ["a", "b", "d"]);
});

// --- dedupe (owner: "dedupe needs to be better") ------------------------------

const { dedupeInflow } = await import("../lib/letter.ts");

test("REGRESSION: the same sender+subject twice collapses to one", () => {
  // 2026-07-31 WORTH KNOWING listed the identical f-bb.de acknowledgement twice.
  const dup = (id) =>
    mail({ id, sender: "anerkennungszuschuss@f-bb.de",
      subject: "Eingangsbestätigung Antrag auf Anerkennungszuschuss", score: 40, signals: [] });
  const out = dedupeInflow([dup("a"), dup("b")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dupes, 2, "and it remembers how many it stands for");
});

test("reply and forward prefixes don't defeat dedupe", () => {
  const v = (id, subject) => mail({ id, sender: "Beate <b@x.com>", subject, score: 50, signals: [] });
  const out = dedupeInflow([
    v("a", "Court strategy documents"),
    v("b", "Re: Court strategy documents"),
    v("c", "WG: Court strategy documents"),
    v("d", "FWD: court strategy DOCUMENTS!!"),
  ]);
  assert.equal(out.length, 1, "all four are the same thread");
  assert.equal(out[0].dupes, 4);
});

test("dedupe keeps the highest-scored copy and the original order", () => {
  const v = (id, subject, score) => mail({ id, sender: "X <x@x.com>", subject, score, signals: [] });
  const out = dedupeInflow([v("low", "Same thing", 30), v("high", "Same thing", 90), v("other", "Different", 50)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "high", "the better copy survives");
  assert.equal(out[0].ranked_score, 90);
  assert.equal(out[1].id, "other", "order is preserved");
});

test("genuinely different mail from one sender is NOT collapsed", () => {
  const v = (id, subject) => mail({ id, sender: "Beate <b@x.com>", subject, score: 60, signals: [] });
  const out = dedupeInflow([v("a", "Signature needed by Friday"), v("b", "Holiday photos from Lisbon")]);
  assert.equal(out.length, 2, "different subjects must both survive");
});

test("the letter shows a multiplier instead of hiding repeats", () => {
  const dup = (id) =>
    mail({ id, sender: "Canvas <no-reply@instructure.com>", subject: "Assignment graded",
      score: 70, signals: ["VIP sender"] });
  const t = composeLetter({ ...FULL, inflow: [dup("a"), dup("b"), dup("c")] }).text;
  assert.ok(t.includes("(x3)"), "the owner can see it happened three times");
  assert.equal((t.match(/Assignment graded/g) || []).length, 1, "but only one line");
});

// ---------------------------------------------------------------------------
// v4.2.3 — what the first week of real letters got wrong.
// ---------------------------------------------------------------------------

const { senderKey } = await import("../lib/letter.ts");

const row = (id, who, score, extra = {}) =>
  ({ ...mail({ id, sender: who, subject: id, score, signals: [] }), ...extra });

test("senders are grouped by ADDRESS, not by display name", () => {
  // Canvas rewrites its display name per course but sends everything from one
  // address. Keyed on the display name, the per-sender cap saw three different
  // senders — which is how all three NEEDS YOU slots went to Canvas on
  // 2026-08-01, the morning AFTER the cap was added to prevent exactly that.
  const CANVAS = "notifications@instructure.com";
  const rows = [
    row("a", `MGMT_O 599A COMM_O 399A 101 2026SS AI for Business <${CANVAS}>`, 55),
    row("b", `MGMT_O 599A COMM_O 399A 101 2026SS AI for Business <${CANVAS}>`, 55),
    row("c", `UBC Canvas <${CANVAS}>`, 55),
    row("d", "Beate Manhart <beate@v-bank.com>", 74),
  ];
  assert.equal(senderKey(rows[0].sender), senderKey(rows[2].sender), "same mailbox, different label");
  const out = capPerSender(rows, 2);
  assert.equal(out.filter((x) => senderKey(x.sender) === CANVAS).length, 2, "cap must hold across display names");
  assert.equal(out.length, 3);
});

test("senderKey falls back sanely when there is no angle-bracket address", () => {
  assert.equal(senderKey("anerkennungszuschuss@f-bb.de"), "anerkennungszuschuss@f-bb.de");
  assert.equal(senderKey("Some Name"), "some name");
  assert.equal(senderKey(null), "unknown");
});

test("mail the system already filed says so, instead of vanishing", () => {
  // Real failure, 2026-07-31: a shareholder-vote notice cleared the strict
  // auto-create bar, became a task due Sept 14 — and was then excluded from
  // every letter, because auto-create flips inflow state to 'actioned'. The
  // mail that clears the HIGHEST bar was the mail most likely to go unmentioned.
  const filed = {
    ...row("ib", "Interactive Brokers <ib@proxydocs.com>", 55),
    item_id: "11111111-1111-1111-1111-111111111111",
  };
  assert.equal(
    suggestedAction({ ...filed, filed: { where: "brain", type: "reference" } }),
    "filed as reference · in the brain",
    "says what it was classified as, and that it is NOT on a board"
  );
  assert.equal(
    suggestedAction({ ...filed, filed: { where: "board", type: "task" } }),
    "filed as task · on your ClickUp board",
    "the board is only claimed when a ClickUp reference really exists"
  );
  assert.equal(suggestedAction(filed), "filed in the brain", "fallback when the join found nothing");

  const letter = composeLetter({
    tz: TZ,
    now: NOW,
    events: [],
    statusRows: [],
    inflow: [filed],
    actions: [],
  });
  assert.match(letter.text, /NEEDS YOU \(1\)/);
  assert.match(letter.text, /filed in the brain/);
});

test("the briefing separates what HAPPENED from what's worth UNDERSTANDING", () => {
  // Owner ask 2026-08-02: "2-3 general knowledge points … that make me seem up
  // to date and educated". Folding these into smalltalk just produced three
  // more headlines, so they get their own labelled block.
  const l = composeLetter({
    ...FULL,
    briefing: {
      ...FULL.briefing,
      digest: {
        ...FULL.briefing.digest,
        smalltalk: ["Paris reopened three Seine swimming sites."],
        knowledge: ["The Strait of Hormuz is a chokepoint for a fifth of global oil."],
      },
    },
  });
  assert.match(l.text, /Worth knowing about:/);
  assert.match(l.text, /◦ The Strait of Hormuz/);
  assert.match(l.text, /• Paris reopened/);
  // …and the owner is told he can go deeper, or the feature is invisible.
  assert.match(l.text, /Ask me about any of these/);
});

test("no knowledge points — no empty header", () => {
  const l = composeLetter({
    ...FULL,
    briefing: { ...FULL.briefing, digest: { ...FULL.briefing.digest, knowledge: [] } },
  });
  assert.ok(!l.text.includes("Worth knowing about:"));
});
