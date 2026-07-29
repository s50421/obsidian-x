// Obsidian-X v4.0 W2 — end-to-end test for scripts/reprocess-corpus.mjs.
//
//   node scripts/test-reprocess-e2e.mjs
//
// There is no live database and no network in the build environment, so this
// stands up:
//   • a minimal PostgREST emulator on localhost (the handful of endpoints the
//     script actually uses), seeded with fixtures modelled on the real corpus;
//   • a fake OpenRouter that returns canned classifications per item.
//
// Then it runs the REAL script in --run mode and asserts on every write it
// made: which proposals were created and with what payload, which items were
// archived as junk, which were flagged, and that a second pass is a no-op
// (resumability). This is the closest thing to a live rehearsal we can get
// before David runs it on his Mac.

import assert from "node:assert/strict";
import http from "node:http";

// ---------------------------------------------------------------------------
// Fixtures — one of each outcome the pass has to get right.
// ---------------------------------------------------------------------------
const USER = "00000000-0000-0000-0000-0000000000ff";
const seedItems = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    user_id: USER,
    title: "1. After pressing F9, all of the summary statistics changed",
    body: "After pressing F9, all of the summary statistics changed slightly.",
    raw: "1. After pressing F9, all of the summary statistics changed slightly.",
    source: "apple-notes",
    status: "archived",
    tags: ["apple-notes"],
    created_at: "2024-03-02T10:00:00Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    user_id: USER,
    title: "@everyone I hope you're all doing well and enjoying the break",
    body: "@everyone I hope you're all doing well and enjoying the break. Next meeting is on the 14th, bring your slides.",
    raw: null,
    source: "apple-notes",
    status: "archived",
    tags: ["apple-notes"],
    created_at: "2024-05-11T10:00:00Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    user_id: USER,
    title: "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47",
    body: "1,200,000 = 0.5 x sell + 0.5 x sell x 0.47",
    raw: null,
    source: "apple-notes",
    status: "archived",
    tags: ["apple-notes"],
    created_at: "2024-06-01T10:00:00Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000004",
    user_id: USER,
    title: "asdf",
    body: "asdf",
    raw: null,
    source: "apple-notes",
    status: "archived",
    tags: ["apple-notes"],
    created_at: "2024-06-02T10:00:00Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    user_id: USER,
    title: "buy olive oil, ask v-bank about the term sheet, book Lisbon",
    body: "buy olive oil\nask v-bank about the term sheet\nbook flights to Lisbon in October",
    raw: null,
    source: "typed",
    status: "open",
    tags: [],
    created_at: "2026-07-20T10:00:00Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000006",
    user_id: USER,
    title: "Half a thought",
    body: "Maybe the pricing thing. Not sure what I meant here anymore.",
    raw: null,
    source: "apple-notes",
    status: "archived",
    tags: ["apple-notes"],
    created_at: "2024-08-02T10:00:00Z",
  },
  {
    // Already decided by an earlier pass — must be skipped, not re-classified.
    id: "10000000-0000-0000-0000-000000000007",
    user_id: USER,
    title: "Already proposed — do not touch",
    body: "This one already has a pending retitle proposal.",
    raw: null,
    source: "apple-notes",
    status: "archived",
    tags: ["apple-notes"],
    created_at: "2024-09-02T10:00:00Z",
  },
  {
    // A generated digest — must never be re-processed.
    id: "10000000-0000-0000-0000-000000000008",
    user_id: USER,
    title: "Daily digest 2026-07-01",
    body: "Your day: 3 tasks…",
    raw: null,
    source: "system",
    status: "open",
    tags: [],
    created_at: "2026-07-01T10:00:00Z",
  },
];

