// Obsidian-X v4.2.1 — conversational memory helpers.
//
//   node --experimental-strip-types --no-warnings scripts/test-conversation.mjs
//
// The bug these guard against, observed in production on 2026-07-30:
//
//   owner: "Canvas to-dos: - instage phone call - resume"
//   bot:   "Save this?"  [Save] [Discard]
//   owner: "Save them as two separate things"
//   bot:   "I need more context to understand what you'd like me to save."
//
// "them" was one message earlier. The rendering and windowing rules below are
// what let the intent model see that.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { renderContext, CONTEXT_TURNS, CONTEXT_WINDOW_MIN } = await import("../lib/conversation.ts");

const turn = (role, text) => ({ role, text, meta: {}, created_at: new Date(0).toISOString() });

test("no history renders as empty — never a stray label", () => {
  assert.equal(renderContext([]), "");
});

test("turns render with speaker labels the model can tell apart", () => {
  const out = renderContext([
    turn("user", "Canvas to-dos: - instage phone call - resume"),
    turn("assistant", "📝 Save your Canvas to-dos?"),
  ]);
  assert.equal(
    out,
    "OWNER: Canvas to-dos: - instage phone call - resume\nYOU: 📝 Save your Canvas to-dos?"
  );
});

test("REGRESSION: the exchange a follow-up needs is present in the context", () => {
  // If this string isn't in the rendered context, "them" is unresolvable and
  // the bot is back to "I need more context".
  const ctx = renderContext([
    turn("user", "Canvas to-dos: - instage phone call - resume"),
    turn("assistant", "📝 Save your Canvas to-dos?"),
  ]);
  assert.ok(ctx.includes("instage phone call"), "the referent must survive rendering");
  assert.ok(ctx.includes("resume"));
});

test("long turns are truncated so context can't blow the prompt", () => {
  const out = renderContext([turn("assistant", "x".repeat(5000))]);
  assert.ok(out.length < 700, `expected a truncated turn, got ${out.length} chars`);
});

test("the windowing constants are sane", () => {
  // Long enough for a real follow-up, short enough that a message hours later
  // isn't confidently attached to something the owner has forgotten.
  assert.ok(CONTEXT_WINDOW_MIN >= 15 && CONTEXT_WINDOW_MIN <= 120, "window should be minutes, not days");
  assert.ok(CONTEXT_TURNS >= 4 && CONTEXT_TURNS <= 30, "enough to resolve a pronoun, not a transcript");
});

test("multi-line turns stay readable as single labelled blocks", () => {
  const out = renderContext([turn("user", "line one\nline two")]);
  assert.ok(out.startsWith("OWNER: line one"));
  assert.equal(out.split("OWNER:").length - 1, 1, "one label per turn, not per line");
});
