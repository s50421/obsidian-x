// Obsidian-X — typed edges must be explainable, and must not recreate the noise.
//
//   node --experimental-strip-types --no-warnings scripts/test-edges.mjs
//
// The derivation is pure, so the rules the owner chose in the workshop can be
// asserted directly against the real shapes that broke the old link system.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const {
  deriveEntityEdges,
  deriveTopicEdges,
  edgeEligibleItems,
  dedupeEdges,
  orderPair,
} = await import("../lib/edges.ts");

const ent = (id, name, kind, edge_eligible = true) => ({ id, name, kind, edge_eligible });
const link = (item_id, entity_id, raw_name = null) => ({ item_id, entity_id, raw_name });
const item = (id, title, tags, source = "telegram") => ({ id, title, tags, source });

test("every edge can say WHY in plain words", () => {
  // The brief's exit test: "the owner can tap any connection anywhere and see
  // WHY it exists in plain words."
  const edges = deriveEntityEdges(
    [ent("e1", "Dani", "person")],
    [link("a", "e1", "Dani"), link("b", "e1", "Dani")]
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].reason, "both mention Dani");
  assert.equal(edges[0].kind, "shared_person");
});

test("a merged entity's reason quotes the words each item actually used", () => {
  // After "mum" merges into "Beate Manhart", an item that only ever said "mum"
  // must not be explained with words it never contained.
  const edges = deriveEntityEdges(
    [ent("e1", "Beate Manhart", "person")],
    [link("a", "e1", "mum"), link("b", "e1", "Beate Manhart")]
  );
  assert.match(edges[0].reason, /both mention Beate Manhart/);
  assert.match(edges[0].reason, /"mum"/);
});

test("self and system entities never derive edges", () => {
  // The owner appears in nearly everything he writes; one hub node would join
  // his whole brain to itself.
  const edges = deriveEntityEdges(
    [ent("me", "David Michael Manhart", "person", false)],
    [link("a", "me"), link("b", "me"), link("c", "me")]
  );
  assert.deepEqual(edges, []);
});

test("an entity mentioned only once produces no edge", () => {
  assert.deepEqual(deriveEntityEdges([ent("e1", "Jake", "person")], [link("a", "e1")]), []);
});

test("undirected pairs collapse — (a,b) and (b,a) are one edge", () => {
  assert.deepEqual(orderPair("b", "a"), ["a", "b"]);
  const twice = dedupeEdges([
    { src: "a", dst: "b", kind: "shared_topic", reason: "x", weight: 1, entity_id: null, discovery: false },
    { src: "a", dst: "b", kind: "shared_topic", reason: "x", weight: 1, entity_id: null, discovery: false },
  ]);
  assert.equal(twice.length, 1);
});

test("broad and system tags never make a topic edge", () => {
  // 'food' sat on 5 of 23 unrelated shopping items; 'digest' on every
  // auto-generated summary. Neither means two items are related.
  const items = [
    item("a", "Bananas", ["food"]),
    item("b", "Tiramisu", ["food"]),
    item("c", "Digest 1", ["digest"]),
    item("d", "Digest 2", ["digest"]),
  ];
  assert.deepEqual(deriveTopicEdges(items), []);
});

test("a tag covering too much of the corpus is not a connection", () => {
  // A tag describing a third of the brain describes nothing about a pair in it.
  const many = Array.from({ length: 10 }, (_, i) => item(`i${i}`, `t${i}`, ["tech"]));
  assert.deepEqual(deriveTopicEdges(many), []);
});

test("a specific shared tag DOES connect", () => {
  const items = [
    item("a", "Father lawsuit", ["legal"]),
    item("b", "Court strategy docs", ["legal"]),
    ...Array.from({ length: 8 }, (_, i) => item(`x${i}`, `other${i}`, ["tech"])),
  ];
  const edges = deriveTopicEdges(items);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].reason, "both tagged legal");
});

test("machine-written items are excluded from the graph entirely", () => {
  // The first real run produced 13 edges, SIX of which only joined the three
  // daily digests to each other — and that grows as n² with one per day.
  const items = [
    item("a", "Daily digest — 1", ["legal"], "system"),
    item("b", "Daily digest — 2", ["legal"], "system"),
    item("c", "Real note", ["legal"], "telegram"),
  ];
  const eligible = edgeEligibleItems(items);
  assert.deepEqual(eligible.map((i) => i.id), ["c"]);
  assert.deepEqual(deriveTopicEdges(eligible), [], "one real item cannot pair with itself");
});
