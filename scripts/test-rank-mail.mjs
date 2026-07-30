// Obsidian-X v4.1 — exit tests for the mail ranker's SCORING half.
//
//   node --experimental-strip-types --no-warnings scripts/test-rank-mail.mjs
//
// The scoring layer is pure (headers + a content read in, a score out), so it
// can be tested without Gmail credentials or network. These assertions encode
// the brief's exit tests and the owner's never-miss rules directly:
//
//   - "Newsletter/bulk mail never ranks above a direct question from a VIP."
//   - the four never-miss signals (deadline, awaiting-reply, money/legal,
//     direct-to-me-not-bulk)
//   - the strict auto-create bar (VIP AND direct AND deadline/question/money)
//
// lib/rank-mail.ts is TypeScript behind the "@/" alias, so this runs under
// node's type-stripping with the same resolver hook the W2 tests use.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const {
  deterministicSignals,
  scoreMail,
  meetsAutoCreateBar,
  canSkipContentPass,
  othersSpokeLast,
  isVipSender,
  resolveStream,
  SURFACE_THRESHOLD,
} = await import("../lib/rank-mail.ts");

const ME = "davi.manhart@gmail.com";

const VIP = { addresses: ["jane@acme.com"], domains: ["vbank.example"], names: ["priya"] };
const DEMOTE = { addresses: [], domains: [], subjects: ["weekly digest"] };

/** Minimal GmailMessageMeta factory. */
function msg(headers, { labelIds = [], snippet = "" } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    id: "m1",
    threadId: "t1",
    internalDate: Date.now(),
    snippet,
    labelIds,
    headers: lower,
  };
}

/** A confident model read. */
const read = (o = {}) => ({
  importance: 0.5,
  deadline: false,
  question: false,
  money: false,
  reason: "test",
  confidence: 0.9,
  usage: null,
  ...o,
});

const NEWSLETTER = msg({
  From: "Marketing <news@shop.example>",
  To: ME,
  Subject: "🔥 FINAL HOURS — 70% off everything!",
  "List-Unsubscribe": "<https://shop.example/u>",
});

const VIP_QUESTION = msg({
  From: "Jane Doe <jane@acme.com>",
  To: ME,
  Subject: "Can you send me the Q3 numbers?",
});

// ---------------------------------------------------------------------------

test("VIP matching covers address, domain and display name", () => {
  assert.equal(isVipSender({ name: "Jane Doe", email: "jane@acme.com" }, VIP), true);
  assert.equal(isVipSender({ name: "", email: "ops@vbank.example" }, VIP), true);
  assert.equal(isVipSender({ name: "Priya Raman", email: "p@other.com" }, VIP), true);
  assert.equal(isVipSender({ name: "Random", email: "nobody@other.com" }, VIP), false);
});

test("bulk headers are detected and never classified by the model", () => {
  const s = deterministicSignals(NEWSLETTER, ME, VIP, DEMOTE);
  assert.equal(s.bulk, true, "List-Unsubscribe must mark it bulk");
  assert.equal(canSkipContentPass(s), true, "a newsletter must not cost a model call");
});

test("EXIT TEST: a newsletter never outranks a direct question from a VIP", () => {
  // Give the newsletter every benefit of the doubt the model could offer.
  const bulk = scoreMail(
    deterministicSignals(NEWSLETTER, ME, VIP, DEMOTE),
    read({ importance: 1, deadline: true, question: true, money: true, confidence: 1 })
  );
  const vip = scoreMail(
    deterministicSignals(VIP_QUESTION, ME, VIP, DEMOTE),
    read({ importance: 0.8, question: true })
  );
  assert.ok(
    vip.score > bulk.score,
    `VIP (${vip.score}) must outrank maximally-flattering bulk (${bulk.score})`
  );
  assert.ok(bulk.score < SURFACE_THRESHOLD, "bulk must stay below the surface threshold");
  assert.ok(vip.score >= SURFACE_THRESHOLD, "a VIP's direct question must surface");
});

test("a no-reply sender counts as bulk even without List-Unsubscribe", () => {
  const s = deterministicSignals(
    msg({ From: "no-reply@service.example", To: ME, Subject: "Your receipt" }),
    ME,
    VIP,
    DEMOTE
  );
  assert.equal(s.bulk, true);
});

