// Obsidian-X — what the graph is given to draw.
//
//   node --experimental-strip-types --no-warnings scripts/test-graph-data.mjs
//
// The renderer itself can only be judged by eye, but WHAT IT RECEIVES is pure
// and is where the meaning lives — entity nodes, component ordering, and the
// rule that stops the same relationship being drawn twice.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { labelComponents } = await import("../lib/graph-data.ts");

test("components are numbered largest-first, so component 0 is the default frame", () => {
  // The brief: "default view frames the largest connected component, not the
  // whole sparse cloud."
  const ids = ["a", "b", "c", "d", "e", "f"];
  const links = [
    { source: "a", target: "b" },
    { source: "b", target: "c" }, // {a,b,c} — the big one
    { source: "d", target: "e" }, // {d,e}
    // f is an orphan
  ];
  const { component, largest } = labelComponents(ids, links);
  assert.equal(largest, 3);
  assert.equal(component.get("a"), 0);
  assert.equal(component.get("b"), 0);
  assert.equal(component.get("c"), 0);
  assert.equal(component.get("d"), 1);
  assert.equal(component.get("e"), 1);
  assert.equal(component.get("f"), 2, "an orphan is its own component");
});

test("a graph with no links is all orphans", () => {
  const { component, largest } = labelComponents(["a", "b"], []);
  assert.equal(largest, 1);
  assert.notEqual(component.get("a"), component.get("b"));
});

test("component labelling is undirected", () => {
  // Edges are stored src<dst, but reachability must not depend on direction.
  const { largest } = labelComponents(["a", "b", "c"], [
    { source: "b", target: "a" },
    { source: "c", target: "b" },
  ]);
  assert.equal(largest, 3);
});

test("an empty graph does not crash the framing", () => {
  const { largest } = labelComponents([], []);
  assert.equal(largest, 0);
});
