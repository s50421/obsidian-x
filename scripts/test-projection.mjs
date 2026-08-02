// Obsidian-X — the ClickUp projection's trust dial.
//
//   node --experimental-strip-types --no-warnings scripts/test-projection.mjs
//
// `effectiveMode` is pure and is the ONLY place the dial is interpreted, so the
// capture-time path and the morning-letter path cannot drift apart. That
// mattered: they already had two separate copies of the same decision.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { effectiveMode } = await import("../lib/task-projection.ts");

test("a task WITH a due date goes straight to the board", () => {
  // Owner rule 2026-08-02: "all tasks that are noted as to do with a due date
  // in my brain should automatically exist in clickup."
  assert.equal(effectiveMode("ask", true), "auto");
  assert.equal(effectiveMode("auto", true), "auto");
});

test("an UNDATED task still waits for a tap", () => {
  // "Maybe someday" is exactly what should not silently populate a kanban.
  assert.equal(effectiveMode("ask", false), "ask");
  assert.equal(effectiveMode("auto", false), "auto");
});

test("'off' beats a due date — a kill switch a date can override is not one", () => {
  assert.equal(effectiveMode("off", true), "off");
  assert.equal(effectiveMode("off", false), "off");
});
