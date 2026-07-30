// Obsidian-X — constant-time secret comparison.
//
//   node --experimental-strip-types --no-warnings scripts/test-secure-compare.mjs
//
// Guards the shared-secret checks on every self-authenticating endpoint
// (cron, Telegram webhook, capture-token, inbound email). The ClickUp webhook
// has compared its HMAC in constant time since v2.2; the rest used a plain
// `===`, which bails at the first differing byte and therefore leaks the secret
// through response timing.
//
// The correctness properties matter more than the timing one here — a
// "hardened" comparison that accidentally accepts the wrong token, or rejects
// the right one, would be far worse than the leak it fixes.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { secureEquals, bearerEquals } = await import("../lib/secure-compare.ts");

const SECRET = "s3cr3t-token-with-enough-length-to-matter";

test("identical strings match", () => {
  assert.equal(secureEquals(SECRET, SECRET), true);
  assert.equal(secureEquals("a", "a"), true);
});

test("any difference is rejected — including only the last byte", () => {
  assert.equal(secureEquals(SECRET, SECRET.slice(0, -1) + "X"), false);
  assert.equal(secureEquals("X" + SECRET.slice(1), SECRET), false);
  assert.equal(secureEquals(SECRET, SECRET + "x"), false);
  assert.equal(secureEquals(SECRET, SECRET.slice(0, -1)), false);
});

test("empty and nullish never authenticate — the critical failure mode", () => {
  // If a secret were unset in the environment, a naive compare of ""==="" would
  // let EVERYONE in. These endpoints are public.
  for (const [a, b] of [
    [null, null],
    [undefined, undefined],
    ["", ""],
    ["", SECRET],
    [SECRET, ""],
    [null, SECRET],
    [SECRET, null],
    [undefined, SECRET],
    [SECRET, undefined],
  ]) {
    assert.equal(secureEquals(a, b), false, `${JSON.stringify(a)} vs ${JSON.stringify(b)} must not match`);
  }
});

test("comparison is case- and whitespace-sensitive", () => {
  assert.equal(secureEquals(SECRET, SECRET.toUpperCase()), false);
  assert.equal(secureEquals(SECRET, ` ${SECRET}`), false);
  assert.equal(secureEquals(SECRET, `${SECRET} `), false);
});

test("multi-byte characters don't break the length check", () => {
  // Buffer length is BYTES, not code points — a naive .length compare would
  // treat these as equal-length and then throw inside timingSafeEqual.
  assert.equal(secureEquals("é", "e"), false);
  assert.equal(secureEquals("🔐", "🔐"), true);
  assert.doesNotThrow(() => secureEquals("ααα", "aaa"));
});

test("bearerEquals accepts a correct Authorization header", () => {
  assert.equal(bearerEquals(`Bearer ${SECRET}`, SECRET), true);
});

test("bearerEquals rejects malformed or wrong headers", () => {
  for (const h of [
    `Bearer ${SECRET}x`,
    `bearer ${SECRET}`, // scheme is case-sensitive here by choice
    SECRET, // no scheme
    `Basic ${SECRET}`,
    "Bearer ",
    "Bearer",
    "",
    null,
    undefined,
  ]) {
    assert.equal(bearerEquals(h, SECRET), false, `${JSON.stringify(h)} must not authenticate`);
  }
});

test("bearerEquals with no configured secret always fails closed", () => {
  assert.equal(bearerEquals(`Bearer ${SECRET}`, undefined), false);
  assert.equal(bearerEquals(`Bearer ${SECRET}`, ""), false);
  assert.equal(bearerEquals("Bearer ", ""), false);
});
