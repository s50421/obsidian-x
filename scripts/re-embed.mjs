// Obsidian-X v4.0 W1 — backfill `items.embedding_v2` with OpenAI
// text-embedding-3-large @ 1024 dims.
//
// Usage:
//   node --env-file=.env.local scripts/re-embed.mjs [--force] [--limit N] [--dry-run]
//
//   --force     re-embed rows that already have embedding_v2 (default: skip them)
//   --limit N   stop after N items (for a smoke batch)
//   --dry-run   count what WOULD be embedded, call nothing, write nothing
//
// ADDITIVE ONLY: the sole column written is `embedding_v2`. Nothing else on the
// item is read-modified-written, nothing is deleted, and `embedding` (the old
// 384-dim gte-small column) is left exactly as it is.
//
// Covers EVERY item including archived ones — the v4.0 import deck reviews the
// 669 archived apple-notes, so they must be searchable in the new space too.
//
// Embedding basis is `${title}\n\n${body}`, byte-for-byte the same basis
// lib/capture-core.ts uses for live captures. Keep the two in sync.

import { createClient } from "@supabase/supabase-js";

const {
  NEXT_PUBLIC_SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  OPENAI_API_KEY,
} = process.env;

const MODEL = "text-embedding-3-large";
const DIMS = 1024;
const MAX_CHARS = 30_000;
const BATCH = 100; // inputs per OpenAI call
const PAGE = 200; // rows per Supabase page
const WRITE_CONCURRENCY = 8;
const USD_PER_MILLION_TOKENS = 0.13;

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg
  ? Number(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf(limitArg) + 1])
  : Infinity;

function fail(m) {
  console.error("✗ " + m);
  process.exit(1);
}
if (!SB_URL || !SERVICE) fail("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
if (!OPENAI_API_KEY && !DRY) fail("Missing OPENAI_API_KEY");

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One embeddings call, single retry on 429/5xx (mirrors lib/embed.ts).
async function embedBatch(inputs) {
  const body = JSON.stringify({ model: MODEL, dimensions: DIMS, input: inputs });
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2000);
    let res;
    try {
      res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      lastStatus = 0;
      lastDetail = e?.message ?? String(e);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const rows = data?.data ?? [];
      if (rows.length !== inputs.length) throw new Error(`got ${rows.length} vectors for ${inputs.length} inputs`);
      const vectors = new Array(inputs.length);
      for (const r of rows) {
        if (!Array.isArray(r.embedding) || r.embedding.length !== DIMS) {
          throw new Error(`bad vector length ${r.embedding?.length}`);
        }
        vectors[r.index] = r.embedding;
      }
      return { vectors, tokens: data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0 };
    }
    lastStatus = res.status;
    lastDetail = await res.text().catch(() => "");
    if (!(res.status === 429 || res.status >= 500)) break;
  }
  throw new Error(`OpenAI embeddings ${lastStatus}: ${lastDetail.slice(0, 300)}`);
}

// Keyset pagination on id. Offset paging would skip rows once the
// `embedding_v2 is null` filter starts excluding rows we just wrote.
async function* eachItem() {
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let q = admin
      .from("items")
      .select("id, title, body, user_id")
      .gt("id", after)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (!FORCE) q = q.is("embedding_v2", null);

    const { data, error } = await q;
    if (error) fail("select failed: " + error.message);
    if (!data || data.length === 0) return;
    for (const row of data) yield row;
    after = data[data.length - 1].id;
    if (data.length < PAGE) return;
  }
}

// --- count first, so progress means something ------------------------------

let totalQ = admin.from("items").select("id", { count: "exact", head: true });
if (!FORCE) totalQ = totalQ.is("embedding_v2", null);
const { count: pending, error: countErr } = await totalQ;
if (countErr) fail("count failed: " + countErr.message);

const { count: allItems } = await admin.from("items").select("id", { count: "exact", head: true });

console.log(`items in DB: ${allItems}`);
console.log(`to embed:    ${pending}${FORCE ? " (--force: all rows)" : " (missing embedding_v2)"}`);
if (LIMIT !== Infinity) console.log(`limit:       ${LIMIT}`);
if (DRY) {
  console.log("\n--dry-run: nothing called, nothing written.");
  process.exit(0);
}
if (!pending) {
  console.log("\nNothing to do. (Use --force to re-embed everything.)");
  process.exit(0);
}

// --- run --------------------------------------------------------------------

const started = Date.now();
let embedded = 0;
let written = 0;
let failed = 0;
let tokens = 0;
let apiCalls = 0;
let ownerId = null;
const errors = [];

async function flush(batch) {
  const inputs = batch.map((r) => {
    const t = `${r.title ?? ""}\n\n${r.body ?? ""}`.trim();
    return (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t) || " ";
  });

  const { vectors, tokens: used } = await embedBatch(inputs);
  apiCalls++;
  tokens += used;
  embedded += batch.length;

  // Write embedding_v2 only. Small concurrency keeps it quick without
  // hammering the connection pool.
  for (let i = 0; i < batch.length; i += WRITE_CONCURRENCY) {
    const slice = batch.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(
      slice.map(async (row, j) => {
        const { error } = await admin
          .from("items")
          .update({ embedding_v2: vectors[i + j] })
          .eq("id", row.id);
        if (error) {
          failed++;
          if (errors.length < 10) errors.push(`${row.id}: ${error.message}`);
        } else {
          written++;
        }
      })
    );
  }

  if (written % 100 < batch.length) {
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  … ${written}/${Math.min(pending, LIMIT)} written  (${tokens} tokens, ${secs}s)`);
  }
}

let batch = [];
let seen = 0;
for await (const row of eachItem()) {
  if (seen >= LIMIT) break;
  seen++;
  if (!ownerId) ownerId = row.user_id;
  batch.push(row);
  if (batch.length >= BATCH) {
    await flush(batch);
    batch = [];
  }
}
if (batch.length) await flush(batch);

// Record the spend next to the app's other model costs.
if (ownerId && tokens) {
  await admin
    .from("llm_usage")
    .insert({
      user_id: ownerId,
      operation: "embed_backfill",
      model: MODEL,
      prompt_tokens: tokens,
      completion_tokens: 0,
      total_tokens: tokens,
      cost_usd: (tokens / 1_000_000) * USD_PER_MILLION_TOKENS,
    })
    .then(() => {}, () => {});
}

const { count: remaining } = await admin
  .from("items")
  .select("id", { count: "exact", head: true })
  .is("embedding_v2", null);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log("\n--- re-embed summary ---");
console.log(`model:            ${MODEL} @ ${DIMS} dims`);
console.log(`items embedded:   ${embedded}`);
console.log(`rows written:     ${written}`);
console.log(`write failures:   ${failed}`);
console.log(`API calls:        ${apiCalls}`);
console.log(`prompt tokens:    ${tokens}`);
console.log(`cost:             $${((tokens / 1_000_000) * USD_PER_MILLION_TOKENS).toFixed(4)}`);
console.log(`elapsed:          ${elapsed}s`);
console.log(`still NULL:       ${remaining} / ${allItems} items`);
if (errors.length) {
  console.log("first write errors:");
  for (const e of errors) console.log("  " + e);
}
if (failed) process.exit(1);
