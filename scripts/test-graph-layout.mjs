// Obsidian-X — the graph must stay legible when it is SPARSE.
//
//   node --experimental-strip-types --no-warnings scripts/test-graph-layout.mjs
//
// On 2026-08-02 the graph rendered "23 nodes · 0 links" as an apparently empty
// canvas with one stray label. Two causes: the page still read the purged
// items.links column, and — the reason it looked EMPTY rather than merely
// unconnected — repulsion is the only force on an isolated node, so the nodes
// drifted thousands of units apart and the auto-fit zoomed out until every node
// was sub-pixel. These assert the layout stays bounded.

import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { layout, MAX_RADIUS } = await import("../app/graph/force-layout.ts");

const nodes = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `t${i}`, type: "note" }));

function spread(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

test("a graph with NO edges stays inside a viewable field", () => {
  const pts = layout(nodes(23), []);
  assert.equal(pts.length, 23);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "no NaN positions");
  }
  // The failure mode: unbounded drift, then an auto-fit that renders every node
  // sub-pixel. 2 * MAX_RADIUS is the widest the field may ever be.
  assert.ok(spread(pts) <= MAX_RADIUS * 2 + 1, `sparse graph must stay bounded (got ${Math.round(spread(pts))})`);
});

test("nodes do not all collapse onto one point", () => {
  // The other way a graph reads as "one node": everything stacked at centre.
  const pts = layout(nodes(23), []);
  assert.ok(spread(pts) > 200, `nodes must be distinguishable (got ${Math.round(spread(pts))})`);
});

test("a connected graph is still bounded", () => {
  const n = nodes(23);
  const edges = [
    { source: "n0", target: "n1" },
    { source: "n1", target: "n2" },
    { source: "n3", target: "n4" },
    { source: "n5", target: "n6" },
    { source: "n7", target: "n8" },
    { source: "n9", target: "n10" },
    { source: "n11", target: "n12" },
  ];
  const pts = layout(n, edges);
  assert.ok(spread(pts) <= MAX_RADIUS * 2 + 1);
  for (const p of pts) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test("layout is deterministic — SSR and client must agree", () => {
  // Math.random would hydrate differently on server and client.
  const a = layout(nodes(12), []);
  const b = layout(nodes(12), []);
  assert.deepEqual(a, b);
});