// What the (fake) model says about each item, keyed by item id suffix.
const modelReplies = {
  "001": {
    confidence: 0.92,
    junk_score: 1,
    title: "Excel recalculation — why F9 shifts the summary stats",
    type: "reference",
    tags: ["school", "tech"],
    reason: "A note about Excel recalculating volatile formulas on F9.",
  },
  "002": {
    confidence: 0.9,
    junk_score: 2,
    title: "Club announcement — break greeting and next meeting",
    type: "note",
    tags: ["people", "events"],
    reason: "A group message with a meeting date in it.",
  },
  "003": {
    confidence: 0.88,
    junk_score: 9,
    junk_reason: "unlabelled arithmetic with no context",
    title: "Deal payout math — 1.2M split scenario",
    type: "note",
    tags: ["finance"],
    reason: "Bare arithmetic; nothing says what is being valued.",
  },
  "004": { confidence: 0.99, junk_score: 10, junk_reason: "test string", title: "Test scratch note", type: "note", tags: [] },
  "005": {
    confidence: 0.9,
    junk_score: 0,
    title: "Errands — pantry, V-Bank and Lisbon flights",
    type: "task",
    tags: ["admin"],
    reason: "Three unrelated errands in one dump.",
    split: [
      { title: "Olive oil and pantry restock", body: "buy olive oil", type: "shopping", tags: ["food"] },
      { title: "V-Bank term sheet — open questions", body: "ask v-bank about the term sheet", type: "task", tags: ["finance", "v-bank"] },
      { title: "Lisbon flights for October", body: "book flights to Lisbon in October", type: "task", tags: ["travel"] },
    ],
  },
  "006": {
    confidence: 0.8,
    junk_score: 6,
    junk_reason: "a fragment the owner may no longer recognise",
    title: "Unfinished thought about the pricing model",
    type: "note",
    tags: ["business"],
    reason: "A fragment about pricing with nothing decided.",
  },
};

// ---------------------------------------------------------------------------
// A minimal PostgREST emulator over the fixtures.
// ---------------------------------------------------------------------------
const db = {
  items: seedItems.map((i) => ({ ...i, valid_to: null, needs_review: false, review_reason: null })),
  proposals: [
    {
      id: "p-existing",
      kind: "retitle",
      status: "pending",
      source_item_id: "10000000-0000-0000-0000-000000000007",
    },
  ],
  audit: [],
  llm_usage: [],
};
const writes = { proposals: [], audit: [], itemPatches: [], llm_usage: [] };

function parseIn(value) {
  // in.("a","b") / in.(a,b)
  const inner = value.replace(/^in\.\(/, "").replace(/\)$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function selectItems(params) {
  let rows = db.items;
  if (params.get("source")?.startsWith("neq.")) {
    const v = params.get("source").slice(4);
    rows = rows.filter((r) => r.source !== v);
  }
  if (params.get("source")?.startsWith("eq.")) {
    const v = params.get("source").slice(3);
    rows = rows.filter((r) => r.source === v);
  }
  if (params.get("valid_to") === "is.null") rows = rows.filter((r) => r.valid_to === null);
  const tagsFilter = params.get("tags");
  if (tagsFilter?.startsWith("not.cs.")) {
    const wanted = JSON.parse(tagsFilter.slice(7).replace(/^\{/, "[").replace(/\}$/, "]"));
    rows = rows.filter((r) => !wanted.every((w) => (r.tags ?? []).includes(w)));
  }
  const idFilter = params.get("id");
  if (idFilter?.startsWith("gt.")) rows = rows.filter((r) => r.id > idFilter.slice(3));
  if (idFilter?.startsWith("in.")) {
    const ids = parseIn(idFilter);
    rows = rows.filter((r) => ids.includes(r.id));
  }
  rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const limit = Number(params.get("limit") ?? 1000);
  return rows.slice(0, limit);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const table = url.pathname.replace("/rest/v1/", "");
  const params = url.searchParams;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, payload, headers = {}) => {
      const text = payload === null ? "" : JSON.stringify(payload);
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(text);
    };

    if (req.method === "GET" || req.method === "HEAD") {
      let rows;
      if (table === "items") rows = selectItems(params);
      else if (table === "proposals") {
        const ids = params.get("source_item_id")?.startsWith("in.") ? parseIn(params.get("source_item_id")) : null;
        rows = db.proposals.filter((p) => !ids || ids.includes(p.source_item_id));
      } else if (table === "audit") {
        const ids = params.get("item_id")?.startsWith("in.") ? parseIn(params.get("item_id")) : null;
        const action = params.get("action")?.slice(3);
        rows = db.audit.filter((a) => (!ids || ids.includes(a.item_id)) && (!action || a.action === action));
      } else rows = [];

      const wantsCount = (req.headers.prefer ?? "").includes("count=exact");
      const headers = wantsCount ? { "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` } : {};
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }
      return send(200, rows, headers);
    }

    if (req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const row of rows) {
        db[table] = db[table] ?? [];
        db[table].push(row);
        writes[table]?.push(row);
      }
      return send(201, []);
    }

    if (req.method === "PATCH") {
      const patch = JSON.parse(body || "{}");
      const idFilter = params.get("id");
      const id = idFilter?.startsWith("eq.") ? idFilter.slice(3) : null;
      const row = db.items.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      writes.itemPatches.push({ id, patch });
      return send(200, []);
    }

    send(405, { message: "not emulated" });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---------------------------------------------------------------------------
// Fake OpenRouter: canned replies, and a record of what was asked.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const modelCalls = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("openrouter.ai")) return realFetch(input, init);
  const sent = JSON.parse(init.body);
  const userMsg = sent.messages[1].content;
  modelCalls.push({ system: sent.messages[0].content, user: userMsg });
  const key = Object.keys(modelReplies).find((k) => userMsg.includes(k) || userMsg.includes(seedTitleFor(k)));
  const reply = modelReplies[key] ?? { confidence: 0.3, junk_score: 0, title: "" };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 1400, completion_tokens: 180, cost: 0.0019 },
    }),
    text: async () => "",
  };
};
function seedTitleFor(k) {
  const it = seedItems.find((s) => s.id.endsWith(k));
  return it ? it.title : " ";
}

