// Obsidian-X v4.0 W1 — measure the real similarity distribution in the NEW
// embedding space (text-embedding-3-large @ 1024 dims, `items.embedding_v2`) so
// LINK_THRESHOLD / DUP_THRESHOLD can be re-tuned against data instead of guessed.
//
// Usage:
//   node --env-file=.env.local scripts/measure-similarity.mjs [--all] [--pairs N]
//
//   --all      include archived / superseded items (default: only the rows
//              match_neighbors_v2 actually searches — not archived, valid_to null,
//              which is the population the capture thresholds apply to)
//   --pairs N  how many random distinct pairs to sample (default 10)
//
// PRIVACY: prints aggregate statistics and item UUIDs ONLY. Never titles, never
// bodies. Safe to paste into a report.
//
// Read-only: this script issues no writes.

import { createClient } from "@supabase/supabase-js";

const { NEXT_PUBLIC_SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE } = process.env;
if (!SB_URL || !SERVICE) {
  console.error("✗ Missing Supabase env");
  process.exit(1);
}

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const pairsArg = args.find((a) => a.startsWith("--pairs"));
const RANDOM_PAIRS = pairsArg
  ? Number(pairsArg.includes("=") ? pairsArg.split("=")[1] : args[args.indexOf(pairsArg) + 1])
  : 10;

const DIMS = 1024;
const PAGE = 200;

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

// --- load vectors (keyset paginated; ids + vectors only) --------------------

function parseVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return JSON.parse(v);
  return null;
}

const ids = [];
const vecs = [];
let after = "00000000-0000-0000-0000-000000000000";
process.stdout.write("loading embedding_v2 …");
for (;;) {
  let q = admin
    .from("items")
    .select("id, embedding_v2")
    .not("embedding_v2", "is", null)
    .gt("id", after)
    .order("id", { ascending: true })
    .limit(PAGE);
  if (!ALL) q = q.neq("status", "archived").is("valid_to", null);

  const { data, error } = await q;
  if (error) {
    console.error("\n✗ select failed: " + error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) break;
  for (const r of data) {
    const arr = parseVector(r.embedding_v2);
    if (!arr || arr.length !== DIMS) continue;
    // L2-normalise once so cosine similarity is a plain dot product.
    const f = new Float64Array(DIMS);
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIMS; i++) f[i] = arr[i] / norm;
    ids.push(r.id);
    vecs.push(f);
  }
  after = data[data.length - 1].id;
  process.stdout.write(".");
  if (data.length < PAGE) break;
}
console.log(` ${vecs.length} vectors`);

const { count: totalItems } = await admin.from("items").select("id", { count: "exact", head: true });
const { count: missingV2 } = await admin
  .from("items")
  .select("id", { count: "exact", head: true })
  .is("embedding_v2", null);
// Coverage of the lexical arm of the hybrid — a NULL/empty fts means that item
// can only ever be found by the vector arm.
const { count: missingFts } = await admin
  .from("items")
  .select("id", { count: "exact", head: true })
  .is("fts", null);

const N = vecs.length;
if (N < 3) {
  console.error("✗ need at least 3 embedded items to measure");
  process.exit(1);
}

// --- pairwise pass ----------------------------------------------------------

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += a[i] * b[i];
  return s;
}

const nn = new Float64Array(N).fill(-1); // nearest-neighbour similarity per item
const top = []; // running top-K highest pairs
const TOP_K = 10;
let topMin = -1;
let sum = 0;
let pairCount = 0;

for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const s = dot(vecs[i], vecs[j]);
    sum += s;
    pairCount++;
    if (s > nn[i]) nn[i] = s;
    if (s > nn[j]) nn[j] = s;
    if (top.length < TOP_K || s > topMin) {
      top.push({ a: i, b: j, s });
      top.sort((x, y) => y.s - x.s);
      if (top.length > TOP_K) top.length = TOP_K;
      topMin = top[top.length - 1].s;
    }
  }
}

function pct(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round((p / 100) * (sortedArr.length - 1))));
  return sortedArr[idx];
}
const f3 = (x) => x.toFixed(3);

const nnSorted = Array.from(nn).sort((a, b) => a - b);
const meanAll = sum / pairCount;

// --- random distinct pairs --------------------------------------------------

const rnd = [];
const seen = new Set();
let guard = 0;
while (rnd.length < Math.min(RANDOM_PAIRS, (N * (N - 1)) / 2) && guard++ < 10000) {
  const i = Math.floor(Math.random() * N);
  let j = Math.floor(Math.random() * N);
  if (i === j) continue;
  const key = i < j ? `${i}:${j}` : `${j}:${i}`;
  if (seen.has(key)) continue;
  seen.add(key);
  rnd.push({ a: i, b: j, s: dot(vecs[i], vecs[j]) });
}
const rndSorted = rnd.map((r) => r.s).sort((a, b) => a - b);

// --- report -----------------------------------------------------------------

console.log("\n=== corpus ===");
console.log(`population:        ${ALL ? "ALL items (incl. archived)" : "retrieval set (not archived, valid_to null)"}`);
console.log(`vectors measured:  ${N}`);
console.log(`items in DB:       ${totalItems}   (missing embedding_v2: ${missingV2})`);
console.log(`items missing fts: ${missingFts}   (lexical arm of the hybrid)`);
console.log(`pairs compared:    ${pairCount}`);

console.log("\n=== nearest-neighbour similarity (per item, max vs. all others) ===");
for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99]) {
  console.log(`  p${String(p).padStart(2)}  ${f3(pct(nnSorted, p))}`);
}
console.log(`  min  ${f3(nnSorted[0])}`);
console.log(`  max  ${f3(nnSorted[nnSorted.length - 1])}`);

console.log("\n=== all-pairs similarity (the 'unrelated' floor) ===");
console.log(`  mean ${f3(meanAll)}`);

console.log(`\n=== ${rnd.length} random distinct pairs ===`);
for (const r of rnd) console.log(`  ${f3(r.s)}   ${ids[r.a]}  ~  ${ids[r.b]}`);
if (rndSorted.length) {
  console.log(`  -> min ${f3(rndSorted[0])}  median ${f3(pct(rndSorted, 50))}  max ${f3(rndSorted[rndSorted.length - 1])}`);
}

console.log("\n=== top 10 most-similar pairs (near-duplicate candidates) ===");
for (const t of top) console.log(`  ${f3(t.s)}   ${ids[t.a]}  ~  ${ids[t.b]}`);

// --- derived threshold candidates ------------------------------------------
//
// LINK: must sit far above the unrelated floor so auto-linking stays meaningful.
// DUP:  must sit above almost every legitimate nearest-neighbour pair, so only a
//       true re-capture trips it.
const linkCandidate = Math.max(pct(nnSorted, 75), meanAll + (pct(nnSorted, 90) - meanAll) * 0.5);
const dupCandidate = Math.max(pct(nnSorted, 99), pct(nnSorted, 95) + 0.05);

console.log("\n=== derived threshold candidates (sanity-check against the pairs above) ===");
console.log(`  unrelated floor (all-pairs mean):  ${f3(meanAll)}`);
console.log(`  NN p75  -> LINK candidate:         ${f3(linkCandidate)}`);
console.log(`  NN p99  -> DUP candidate:          ${f3(dupCandidate)}`);
console.log(
  `  items that would auto-link at LINK: ${nnSorted.filter((s) => s >= linkCandidate).length}/${N}`
);
console.log(
  `  items that would dup-flag at DUP:   ${nnSorted.filter((s) => s >= dupCandidate).length}/${N}`
);