test("never-miss 1 + 3: deadline and money/legal both lift the score", () => {
  const plain = msg({ From: "Bob <bob@other.com>", To: ME, Subject: "Contract" });
  const base = scoreMail(deterministicSignals(plain, ME, VIP, DEMOTE), read());
  const withDeadline = scoreMail(
    deterministicSignals(plain, ME, VIP, DEMOTE),
    read({ deadline: true })
  );
  const withMoney = scoreMail(deterministicSignals(plain, ME, VIP, DEMOTE), read({ money: true }));
  assert.ok(withDeadline.score > base.score, "a deadline must raise the score");
  assert.ok(withMoney.score > base.score, "money/legal must raise the score");
});

test("never-miss 2: a thread awaiting my reply outranks the same thread otherwise", () => {
  const m = msg({
    From: "Bob <bob@other.com>",
    To: ME,
    Subject: "Re: proposal",
    "In-Reply-To": "<abc@mail>",
  });
  const quiet = scoreMail(deterministicSignals(m, ME, VIP, DEMOTE, false), read());
  const owed = scoreMail(deterministicSignals(m, ME, VIP, DEMOTE, true), read());
  assert.ok(owed.score > quiet.score, "owing a reply must raise the score");
});

test("never-miss 4: cc-only ranks below direct-to-me", () => {
  const direct = scoreMail(
    deterministicSignals(
      msg({ From: "Bob <bob@other.com>", To: ME, Subject: "Q" }),
      ME,
      VIP,
      DEMOTE
    ),
    read()
  );
  const cc = scoreMail(
    deterministicSignals(
      msg({ From: "Bob <bob@other.com>", To: "someone@else.com", Cc: ME, Subject: "Q" }),
      ME,
      VIP,
      DEMOTE
    ),
    read()
  );
  assert.ok(direct.score > cc.score, "direct must outrank cc-only");
});

test("a large To: list is not 'direct'", () => {
  const many = [ME, "a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"].join(", ");
  const s = deterministicSignals(
    msg({ From: "Bob <bob@other.com>", To: many, Subject: "All hands" }),
    ME,
    VIP,
    DEMOTE
  );
  assert.equal(s.direct, false);
});

test("demote rules cap a matching subject hard", () => {
  const s = deterministicSignals(
    msg({ From: "Jane Doe <jane@acme.com>", To: ME, Subject: "Weekly digest — team news" }),
    ME,
    VIP,
    DEMOTE
  );
  assert.equal(s.demoted, true, "subject rule must match case-insensitively");
  const r = scoreMail(s, read({ importance: 1, deadline: true, confidence: 1 }));
  assert.ok(r.score <= 10, `a demoted message must be capped (got ${r.score})`);
  assert.equal(r.autoCreate, false, "a demoted message must never auto-create");
});

// The owner's definition (2026-07-29): "VIP is any mail that contains an action
// item or requires a response that is not an advertisement or sale." The gate is
// the ACTION, not the sender — so a named VIP is NOT required to auto-create.

test("auto-create is gated on the ACTION, not on being a named VIP", () => {
  const s = deterministicSignals(VIP_QUESTION, ME, VIP, DEMOTE);

  assert.equal(
    meetsAutoCreateBar(s, read({ question: true, importance: 0.8, confidence: 0.8 })),
    true,
    "VIP + direct + question + confident should auto-create"
  );

  const stranger = deterministicSignals(
    msg({ From: "Bob <bob@other.com>", To: ME, Subject: "Can you send this by Friday?" }),
    ME,
    VIP,
    DEMOTE
  );
  assert.equal(
    meetsAutoCreateBar(stranger, read({ question: true, deadline: true, importance: 0.9, confidence: 0.9 })),
    true,
    "a stranger asking me to do something by Friday IS an action item"
  );
});

test("auto-create still refuses everything that isn't a confident, direct action", () => {
  const s = deterministicSignals(VIP_QUESTION, ME, VIP, DEMOTE);

  assert.equal(
    meetsAutoCreateBar(s, read({ question: true, importance: 0.8, confidence: 0.4 })),
    false,
    "a low-confidence read must never auto-create"
  );
  assert.equal(
    meetsAutoCreateBar(s, read({ importance: 0.95, confidence: 1 })),
    false,
    "high importance alone, with no deadline/question/money, must not auto-create"
  );
  assert.equal(
    meetsAutoCreateBar(s, read({ question: true, importance: 0.4, confidence: 1 })),
    false,
    "an action item the model thinks is unimportant must not auto-create"
  );

  const ccd = deterministicSignals(
    msg({ From: "Bob <bob@other.com>", To: "someone@else.com", Cc: ME, Subject: "by Friday?" }),
    ME,
    VIP,
    DEMOTE
  );
  assert.equal(
    meetsAutoCreateBar(ccd, read({ question: true, deadline: true, importance: 1, confidence: 1 })),
    false,
    "being cc'd is not being asked"
  );
});