// ---------------------------------------------------------------------------
// Run the real script.
// ---------------------------------------------------------------------------
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_CLASSIFY_MODEL = "claude-haiku-4.5";
process.argv = ["node", "scripts/reprocess-corpus.mjs", "--run", "--concurrency", "2"];

const log = [];
const realLog = console.log;
console.log = (...a) => log.push(a.join(" "));
await import("./reprocess-corpus.mjs");
console.log = realLog;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const fails = [];
const check = (name, fn) => {
  try {
    fn();
    realLog(`  ok  ${name}`);
  } catch (e) {
    fails.push(name);
    realLog(`  NOT OK  ${name}\n        ${e.message.split("\n").join("\n        ")}`);
  }
};

realLog("\nscripts/reprocess-corpus.mjs --run (fake PostgREST + fake model)\n");

check("the generated digest was never classified", () => {
  assert.ok(!modelCalls.some((c) => c.user.includes("Daily digest")), "source=system must be skipped");
});

check("the already-decided item was skipped (resumability)", () => {
  assert.ok(!modelCalls.some((c) => c.user.includes("Already proposed")));
});

check("six items were classified", () => {
  assert.equal(modelCalls.length, 6, `classified ${modelCalls.length}`);
});

check("the raw first line went to the model, not just the title", () => {
  const call = modelCalls.find((c) => c.user.includes("F9"));
  assert.match(call.user, /--- note ---/);
  assert.match(call.system, /TITLE RULES/);
});

check("retitle proposals were written with the deck's payload contract", () => {
  const retitles = writes.proposals.filter((p) => p.kind === "retitle");
  assert.equal(retitles.length, 3, `got ${retitles.length}`); // items 001, 002, 006
  const f9 = retitles.find((p) => p.payload.itemId.endsWith("001"));
  assert.equal(f9.status, "pending");
  assert.equal(f9.source, "reprocess");
  assert.equal(f9.title, "Excel recalculation — why F9 shifts the summary stats");
  assert.equal(f9.payload.newTitle, "Excel recalculation — why F9 shifts the summary stats");
  assert.equal(f9.payload.oldTitle, seedItems[0].title);
  assert.equal(f9.payload.newType, "reference");
  assert.deepEqual(f9.payload.newTags, ["school", "tech"]);
  assert.equal(typeof f9.payload.confidence, "number");
  assert.equal(f9.payload.junkScore, 1);
});

