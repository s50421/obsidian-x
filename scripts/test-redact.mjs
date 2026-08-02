// Obsidian-X v4.3 — one-time code redaction.
//
//   node --experimental-strip-types --no-warnings scripts/test-redact.mjs
//
// Owner directive after a digest echoed a live Crypto.com code into Telegram:
// "verification codes should never be sent through telegram."
//
// The false-POSITIVE tests matter as much as the false-negative ones. The same
// letter legitimately carried a proxy-voting control number the owner needed,
// and the brief is full of amounts, dates, invoice refs and phone numbers. A
// redactor that eats those is useless in a different way.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { redactCodes, containsCode } = await import("../lib/redact.ts");

const hidden = (s) => redactCodes(s).text;

test("REGRESSION: the exact line that leaked", () => {
  const real = "Crypto.com verification code (763264) — already expired (10-min validity).";
  const out = hidden(real);
  assert.ok(!out.includes("763264"), "the code must be gone");
  assert.ok(out.includes("[code hidden]"));
  assert.ok(out.includes("Crypto.com"), "the context stays readable");
  assert.ok(out.includes("10-min validity"), "unrelated numbers survive");
});

test("common one-time code phrasings are caught", () => {
  for (const s of [
    "Your verification code is 483920",
    "Security code: 12345",
    "Use one-time code 8471 to continue",
    "OTP 4821",
    "Your login code 220385 expires soon",
    "Authentication code - 99283",
    "Your code is 5567",
    "G-448271 is your Google verification code",
    "483920 is your verification code",
  ]) {
    assert.equal(containsCode(s), true, `missed: ${s}`);
    assert.ok(!/\b\d{4,10}\b/.test(hidden(s).replace("[code hidden]", "")), `leaked: ${hidden(s)}`);
  }
});

test("FALSE POSITIVES: numbers the owner actually needs survive", () => {
  const keep = [
    // The proxy vote from the real letter — the owner needed this.
    "Go to proxypush.com with control number 515881901124 and submit your vote",
    "You've received $150.00 from Anna Shewchenko",
    "Invoice 88213 is due on 2026-09-14",
    "Call Mateo on 6041234567",
    "Assignment #1 - Canvas Profile (Due July 11@11:59)",
    "Brent crude rose 6% to 8123 on Hormuz fears",
    "The meeting is at 1720 Springfield Road, V1Y 7W2",
    "Task 86ajtv1tq created in ClickUp",
  ];
  for (const s of keep) {
    assert.equal(containsCode(s), false, `over-redacted: ${s}`);
    assert.equal(hidden(s), s, `changed: ${s}`);
  }
});

test("a year is never mistaken for a code", () => {
  assert.equal(hidden("verification code 2026"), "verification code 2026");
});

test("multiple codes in one message are all removed", () => {
  const out = hidden("Your verification code is 111111 and your backup code is 222222.");
  assert.ok(!out.includes("111111") && !out.includes("222222"));
});

test("empty and clean input is passed through untouched", () => {
  assert.deepEqual(redactCodes(""), { text: "", redacted: false });
  const clean = "Nothing needs you.";
  assert.deepEqual(redactCodes(clean), { text: clean, redacted: false });
});

test("redaction is reported so a leak attempt can be logged without logging the code", () => {
  const r = redactCodes("Your verification code is 483920");
  assert.equal(r.redacted, true);
  assert.ok(!r.text.includes("483920"));
});

test("REGRESSION: a linking verb between the keyword and the code", () => {
  // Found live: "Your Crypto.com verification code was 763264" survived the
  // first version, which only handled "is", ":" and a bare number.
  for (const s of [
    "Your Crypto.com verification code was 763264",
    "Your code was 4821",
    "The verification code is currently 55123",
    "Your security code (sent by SMS) 998877",
  ]) {
    assert.equal(containsCode(s), true, `missed: ${s}`);
    assert.ok(!/\d{4,10}/.test(hidden(s).replace("[code hidden]", "")), `leaked: ${hidden(s)}`);
  }
});

test("the widened gap still can't reach an unrelated number", () => {
  const s =
    "Your verification code was 763264. Separately, the proxy control number for the annual meeting is 515881901124.";
  const out = hidden(s);
  assert.ok(!out.includes("763264"), "the code goes");
  assert.ok(out.includes("515881901124"), "the control number stays");
});
