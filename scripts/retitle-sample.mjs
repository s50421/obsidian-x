// Obsidian-X v4.0 W2 — the owner-approval harness.
//
// Picks N random items (a deliberate MIX of archived apple-notes and active
// items), runs the REAL v4.0 classification on them — the same prompt, the same
// sanitisers and the same parser scripts/reprocess-corpus.mjs uses — and prints
// a before -> after table.
//
// This is the gate. David reads the table and decides whether the prompt is good
// enough BEFORE the full corpus pass runs. It is also the weekly KPI #4
// instrument ("0 unusable titles in a 20-item sample").
//
// WRITES NOTHING. No proposals, no flags, no audit rows, no usage rows.
//
// Usage:
//   node --env-file=.env.local scripts/retitle-sample.mjs [flags]
//
//   --n N            sample size (default 20)
//   --source ...     apple-notes | active | all   (default: all = a mix)
//   --seed S         reproducible sample (same seed -> same items)
//   --full           also print each note's opening line and the AI's reason
//   --concurrency N  parallel classifications (default 4)

import {
  env,
  parseArgs,
  classifyItem,
  pool,
  truncate,
  pad,
  fail,
  ITEM_COLS,
} from "./reprocess-lib.mjs";
import {
  titleQualityIssues,
  TITLE_MAX,
  CONFIDENCE_BAR,
  JUNK_ARCHIVE_SCORE,
  JUNK_REVIEW_SCORE,
} from "../lib/title-standard.mjs";

const args = parseArgs(process.argv);
const N = Math.max(1, Math.min(100, args.num("n", 20)));
const SOURCE = args.get("source", "all");
const SEED = args.get("seed", null);
const FULL = args.has("full");
const CONCURRENCY = Math.max(1, Math.min(8, args.num("concurrency", 4)));

if (!["all", "apple-notes", "active"].includes(SOURCE)) {
  fail(`--source must be 'apple-notes', 'active' or 'all' (got '${SOURCE}')`);
}

const { admin, apiKey, model } = env(true);
const todayISO = new Date().toISOString().slice(0, 10);

// Deterministic PRNG so `--seed` reproduces a sample exactly (mulberry32).
function rng(seedStr) {
  if (seedStr === null) return Math.random;
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);