check("the @everyone title was cleaned before it was ever proposed", () => {
  const p = writes.proposals.find((x) => x.payload.itemId.endsWith("002"));
  assert.ok(!/@/.test(p.payload.newTitle), p.payload.newTitle);
});

check("the 3-topic braindump became a split proposal with 3 parts", () => {
  const split = writes.proposals.filter((p) => p.kind === "split");
  assert.equal(split.length, 1);
  assert.equal(split[0].payload.parts.length, 3);
  assert.deepEqual(
    split[0].payload.parts.map((p) => p.title),
    ["Olive oil and pantry restock", "V-Bank term sheet — open questions", "Lisbon flights for October"]
  );
  assert.deepEqual(split[0].payload.parts[1].tags, ["finance", "v-bank"], "1 free-form tag survives the taxonomy");
});

check("confident junk was archived + tagged, and audited so it is reversible", () => {
  const junked = db.items.filter((i) => (i.tags ?? []).includes("junk"));
  assert.deepEqual(junked.map((i) => i.id.slice(-3)).sort(), ["003", "004"]);
  for (const i of junked) assert.equal(i.status, "archived");
  const entries = writes.audit.filter((a) => a.action === "junk_archived");
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => typeof e.detail.junk_score === "number"));
  assert.ok(entries.every((e) => e.detail.previous_status && Array.isArray(e.detail.previous_tags)));
  assert.equal(entries.every((e) => e.detail.ruthlessness === 8), true);
});

check("junk items got NO proposal — a swipe is not spent on them", () => {
  for (const p of writes.proposals) {
    assert.ok(!p.payload.itemId.endsWith("003"));
    assert.ok(!p.payload.itemId.endsWith("004"));
  }
});

check("uncertain junk (score 6) was KEPT, flagged 'possible-junk', and still proposed", () => {
  const item6 = db.items.find((i) => i.id.endsWith("006"));
  assert.equal(item6.status, "archived", "status untouched");
  assert.ok(!(item6.tags ?? []).includes("junk"));
  assert.equal(item6.needs_review, true);
  assert.equal(item6.review_reason, "possible-junk");
  assert.ok(writes.proposals.some((p) => p.payload.itemId.endsWith("006")));
});

check("no item title was overwritten anywhere — proposals only", () => {
  for (const p of writes.itemPatches) {
    assert.ok(!("title" in p.patch), `patched title on ${p.id}`);
    assert.ok(!("body" in p.patch), `patched body on ${p.id}`);
  }
  for (const seed of seedItems) {
    const now = db.items.find((i) => i.id === seed.id);
    assert.equal(now.title, seed.title);
  }
});

check("every handled item logged a reprocess_pass entry", () => {
  const passes = writes.audit.filter((a) => a.action === "reprocess_pass");
  assert.equal(passes.length, 6);
  assert.ok(passes.every((p) => p.detail.outcome && p.detail.model === "claude-haiku-4.5"));
});

check("the run's spend was recorded", () => {
  assert.equal(writes.llm_usage.length, 1);
  assert.equal(writes.llm_usage[0].operation, "reprocess_corpus");
  assert.equal(writes.llm_usage[0].prompt_tokens, 6 * 1400);
});

check("the summary reported what it did", () => {
  const out = log.join("\n");
  assert.match(out, /proposals — retitle: 3/);
  assert.match(out, /proposals — split:   1/);
  assert.match(out, /junk archived:       2/);
});

// --- second pass: nothing left to do ---------------------------------------
const callsBefore = modelCalls.length;
writes.proposals.length = 0;
writes.audit.length = 0;
process.argv = ["node", "scripts/reprocess-corpus.mjs", "--run"];
console.log = () => {};
await import(`./reprocess-corpus.mjs?pass=2`);
console.log = realLog;

check("a second run is a no-op (resumable, no double spend)", () => {
  assert.equal(modelCalls.length, callsBefore, "no item was classified twice");
  assert.equal(writes.proposals.length, 0, "no duplicate proposals");
});

server.close();
realLog(fails.length ? `\n${fails.length} FAILED: ${fails.join(", ")}` : `\nall checks passed`);
process.exit(fails.length ? 1 : 0);
