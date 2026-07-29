// Obsidian-X v4.0 W2 — end-to-end test for the APPLY half: what happens when
// David swipes right on a retitle or a split card in the W3 deck.
//
//   node --experimental-strip-types scripts/test-apply-proposal.mjs
//   (or simply: npm run test:w2)
//
// lib/proposals.ts is TypeScript and imports through the "@/" alias, so this
// runs it under node's type-stripping with a small resolver hook. It talks to a
// minimal in-process PostgREST emulator through the REAL @supabase/supabase-js
// client, so the query builder chains are exercised exactly as they are in prod.
//
// This is the path that mutates the corpus, so the assertions are about damage
// control as much as function: nothing is deleted, the original survives a
// split, and every change carries a before-state in the audit trail.

import assert from "node:assert/strict";
import http from "node:http";
import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const USER = "00000000-0000-0000-0000-0000000000ff";

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const db = {
  items: [
    {
      id: "20000000-0000-0000-0000-000000000001",
      user_id: USER,
      type: "note",
      title: "1. After pressing F9, all of the summary statistics changed",
      body: "After pressing F9, all of the summary statistics changed slightly.",
      raw: "1. After pressing F9…",
      tags: ["apple-notes", "school"],
      priority: "medium",
      source: "apple-notes",
      status: "archived",
      due_at: null,
      entities: [],
      links: [],
      created_at: "2024-03-02T10:00:00Z",
      valid_to: null,
      superseded_by: null,
      vault_path: null,
      sensitive: false,
      needs_review: true,
      review_reason: "possible-junk",
      embedding_v2: null,
    },
    {
      id: "20000000-0000-0000-0000-000000000002",
      user_id: USER,
      type: "task",
      title: "buy olive oil, ask v-bank about the term sheet, book Lisbon",
      body: "buy olive oil\nask v-bank about the term sheet\nbook flights to Lisbon in October",
      raw: null,
      tags: ["apple-notes"],
      priority: "high",
      source: "apple-notes",
      status: "archived",
      due_at: null,
      entities: [],
      links: [],
      created_at: "2024-04-02T10:00:00Z",
      valid_to: null,
      superseded_by: null,
      vault_path: null,
      sensitive: false,
      needs_review: false,
      review_reason: null,
      embedding_v2: null,
    },
  ],
  proposals: [
    {
      id: "30000000-0000-0000-0000-000000000001",
      user_id: USER,
      kind: "retitle",
      status: "pending",
      title: "Excel recalculation — why F9 shifts the summary stats",
      source_item_id: "20000000-0000-0000-0000-000000000001",
      result: null,
      decided_at: null,
      payload: {
        itemId: "20000000-0000-0000-0000-000000000001",
        oldTitle: "1. After pressing F9, all of the summary statistics changed",
        newTitle: "Excel recalculation — why F9 shifts the summary stats",
        newType: "reference",
        newTags: ["school", "tech"],
        dueAt: null,
        entities: [{ name: "Excel", kind: "org" }],
        confidence: 0.92,
        reason: "A note about Excel recalculating volatile formulas on F9.",
        junkScore: 1,
      },
    },
    {
      id: "30000000-0000-0000-0000-000000000002",
      user_id: USER,
      kind: "split",
      status: "pending",
      title: "buy olive oil, ask v-bank about the term sheet, book Lisbon",
      source_item_id: "20000000-0000-0000-0000-000000000002",
      result: null,
      decided_at: null,
      payload: {
        itemId: "20000000-0000-0000-0000-000000000002",
        oldTitle: "buy olive oil, ask v-bank about the term sheet, book Lisbon",
        parts: [
          { title: "Olive oil and pantry restock", body: "buy olive oil", type: "shopping", tags: ["food"] },
          { title: "V-Bank term sheet — open questions", body: "ask v-bank about the term sheet", type: "task", tags: ["finance"] },
          { title: "Lisbon flights for October", body: "book flights to Lisbon in October", type: "task", tags: ["travel"] },
        ],
        confidence: 0.9,
        reason: "Three unrelated errands in one note.",
        junkScore: 0,
      },
    },
    {
      id: "30000000-0000-0000-0000-000000000003",
      user_id: USER,
      kind: "retitle",
      status: "approved",
      title: "already done",
      source_item_id: "20000000-0000-0000-0000-000000000001",
      result: {},
      decided_at: "2026-07-01T00:00:00Z",
      payload: { itemId: "20000000-0000-0000-0000-000000000001", newTitle: "x", newType: "note", newTags: [], confidence: 1, reason: "" },
    },
  ],
  audit: [],
};