function sample(rows, k) {
  const a = [...rows];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// Pull ids first (cheap), sample, then fetch only the sampled bodies.
async function pickIds(filter, limit) {
  let q = admin.from("items").select("id").neq("source", "system").is("valid_to", null).limit(4000);
  if (filter === "apple-notes") q = q.eq("source", "apple-notes");
  if (filter === "active") q = q.neq("source", "apple-notes");
  const { data, error } = await q;
  if (error) fail("select failed: " + error.message);
  return sample(data ?? [], limit).map((r) => r.id);
}

let ids;
if (SOURCE === "all") {
  // A mix, not a random draw: the corpus is ~99% apple-notes, so an unweighted
  // sample would never show an active item and the table would not represent
  // what the live pipeline produces.
  const half = Math.ceil(N / 2);
  const active = await pickIds("active", half);
  const archived = await pickIds("apple-notes", N - active.length);
  ids = [...active, ...archived];
} else {
  ids = await pickIds(SOURCE, N);
}

if (!ids.length) fail("no items matched — is the database empty?");

const { data: items, error } = await admin.from("items").select(ITEM_COLS).in("id", ids);
if (error) fail("fetch failed: " + error.message);

console.log(`Obsidian-X v4.0 W2 — re-title sample (${items.length} items, source=${SOURCE}${SEED !== null ? `, seed=${SEED}` : ""})`);
console.log(`model: ${model} · READ-ONLY: nothing is written\n`);

const rows = [];
let failures = 0;

await pool(items, CONCURRENCY, async (item) => {
  const { verdict, error: err } = await classifyItem({ apiKey, model, item, todayISO });
  if (!verdict) {
    failures++;
    rows.push({ item, error: err });
    return;
  }
  rows.push({ item, verdict, error: err });
});

// Stable output order regardless of which worker finished first.
rows.sort((a, b) => String(a.item.source).localeCompare(String(b.item.source)) || String(a.item.id).localeCompare(String(b.item.id)));

const W_ID = 8;
const W_OLD = 50;
const W_NEW = 60;

console.log(
  `${pad("id", W_ID)}  ${pad("old title", W_OLD)}  ${pad("new title", W_NEW)}  junk  split  conf`
);
console.log("-".repeat(W_ID + W_OLD + W_NEW + 22));

let unusable = 0;
let junkArchive = 0;
let junkReview = 0;
let splits = 0;
let lowConf = 0;

for (const r of rows) {
  const idShort = String(r.item.id).slice(0, W_ID);
  const old = truncate(r.item.title ?? "(none)", W_OLD);
  if (!r.verdict) {
    console.log(`${pad(idShort, W_ID)}  ${pad(old, W_OLD)}  ${pad("!! " + truncate(r.error, W_NEW - 3), W_NEW)}     -      -     -`);
    continue;
  }
  const v = r.verdict;
  const issues = v.title ? titleQualityIssues(v.title, r.item.body ?? "") : ["empty"];
  const bad = issues.length > 0;
  if (bad) unusable++;
  if (v.junkVerdict === "archive") junkArchive++;
  if (v.junkVerdict === "review") junkReview++;
  if (v.parts.length >= 2) splits++;
  if (v.confidence < CONFIDENCE_BAR) lowConf++;

  const newTitle = v.parts.length >= 2 ? v.parts.map((p) => p.title).join(" | ") : v.title || "(none)";
  console.log(
    `${pad(idShort, W_ID)}  ${pad(old, W_OLD)}  ${pad(truncate(newTitle, W_NEW), W_NEW)}  ${pad(String(v.junkScore), 4)}  ${pad(String(v.parts.length || 1), 5)}  ${v.confidence.toFixed(2)}${bad ? "  <-- UNUSABLE: " + issues.join(",") : ""}`
  );

  if (FULL) {
    const opening = truncate((r.item.raw || r.item.body || "").split("\n").find((l) => l.trim()) ?? "", 100);
    console.log(`${" ".repeat(W_ID + 2)}opens: ${opening}`);
    if (v.reason) console.log(`${" ".repeat(W_ID + 2)}why:   ${truncate(v.reason, 100)}`);
    if (v.parts.length >= 2) for (const p of v.parts) console.log(`${" ".repeat(W_ID + 2)}part:  ${truncate(p.title, 70)}  [${p.tags.join(", ")}]`);
    else console.log(`${" ".repeat(W_ID + 2)}tags:  ${v.tags.join(", ") || "(none)"}  · type ${v.type}`);
    console.log("");
  }
}

console.log("");
console.log(`sampled:          ${rows.length}`);
console.log(`UNUSABLE titles:  ${unusable}   <- KPI #4 target is 0`);
console.log(`would split:      ${splits}`);
console.log(`junk >= ${JUNK_ARCHIVE_SCORE} (archive): ${junkArchive}`);
console.log(`junk ${JUNK_REVIEW_SCORE}-${JUNK_ARCHIVE_SCORE - 1} (flag):     ${junkReview}`);
console.log(`low confidence:   ${lowConf} (< ${CONFIDENCE_BAR})`);
console.log(`classify failures:${String(failures).padStart(3)}`);
console.log(`title cap:        ${TITLE_MAX} chars`);
console.log("");
console.log(unusable === 0
  ? "PASS — every title met the spec. Approve the prompt, then run:\n  node --env-file=.env.local scripts/reprocess-corpus.mjs --run"
  : `FAIL — ${unusable} title(s) still break the spec. Fix the prompt in lib/title-standard.mjs and re-sample with the same --seed.`);
