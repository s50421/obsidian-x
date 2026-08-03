// Obsidian-X v4.2.3 — the agent layer.
//
//   node --experimental-strip-types --no-warnings scripts/test-agent.mjs
//
// The tool registry and the turn classifier are pure, so the parts that decide
// WHETHER the loop runs and WHAT it may do are testable without a model call.
// The loop itself is exercised live against the brief's 9 exit tests.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { AGENT_TOOLS, TOOLS_BY_NAME, toolSchemas, runTool } = await import("../lib/agent-tools.ts");
const { obviousKind } = await import("../lib/intent.ts");
const { collectItemIds } = await import("../lib/agent.ts");
const { toolArgs } = await import("../lib/openrouter.ts");

// --- HARD RULE ---------------------------------------------------------------

test("there is NO send tool, and there never will be", () => {
  // AGENTS.md rule 1. This test exists so that adding one is a deliberate act
  // that breaks a build, not a quiet afternoon's convenience.
  for (const t of AGENT_TOOLS) {
    assert.ok(
      !/^(send|email|reply_to|message_)/i.test(t.name),
      `tool "${t.name}" looks like a send capability`
    );
    assert.ok(
      !/\bsends?\b (an? )?(email|message|reply) (to|on behalf)/i.test(t.description),
      `tool "${t.name}" describes sending on the owner's behalf`
    );
  }
  assert.ok(TOOLS_BY_NAME.has("draft_reply"), "the draft path must exist instead");
});

test("draft_reply says plainly that nothing is sent", () => {
  const d = TOOLS_BY_NAME.get("draft_reply");
  assert.match(d.description, /never sends|no send tool/i);
});

// --- schema hygiene (v4.3's MCP server maps this same list) -------------------

test("every tool has a name, a description and a valid JSON-Schema object", () => {
  for (const t of AGENT_TOOLS) {
    assert.ok(t.name && /^[a-z][a-z0-9_]*$/.test(t.name), `bad tool name: ${t.name}`);
    assert.ok(t.description.length > 30, `${t.name} needs a real description`);
    assert.equal(t.parameters.type, "object", `${t.name} parameters must be an object schema`);
  }
});

test("schemas serialise into OpenRouter's tool format", () => {
  const s = toolSchemas();
  assert.equal(s.length, AGENT_TOOLS.length);
  for (const x of s) {
    assert.equal(x.type, "function");
    assert.ok(x.function.name && x.function.description && x.function.parameters);
  }
  // Names must be unique or the model cannot address them.
  assert.equal(new Set(s.map((x) => x.function.name)).size, s.length);
});

test("mutating tools are marked, so MCP can gate them later", () => {
  for (const n of ["clickup_create", "update_item", "save_memory", "complete_tasks"]) {
    assert.equal(TOOLS_BY_NAME.get(n).mutates, true, `${n} must be marked as mutating`);
  }
  for (const n of ["memory_search", "list_tasks", "clickup_status", "calendar"]) {
    assert.ok(!TOOLS_BY_NAME.get(n).mutates, `${n} must NOT be marked as mutating`);
  }
});

test("the structured tools tell the model NOT to use text search for them", () => {
  // The 2026-08-02 failure in one assertion: "are these in ClickUp?" went to
  // RAG, which searched note text for "ClickUp" and reported the task missing.
  assert.match(TOOLS_BY_NAME.get("memory_search").description, /Do NOT use for status|ClickUp/);
  assert.match(TOOLS_BY_NAME.get("clickup_status").description, /ONLY correct way|text search cannot see/i);
  assert.match(TOOLS_BY_NAME.get("list_tasks").description, /never semantic search/i);
});

test("recent_conversation_items is the documented first stop for pronouns", () => {
  assert.match(
    TOOLS_BY_NAME.get("recent_conversation_items").description,
    /ALWAYS call this first|these|all three/i
  );
});

// --- unknown tools + failures must not kill the turn --------------------------

test("an unknown tool returns an error instead of throwing", async () => {
  const r = await runTool({ admin: null, userId: "u", tz: "UTC" }, "nope", {});
  assert.match(r.error, /unknown tool/);
});

test("a throwing tool is caught and reported as data", async () => {
  // runTool must never propagate: an exception aborts the loop and the owner
  // gets silence instead of "I couldn't check that".
  const r = await runTool({ admin: null, userId: "u", tz: "UTC" }, "list_tasks", {});
  assert.ok("error" in r, "a null client must surface as an error result");
});

// --- referent tracking --------------------------------------------------------

test("item ids are harvested from any tool result shape", () => {
  const into = new Set();
  collectItemIds(
    {
      items: [{ id: "11111111-1111-1111-1111-111111111111", title: "a" }],
      nested: { results: [{ id: "22222222-2222-2222-2222-222222222222" }] },
      noise: { id: "not-a-uuid" },
    },
    into
  );
  assert.equal(into.size, 2);
  assert.ok(into.has("11111111-1111-1111-1111-111111111111"));
});

// --- the binary classifier ----------------------------------------------------