// "Canvas/class emails, Beate Manhart, V-Bank and similar should always surface."
// All three send machine-generated mail carrying List-Unsubscribe, so the bulk
// cap would have buried them — the owner's instruction silently not happening.

const CLASS_NOTIFICATION = msg({
  From: "Canvas <notifications@instructure.com>",
  To: ME,
  Subject: "New assignment posted: Problem Set 4",
  "List-Unsubscribe": "<https://instructure.com/u>",
});

test("EXIT TEST: a named VIP always surfaces, even when the mail is bulk", () => {
  const vipRules = { addresses: [], domains: ["instructure.com"], names: [] };
  const s = deterministicSignals(CLASS_NOTIFICATION, ME, vipRules, DEMOTE);

  assert.equal(s.bulk, true, "it really is bulk — List-Unsubscribe is present");
  assert.equal(s.vip, true, "and the owner named the domain");

  const r = scoreMail(s, read({ importance: 0.2, confidence: 0.9 }));
  assert.ok(
    r.score >= SURFACE_THRESHOLD,
    `a named VIP must clear the threshold despite being bulk (got ${r.score})`
  );
  assert.equal(r.autoCreate, false, "surfacing is not the same as becoming a memory");
});

test("the bulk cap still applies to everyone the owner did NOT name", () => {
  const s = deterministicSignals(CLASS_NOTIFICATION, ME, VIP, DEMOTE); // not a VIP here
  const r = scoreMail(s, read({ importance: 1, deadline: true, confidence: 1 }));
  assert.ok(r.score < SURFACE_THRESHOLD, `unnamed bulk must stay capped (got ${r.score})`);
});

test("an explicit demotion beats VIP status", () => {
  const vipRules = { addresses: [], domains: ["instructure.com"], names: [] };
  const demote = { addresses: [], domains: [], subjects: ["problem set"] };
  const s = deterministicSignals(CLASS_NOTIFICATION, ME, vipRules, demote);

  assert.equal(s.vip, true);
  assert.equal(s.demoted, true);
  const r = scoreMail(s, read({ importance: 1, confidence: 1 }));
  assert.ok(r.score <= 10, `"never" must win over "always" (got ${r.score})`);
  assert.equal(canSkipContentPass(s), true, "and a demoted VIP costs no model call");
});

test("a named VIP is always read by the model, bulk or not", () => {
  const vipRules = { addresses: [], domains: ["instructure.com"], names: [] };
  const s = deterministicSignals(CLASS_NOTIFICATION, ME, vipRules, DEMOTE);
  assert.equal(
    canSkipContentPass(s),
    false,
    "a guaranteed-to-surface message needs a real reason line, not 'not classified'"
  );
  assert.equal(canSkipContentPass(deterministicSignals(VIP_QUESTION, ME, VIP, DEMOTE)), false);
});

test("VIP name matching catches a person who mails from several addresses", () => {
  const vipRules = { addresses: [], domains: [], names: ["beate manhart"] };
  for (const from of [
    "Beate Manhart <beate@example.com>",
    "Beate Manhart <b.manhart@work.example>",
  ]) {
    const s = deterministicSignals(msg({ From: from, To: ME, Subject: "Hi" }), ME, vipRules, DEMOTE);
    assert.equal(s.vip, true, `should match ${from}`);
  }
  const other = deterministicSignals(
    msg({ From: "Manhart Group Marketing <ads@shop.example>", To: ME, Subject: "Sale" }),
    ME,
    vipRules,
    DEMOTE
  );
  assert.equal(other.vip, false, "a partial surname match must not make everything VIP");
});

test("othersSpokeLast only fires when I am actually in the conversation", () => {
  const them = { headers: { from: "Bob <bob@other.com>" } };
  const me = { headers: { from: `Me <${ME}>` } };
  assert.equal(othersSpokeLast([them, me, them], ME), true, "I spoke, they replied → I owe one");
  assert.equal(othersSpokeLast([them, me], ME), false, "I spoke last → nothing owed");
  assert.equal(othersSpokeLast([them, them], ME), false, "I never spoke → not my thread yet");
  assert.equal(othersSpokeLast([], ME), false);
});

// --- multi-identity: the personal Gmail forwards into the Workspace mailbox ---
// A Workspace "Internal" OAuth app can't be granted to a consumer account, so
// davi.manhart@gmail.com forwards into david@manhartgroup.com and we
// authenticate only the latter. Forwarded mail keeps its ORIGINAL To:, so
// identity has to be a SET or the whole forwarded stream reads as not-direct.

