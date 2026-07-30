// Obsidian-X v4.1 — regression tests for the Google OAuth `state` round-trip.
//
//   node --experimental-strip-types --no-warnings scripts/test-oauth-state.mjs
//
// These exist because of a real production failure. The state encodes which
// OAuth client began the flow. When that separator was ":", the COOKIE copy
// came back percent-encoded ("workspace%3A<uuid>") while Google's `state` query
// param arrived decoded ("workspace:<uuid>"), so the CSRF check compared two
// different strings and every single connection attempt failed with
// "state mismatch" — surfacing to the owner as a button that did nothing.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { makeState, appFromState, statesMatch } = await import("../lib/oauth-state.ts");

const NONCE = "3f6c1b62-2d51-4a0e-9d17-2a6f1c0b8e44";

test("the separator survives encodeURIComponent untouched", () => {
  const state = makeState("workspace", NONCE);
  assert.equal(
    encodeURIComponent(state),
    state,
    "a state that changes under URL encoding is the original bug"
  );
  assert.equal(encodeURIComponent(makeState("personal", NONCE)), makeState("personal", NONCE));
});

test("the app round-trips through the state", () => {
  assert.equal(appFromState(makeState("workspace", NONCE)), "workspace");
  assert.equal(appFromState(makeState("personal", NONCE)), "personal");
});

test("an unknown or missing app falls back to workspace, never throws", () => {
  assert.equal(appFromState(null), "workspace");
  assert.equal(appFromState(undefined), "workspace");
  assert.equal(appFromState(""), "workspace");
  assert.equal(appFromState("garbage"), "workspace");
  assert.equal(appFromState("evil.nonce"), "workspace");
});

test("matching states match", () => {
  const s = makeState("workspace", NONCE);
  assert.equal(statesMatch(s, s), true);
});

test("REGRESSION: a percent-encoded cookie copy still matches", () => {
  // Exactly the shape that broke production, using the old ":" separator.
  const decoded = `workspace:${NONCE}`;
  const encoded = encodeURIComponent(decoded); // workspace%3A<uuid>
  assert.notEqual(decoded, encoded, "precondition: these differ as raw strings");
  assert.equal(
    statesMatch(decoded, encoded),
    true,
    "an encoding difference between the query param and the cookie must not fail the check"
  );
});

test("different states do NOT match — the CSRF property still holds", () => {
  const mine = makeState("workspace", NONCE);
  const theirs = makeState("workspace", "00000000-0000-0000-0000-000000000000");
  assert.equal(statesMatch(mine, theirs), false);
  assert.equal(statesMatch(mine, makeState("personal", NONCE)), false, "app must be part of it");
});

test("a missing state or cookie never passes", () => {
  const s = makeState("workspace", NONCE);
  assert.equal(statesMatch(null, s), false);
  assert.equal(statesMatch(s, null), false);
  assert.equal(statesMatch(undefined, undefined), false);
  assert.equal(statesMatch("", ""), false, "two empty values are not a match");
});

test("malformed percent-encoding degrades to a raw compare instead of throwing", () => {
  // decodeURIComponent("%") throws; the check must return a verdict regardless.
  assert.equal(statesMatch("%", "%"), true);
  assert.equal(statesMatch("%", makeState("workspace", NONCE)), false);
});
