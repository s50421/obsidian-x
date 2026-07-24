// ChatGPT self-profile → Obsidian-X importer (v2). On-hold, reviewable archive.
//
// Usage:
//   node --env-file=.env.local scripts/import-chatgpt-profile.mjs <file> [--run] [--limit N] [--type note]
//
// Default is a DRY RUN: it parses the profile and reports the sections + facts it
// WOULD import (with samples), writing nothing. Add --run to embed + store.
//   --limit N   import only the first N facts (validation batch).
//   --type T    item type for every fact (default "note"; one of the allowed types).
//
// Each fact becomes its own item, imported ARCHIVED (on-hold) so it is invisible
// to Ask / auto-link / brief until the owner Activates it on /imports. Items carry
//   source = "chatgpt-profile", tags = ["profile","chatgpt", <section-slug>]
// and are embedded (searchable once activated) and deduped (skip >= 0.93 vs
// existing items). Re-running is safe: the dedup pass skips already-imported facts.
//
// Input format: a plain-text / markdown paste of a ChatGPT profile. Markdown
// headers (#, ##, ###) set the current section; bullet lines (-, *, •, 1.) and
// non-empty prose lines under a header each become one fact. A "Key: value" line
// is kept whole ("Key: value") as the fact. Headers, separators, and blank lines
// are not facts.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const {
  NEXT_PUBLIC_SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  OWNER_EMAIL,
} = process.env;

const OWNER_ID_FALLBACK = "ea2f992b-f751-4de8-978c-396f067302fb";
const DUP_THRESHOLD = 0.93;
const ALLOWED_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event"];

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const RUN = args.includes("--run");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? Number(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1]) : Infinity;
const typeArg = args.find((a) => a.startsWith("--type"));
let DEFAULT_TYPE = typeArg ? (typeArg.split("=")[1] ?? args[args.indexOf(typeArg) + 1]) : "note";
if (!ALLOWED_TYPES.includes(DEFAULT_TYPE)) DEFAULT_TYPE = "note";

if (!file) { console.error("Provide the profile text file path."); process.exit(1); }
if (!SB_URL || !SERVICE) { console.error("Missing Supabase env"); process.exit(1); }

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

// ---- parse ------------------------------------------------------------------

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "general";
}

// Split the profile into { section, text } facts.
function parseProfile(raw) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const facts = [];
  let section = "General";
  for (let line of lines) {
    const t = line.trim();
    if (!t) continue;
    // horizontal rules / separators
    if (/^([-*_=]\s?){3,}$/.test(t)) continue;
    // markdown header -> new section (also handles "**Bold heading**" only-lines)
    const h = t.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = h[1].replace(/[*_`#:]+$/g, "").replace(/[*_`]/g, "").trim() || section; continue; }
    const boldOnly = t.match(/^\*\*(.+?)\*\*:?$/);
    if (boldOnly) { section = boldOnly[1].trim(); continue; }
    // strip a leading bullet / number marker
    let fact = t.replace(/^([-*•]|\d+[.)])\s+/, "").trim();
    // strip surrounding markdown emphasis but keep inline text
    fact = fact.replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!fact) continue;
    if (fact.replace(/\s/g, "").length < 3) continue; // too short to be a fact
    facts.push({ section, text: fact });
  }
  return facts;
}

// ---- model / db helpers -----------------------------------------------------

async function embed(input) {
  const res = await fetch(`${SB_URL}/functions/v1/embed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: input.slice(0, 4000) }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  return (await res.json()).embedding;
}

async function ownerId() {
  try {
    const { data } = await admin.auth.admin.listUsers();
    const u = data?.users?.find((x) => (x.email || "").toLowerCase() === (OWNER_EMAIL || "").toLowerCase());
    if (u) return u.id;
  } catch { /* fall through */ }
  return OWNER_ID_FALLBACK;
}

function titleFor(fact) {
  const oneLine = fact.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 80) return oneLine;
  const cut = oneLine.slice(0, 80);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).trim() + "…";
}

// ---- main -------------------------------------------------------------------

const raw = readFileSync(file, "utf8");
const facts = parseProfile(raw);

const bySection = {};
for (const f of facts) (bySection[f.section] ??= []).push(f);

console.log(`Parsed ${facts.length} facts across ${Object.keys(bySection).length} sections:`);
for (const [s, list] of Object.entries(bySection)) console.log(`  • ${s} (${slugify(s)}): ${list.length}`);

if (!RUN) {
  console.log(`\n--- SAMPLE facts (12) ---`);
  for (const f of facts.slice(0, 12)) console.log(`  • [${slugify(f.section)}] ${f.text.slice(0, 90)}`);
  console.log(`\nDRY RUN — nothing written. Re-run with --run (optionally --limit N) to import.`);
  process.exit(0);
}

const uid = await ownerId();
let imported = 0, dupes = 0, errors = 0;
const toDo = facts.slice(0, LIMIT);
console.log(`\nImporting ${toDo.length} facts as archived on-hold items (source=chatgpt-profile, type=${DEFAULT_TYPE})…`);

for (let i = 0; i < toDo.length; i++) {
  const f = toDo[i];
  try {
    const emb = await embed(f.text);
    const { data: neigh } = await admin.rpc("match_neighbors", {
      query_embedding: emb, owner: uid, exclude_id: null, match_count: 1,
    });
    if ((neigh?.[0]?.similarity ?? 0) >= DUP_THRESHOLD) { dupes++; continue; }

    const createdAt = new Date().toISOString();
    const tags = [...new Set(["profile", "chatgpt", slugify(f.section)])].slice(0, 6);
    const { error } = await admin.from("items").insert({
      user_id: uid, type: DEFAULT_TYPE, title: titleFor(f.text), body: f.text, raw: f.text,
      status: "archived", priority: "low", tags, source: "chatgpt-profile", embedding: emb,
      created_at: createdAt, valid_from: createdAt, confidence: 1, needs_review: false, entities: [],
    });
    if (error) throw new Error(error.message);
    imported++;
    if (imported % 25 === 0) console.log(`  … ${imported} imported (${dupes} dup, ${errors} err)`);
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`  ✗ "${f.text.slice(0, 60)}": ${String(e.message || e).slice(0, 120)}`);
  }
}

console.log(`\n=== DONE ===`);
console.log(`imported: ${imported} | duplicates skipped: ${dupes} | errors: ${errors}`);
console.log(`All items are ARCHIVED (on-hold). Review + Activate at /imports (source: ChatGPT profile).`);