const WORK = "david@manhartgroup.com";
const BOTH = [WORK, ME];

test("forwarded mail addressed to my other address still counts as direct", () => {
  const fwd = msg({
    From: "Bob <bob@other.com>",
    To: ME, // original recipient — the personal account
    "Delivered-To": WORK, // where it actually landed
    Subject: "Can you confirm Friday?",
  });

  const single = deterministicSignals(fwd, WORK, VIP, DEMOTE);
  assert.equal(single.direct, true, "Delivered-To alone should rescue it");

  const multi = deterministicSignals(fwd, BOTH, VIP, DEMOTE);
  assert.equal(multi.direct, true, "and the identity set must agree");

  // The regression this guards: matching only the authenticated mailbox.
  const wrong = deterministicSignals(
    msg({ From: "Bob <bob@other.com>", To: ME, Subject: "Can you confirm Friday?" }),
    WORK,
    VIP,
    DEMOTE
  );
  assert.equal(wrong.direct, false, "without any identity match it is correctly not-direct");
});

test("X-Forwarded-To is honoured as well as Delivered-To", () => {
  const s = deterministicSignals(
    msg({ From: "Bob <bob@other.com>", To: ME, "X-Forwarded-To": WORK, Subject: "Hi" }),
    WORK,
    VIP,
    DEMOTE
  );
  assert.equal(s.direct, true);
});

test("being forwarded does NOT upgrade a cc into a direct message", () => {
  const s = deterministicSignals(
    msg({
      From: "Bob <bob@other.com>",
      To: "someone@else.com",
      Cc: ME,
      "Delivered-To": WORK,
      Subject: "FYI",
    }),
    BOTH,
    VIP,
    DEMOTE
  );
  assert.equal(s.ccOnly, true, "still cc-only");
  assert.equal(s.direct, false, "delivery is not the same as being addressed");
});

test("a forwarded newsletter is still bulk", () => {
  const s = deterministicSignals(
    msg({
      From: "news@shop.example",
      To: ME,
      "Delivered-To": WORK,
      Subject: "Sale!",
      "List-Unsubscribe": "<https://shop.example/u>",
    }),
    BOTH,
    VIP,
    DEMOTE
  );
  assert.equal(s.bulk, true);
  const r = scoreMail(s, read({ importance: 1, deadline: true, confidence: 1 }));
  assert.ok(r.score < SURFACE_THRESHOLD, `forwarding must not launder bulk (got ${r.score})`);
});

// --- stream attribution -------------------------------------------------------
// Forwarded personal mail lands inside the Workspace mailbox but must still be
// counted as its own inflow, or the coverage panel collapses two sources into
// one and stops being able to show either honestly.

test("stream resolves from the Gmail label, not the mailbox", () => {
  const labels = new Map([
    ["Label_7", "via-personal"],
    ["Label_8", "Receipts"],
  ]);
  const map = { "via-personal": ME };

  assert.equal(
    resolveStream(["INBOX", "Label_7"], labels, map, WORK),
    ME,
    "a labelled message belongs to the personal stream"
  );
  assert.equal(
    resolveStream(["INBOX", "Label_8"], labels, map, WORK),
    WORK,
    "an unrelated label falls back to the mailbox"
  );
  assert.equal(resolveStream(["INBOX"], labels, map, WORK), WORK, "no label → the mailbox");
  assert.equal(resolveStream([], labels, {}, WORK), WORK, "no configured streams → the mailbox");
});

test("stream label matching is case-insensitive and survives an unresolved id", () => {
  const labels = new Map([["Label_7", "Via-Personal"]]);
  assert.equal(resolveStream(["Label_7"], labels, { "via-personal": ME }, WORK), ME);
  // If the labels call failed we have ids but no names — must not crash, and
  // must fall back rather than mis-attribute.
  assert.equal(resolveStream(["Label_7"], new Map(), { "via-personal": ME }, WORK), WORK);
});

test("othersSpokeLast recognises every one of my addresses as me", () => {
  const them = { headers: { from: "Bob <bob@other.com>" } };
  const mePersonal = { headers: { from: `Me <${ME}>` } };
  assert.equal(
    othersSpokeLast([them, mePersonal, them], BOTH),
    true,
    "I replied from the personal address; they came back → I owe one"
  );
  assert.equal(
    othersSpokeLast([them, mePersonal, them], WORK),
    false,
    "with only the work address known, my own reply is invisible"
  );
});