const deleted = [];
let idSeq = 0;
const nextId = () => `40000000-0000-0000-0000-00000000000${++idSeq}`;

// ---------------------------------------------------------------------------
// Minimal PostgREST emulator (supports the single/maybeSingle + representation
// conventions supabase-js relies on).
// ---------------------------------------------------------------------------
function applyFilters(rows, params) {
  let out = rows;
  for (const [key, value] of params.entries()) {
    if (["select", "order", "limit", "offset", "columns"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter((r) => String(r[key]) === value.slice(3));
    else if (value.startsWith("neq.")) out = out.filter((r) => String(r[key]) !== value.slice(4));
    else if (value === "is.null") out = out.filter((r) => r[key] === null || r[key] === undefined);
    else if (value.startsWith("in.(")) {
      const ids = value
        .slice(4, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""));
      out = out.filter((r) => ids.includes(String(r[key])));
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const table = url.pathname.replace("/rest/v1/", "");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const wantsObject = (req.headers.accept ?? "").includes("pgrst.object");
    const wantsRepresentation = (req.headers.prefer ?? "").includes("return=representation");
    db[table] = db[table] ?? [];

    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const respondRows = (rows) => {
      if (!wantsObject) return send(200, rows);
      if (rows.length === 1) return send(200, rows[0]);
      return send(406, {
        code: "PGRST116",
        message: `JSON object requested, multiple (or no) rows returned`,
        details: `Results contain ${rows.length} rows`,
      });
    };

    if (req.method === "GET") return respondRows(applyFilters(db[table], url.searchParams));

    if (req.method === "POST") {
      const payload = JSON.parse(raw || "{}");
      const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: nextId(), ...r }));
      db[table].push(...rows);
      return wantsRepresentation ? respondRows(rows) : send(201, []);
    }

    if (req.method === "PATCH") {
      const patch = JSON.parse(raw || "{}");
      const rows = applyFilters(db[table], url.searchParams);
      for (const r of rows) Object.assign(r, patch);
      return wantsRepresentation ? respondRows(rows) : send(200, []);
    }

    if (req.method === "DELETE") {
      const rows = applyFilters(db[table], url.searchParams);
      deleted.push(...rows);
      db[table] = db[table].filter((r) => !rows.includes(r));
      return send(200, []);
    }

    send(405, { message: "not emulated" });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const admin = createClient(`http://127.0.0.1:${port}`, "service-role-test-key", {
  auth: { persistSession: false },
});

// A deterministic stand-in for the OpenAI embedder (no network, no key).
const embedded = [];
const fakeEmbed = async (text) => {
  embedded.push(text);
  return Array.from({ length: 1024 }, (_, i) => ((text.length + i) % 17) / 17);
};

const { applyProposal, rejectProposalById } = await import("@/lib/proposals.ts");

// ---------------------------------------------------------------------------
const fails = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  NOT OK  ${name}\n        ${e.message.split("\n").join("\n        ")}`);
  }
};
const item = (suffix) => db.items.find((i) => i.id.endsWith(suffix));

console.log("\nlib/proposals.ts applyProposal — retitle / split (real supabase-js, fake PostgREST)\n");

// --- retitle ----------------------------------------------------------------
const r1 = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000001", { embed: fakeEmbed });

check("retitle: reports success", () => {
  assert.equal(r1.ok, true, r1.message);
  assert.match(r1.message, /Excel recalculation/);
});

check("retitle: title, type and tags are written in place", () => {
  const it = item("001");
  assert.equal(it.title, "Excel recalculation — why F9 shifts the summary stats");
  assert.equal(it.type, "reference");
  assert.deepEqual(it.tags.sort(), ["apple-notes", "school", "tech"].sort());
});

check("retitle: the item KEEPS its id — links and refs stay valid", () => {
  assert.equal(db.items.filter((i) => i.id.endsWith("001")).length, 1);
  assert.equal(item("001").valid_to, null, "a retitle is not a supersede");
  assert.equal(item("001").superseded_by, null);
});

check("retitle: 'apple-notes' provenance survives re-tagging", () => {
  assert.ok(item("001").tags.includes("apple-notes"), "the import deck's source filter depends on this");
});

check("retitle: the review flag that put it in the deck is cleared", () => {
  assert.equal(item("001").needs_review, false);
  assert.equal(item("001").review_reason, null);
});

check("retitle: the item was re-embedded on the NEW title", () => {
  assert.equal(embedded.length >= 1, true);
  assert.match(embedded[0], /^Excel recalculation — why F9/);
  assert.equal(item("001").embedding_v2.length, 1024);
});

check("retitle: the proposal is closed with a result", () => {
  const p = db.proposals.find((x) => x.id.endsWith("0001"));
  assert.equal(p.status, "approved");
  assert.ok(p.decided_at);
  assert.equal(p.result.title, "Excel recalculation — why F9 shifts the summary stats");
});

check("retitle: the audit entry carries the full before-state (reversible)", () => {
  const a = db.audit.find((x) => x.action === "retitle_applied");
  assert.ok(a, "no retitle_applied audit entry");
  assert.equal(a.detail.before.title, "1. After pressing F9, all of the summary statistics changed");
  assert.deepEqual(a.detail.before.tags, ["apple-notes", "school"]);
  assert.equal(a.detail.after.title, "Excel recalculation — why F9 shifts the summary stats");
  assert.equal(a.actor, "user");
});

const r1b = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000001", { embed: fakeEmbed });
check("retitle: a second approve is a no-op", () => {
  assert.equal(r1b.ok, false);
  assert.equal(r1b.alreadyHandled, true);
});

// --- split ------------------------------------------------------------------
const before = db.items.length;
const r2 = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000002", { embed: fakeEmbed });

check("split: reports the three new memories", () => {
  assert.equal(r2.ok, true, r2.message);
  assert.match(r2.message, /Split into 3/);
});

check("split: three items were created", () => {
  assert.equal(db.items.length, before + 3);
  const titles = db.items.filter((i) => i.id.startsWith("4")).map((i) => i.title);
  assert.deepEqual(titles, [
    "Olive oil and pantry restock",
    "V-Bank term sheet — open questions",
    "Lisbon flights for October",
  ]);
});

check("split: each part carries its own type, tags and provenance", () => {
  const parts = db.items.filter((i) => i.id.startsWith("4"));
  assert.equal(parts[0].type, "shopping");
  assert.equal(parts[1].type, "task");
  for (const p of parts) {
    assert.equal(p.source, "apple-notes");
    assert.ok(p.tags.includes("apple-notes"), "provenance is preserved on every part");
    assert.equal(p.priority, "high", "the original's priority is inherited");
    assert.equal(p.created_at, "2024-04-02T10:00:00Z", "a memory is as old as its capture");
    assert.equal(p.status, "open");
  }
});

check("split: parts are cross-linked to each other", () => {
  const parts = db.items.filter((i) => i.id.startsWith("4"));
  for (const p of parts) {
    assert.equal(p.links.length, 2);
    assert.ok(!p.links.includes(p.id));
  }
});

check("split: every part got its own embedding", () => {
  const parts = db.items.filter((i) => i.id.startsWith("4"));
  for (const p of parts) assert.equal(p.embedding_v2.length, 1024);
});

check("split: the original is SUPERSEDED, never deleted or edited", () => {
  const orig = item("002");
  assert.ok(orig, "the original row still exists");
  assert.equal(orig.body, "buy olive oil\nask v-bank about the term sheet\nbook flights to Lisbon in October");
  assert.equal(orig.title, "buy olive oil, ask v-bank about the term sheet, book Lisbon");
  assert.equal(orig.status, "archived");
  assert.ok(orig.valid_to, "valid_to marks the bi-temporal close-out");
  assert.ok(String(orig.superseded_by).startsWith("4"), "superseded_by points at part 1");
  assert.equal(deleted.length, 0, "NOTHING may ever be deleted");
});

check("split: the audit entry names every part (reversible)", () => {
  const a = db.audit.find((x) => x.action === "split_applied");
  assert.ok(a);
  assert.equal(a.detail.parts.length, 3);
  assert.equal(a.detail.before.status, "archived");
  assert.equal(a.detail.titles.length, 3);
});

// --- guards -----------------------------------------------------------------
const missing = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000009", { embed: fakeEmbed });
check("a proposal that no longer exists is handled, not thrown", () => {
  assert.equal(missing.ok, false);
  assert.equal(missing.alreadyHandled, true);
});

const decided = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000003", { embed: fakeEmbed });
check("an already-decided proposal is refused", () => {
  assert.equal(decided.ok, false);
  assert.equal(decided.alreadyHandled, true);
});

// A retitle whose payload was edited to an unusable title in the deck.
db.proposals.push({
  id: "30000000-0000-0000-0000-000000000004",
  user_id: USER,
  kind: "retitle",
  status: "pending",
  title: "**",
  source_item_id: "20000000-0000-0000-0000-000000000001",
  payload: { itemId: "20000000-0000-0000-0000-000000000001", newTitle: "**", newType: "note", newTags: [], confidence: 1, reason: "" },
});
const emptyTitle = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000004", { embed: fakeEmbed });
check("an edited-to-empty title is refused and the item is untouched", () => {
  assert.equal(emptyTitle.ok, false);
  assert.match(emptyTitle.message, /empty after cleanup/);
  assert.equal(item("001").title, "Excel recalculation — why F9 shifts the summary stats");
  assert.equal(db.proposals.find((p) => p.id.endsWith("0004")).status, "pending", "left pending so it can be edited and retried");
});

// A split proposal pointing at an item that was deleted between propose and approve.
db.proposals.push({
  id: "30000000-0000-0000-0000-000000000005",
  user_id: USER,
  kind: "split",
  status: "pending",
  title: "gone",
  source_item_id: "20000000-0000-0000-0000-0000000000ff",
  payload: { itemId: "20000000-0000-0000-0000-0000000000ff", parts: [], confidence: 1, reason: "" },
});
const gone = await applyProposal(admin, USER, "30000000-0000-0000-0000-000000000005", { embed: fakeEmbed });
check("a split whose item vanished fails cleanly", () => {
  assert.equal(gone.ok, false);
  assert.match(gone.message, /no longer exists/);
});

// Rejecting must leave everything alone.
db.proposals.push({
  id: "30000000-0000-0000-0000-000000000006",
  user_id: USER,
  kind: "retitle",
  status: "pending",
  title: "Some other title entirely",
  source_item_id: "20000000-0000-0000-0000-000000000001",
  payload: { itemId: "20000000-0000-0000-0000-000000000001", newTitle: "Some other title entirely", newType: "note", newTags: [], confidence: 1, reason: "" },
});
const titleBefore = item("001").title;
const rejected = await rejectProposalById(admin, USER, "30000000-0000-0000-0000-000000000006");
check("rejecting a retitle leaves the item completely untouched", () => {
  assert.equal(rejected, true);
  assert.equal(item("001").title, titleBefore);
  assert.equal(db.proposals.find((p) => p.id.endsWith("0006")).status, "rejected");
});

server.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(", ")}` : `\nall checks passed`);
process.exit(fails.length ? 1 : 0);