test("questions and pronouns are conversation, not capture", () => {
  // Every one of these is from the owner's real 2026-08-02 transcript.
  for (const t of [
    "Are these in ClickUp?",
    "Add all three to ClickUp",
    "what's on my board this week?",
    "move the rental car to Friday",
    "draft a reply to Jamie about rescheduling",
  ]) {
    assert.equal(obviousKind(t), "conversation", `"${t}" must reach the agent`);
  }
});

test("a plain braindump stays on the fast path", () => {
  // No model call, no tool loop — exit test 7 is a latency budget.
  for (const t of [
    "Buy olive oil and pick up the dry cleaning",
    "Idea: a newsletter about small-boat restoration",
    "Beate's lawyer said the hearing moved to October",
  ]) {
    assert.notEqual(obviousKind(t), "conversation", `"${t}" should not need the agent`);
  }
});

test("toolArgs survives an empty arguments string", () => {
  // Some providers omit `arguments` entirely for parameterless tools.
  assert.deepEqual(toolArgs({ id: "1", type: "function", function: { name: "x", arguments: "" } }), {});
  assert.deepEqual(toolArgs({ id: "1", type: "function", function: { name: "x", arguments: "{bad" } }), {});
  assert.deepEqual(
    toolArgs({ id: "1", type: "function", function: { name: "x", arguments: '{"a":1}' } }),
    { a: 1 }
  );
});

// --- split granularity (exit test 1) ------------------------------------------

const { SPLIT_RULES } = await import("../lib/title-standard.mjs");

test("the splitter is told that a to-do's unit is the ACTION, not the topic", () => {
  // The real failure: "call Jamie AND call Nate, both re my job plans" came
  // back as ONE task, because the old rule said related sub-points of one
  // subject are one item. Sharing a motive does not make two calls one job —
  // he cannot half-tick that, and after calling Jamie the rest must still show.
  assert.match(SPLIT_RULES, /THE UNIT IS THE ACTION, NOT THE TOPIC/);
  assert.match(SPLIT_RULES, /Call Nate Massi/, "the real transcript is the few-shot");
  assert.match(SPLIT_RULES, /Same person, same action/, "and the opposite case is pinned too");
});

// --- an empty reply must never be reported as an answer ------------------------

test("parallel split parts share a type", () => {
  // Live 2026-08-03: three to-dos came back as task / memory / task, so "Call
  // Nate Massi" silently became a memory and needed converting by hand. A
  // dictated past tense ("called Nate") is a transcription artefact, not a
  // record of something that happened.
  assert.match(SPLIT_RULES, /PARALLEL PARTS GET THE SAME TYPE/);
  assert.match(SPLIT_RULES, /TRANSCRIPTION artefact/);
});

test("the loop never claims confusion about work it actually did", async () => {
  // Live 2026-08-03 22:33: the model called a tool then returned an empty
  // message. The loop treated that as done and sent "I'm not sure what to do
  // with that" — while the owner's instruction was silently dropped.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8")
  );
  assert.match(src, /AN EMPTY REPLY IS NOT AN ANSWER/);
  assert.match(src, /emptyReplies/, "an empty turn must be retried, not accepted");
  // And the give-up text must reference what was done rather than feign confusion.
  assert.match(src, /I did some of that/);
  assert.ok(
    !/reply: turn\.content\.trim\(\) \|\| "I'm not sure/.test(src),
    "the old swallow-the-instruction fallback must be gone"
  );
});

// --- two live failures from 2026-08-03 23:35 ----------------------------------

test("a politely-phrased instruction is not a note", async () => {
  // "You can close Sandrine French pastry" was filed as a NOTE — the owner got
  // a "Save this?" card in reply to a direct instruction, because the opener
  // was second person rather than imperative.
  const { obviousKind } = await import("../lib/intent.ts");
  for (const t of [
    "You can close that ClickUp task",
    "You can close Sandrine French pastry",
    "Please archive the barbecue task",
    "Go ahead and mark it done",
    "Let's move that to Friday",
    "Close the rental car task",
  ]) {
    assert.equal(obviousKind(t), "conversation", `misread as capture: "${t}"`);
  }
  // …without swallowing genuine captures.
  for (const t of ["Buy milk and eggs tomorrow", "Idea: a bot that reads my mail"]) {
    assert.notEqual(obviousKind(t), "conversation", `over-caught: "${t}"`);
  }
});

test("the bot's own notifications are recorded, or 'that' has nothing to point at", async () => {
  // Live: the bot announced "ClickUp reopened → Sandrine French pastry", the
  // owner said "you can close that ClickUp task" one message later, and the
  // agent replied it had "nothing specific from our recent chat". The referent
  // was the message directly above — its own.
  const fs = await import("node:fs");
  const conv = fs.readFileSync(new URL("../lib/conversation.ts", import.meta.url), "utf8");
  assert.match(conv, /export async function notifyOwner/);
  assert.match(conv, /both sides have to be in the record/);
  // Only what actually landed may be recorded.
  assert.match(conv, /if \(delivered\)/);

  for (const f of [
    "../lib/clickup-sync.ts",
    "../app/api/cron/deck-nudge/route.ts",
    "../app/api/cron/followups/route.ts",
    "../app/api/cron/resurface/route.ts",
  ]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /notifyOwner\(/, `${f} still speaks without remembering it`);
  }
});
