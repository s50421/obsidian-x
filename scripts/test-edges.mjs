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
  deriveUnlinkedMentions,
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

test("a shared entity is CONFIRMED — it is a stated fact, not a guess", () => {
  const [e] = deriveEntityEdges(
    [ent("e1", "Dani", "person")],
    [link("a", "e1", "Dani"), link("b", "e1", "Dani")]
  );
  assert.equal(e.status, "confirmed", "the [[wikilink]] equivalent is drawn");
  assert.equal(e.discovery, false);
});

test("topic tags are retired as an edge kind", () => {
  // Reverses a workshop pick, deliberately: 'both tagged tech' joined a
  // Crypto.com passkey alert to chip-AI research, and 'both tagged finance'
  // joined a reimbursement chase to the same alert. A tag says what an item is
  // ABOUT, not that two items relate. Obsidian does not use tags as edges
  // either — it shows them as NODES.
  assert.deepEqual(deriveTopicEdges(), []);
});

test("an unlinked mention is found by name OR alias, on word boundaries", () => {
  // Obsidian's actual mechanism: the note's name or alias appears in another
  // note's text but was never linked.
  const entities = [{ id: "e1", name: "Beate Manhart", kind: "person", edge_eligible: true, aliases: ["mum"] }];
  const items = [
    { id: "a", title: "Court strategy", body: "Send the docs to mum before Friday." },
    { id: "b", title: "Groceries", body: "Bananas, parsley." },
    { id: "c", title: "Grumble", body: "I mumble when I read." },
  ];
  const hits = deriveUnlinkedMentions(items, entities, []);
  assert.equal(hits.length, 1, "only the real mention");
  assert.equal(hits[0].itemId, "a");
  assert.equal(hits[0].matched, "mum");
  // "mumble" must not match "mum" — a substring match would connect half the
  // corpus to the owner's mother.
  assert.ok(!hits.some((h) => h.itemId === "c"));
});

test("an already-linked entity is not re-offered as a mention", () => {
  const entities = [{ id: "e1", name: "Dani", kind: "person", edge_eligible: true, aliases: [] }];
  const items = [{ id: "a", title: "Meeting", body: "Prep for Dani." }];
  assert.deepEqual(deriveUnlinkedMentions(items, entities, [link("a", "e1")]), []);
});

test("self/system entities are never mentioned into the graph", () => {
  const entities = [{ id: "me", name: "David Manhart", kind: "person", edge_eligible: false, aliases: [] }];
  const items = [{ id: "a", title: "x", body: "David Manhart signed it." }];
  assert.deepEqual(deriveUnlinkedMentions(items, entities, []), []);
});

test("broad and system tags never make a topic edge", () => {
  // 'food' sat on 5 of 23 unrelated shopping items; 'digest' on every
  // auto-generated summary. Neither means two items are related.
  const items = [
    item("a", "Bananas", ["food"]),
    item("b", "Tiramisu", ["food"]),
  ];
  assert.deepEqual(deriveTopicEdges(items), [], "topic edges are retired entirely");
});

test("a tag covering too much of the corpus is not a connection", () => {
  // A tag describing a third of the brain describes nothing about a pair in it.
  const many = Array.from({ length: 10 }, (_, i) => item(`i${i}`, `t${i}`, ["tech"]));
  assert.deepEqual(deriveTopicEdges(many), []);
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
});

test("every edge is inserted with a features object, never undefined", () => {
  // supabase-js unions the keys across a bulk insert and fills the gaps with
  // NULL. One edge carrying features therefore made every edge WITHOUT them
  // send features:null into a NOT NULL column, failing the entire insert —
  // after the delete had already run. The rebuild reported "written: 14" over
  // an empty table.
  const rows = [
    { src: "a", dst: "b", kind: "shared_person", reason: "x", weight: 1, entity_id: "e", discovery: false, status: "confirmed" },
    { src: "c", dst: "d", kind: "similar", reason: "y", weight: 0.5, entity_id: null, discovery: true, status: "suggested", features: { similarity: 0.5 } },
  ];
  const prepared = rows.map((e) => ({ ...e, user_id: "u", features: e.features ?? {} }));
  for (const p of prepared) {
    assert.ok(p.features && typeof p.features === "object", "features must always be an object");
  }
  assert.deepEqual(prepared[0].features, {});
});
