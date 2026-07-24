// Apple Notes → Obsidian-X importer (v1.6). Faithful, historical-archive import.
//
// Usage:
//   node --env-file=.env.local scripts/import-apple-notes.mjs <dir> [--run] [--limit N] [--vault]
//
// Default is a DRY RUN: it parses + filters and reports what WOULD import, with
// samples, but writes nothing. Add --run to actually classify/embed/store.
// --limit N   process only the first N importable notes (for a validation batch).
// --vault     also write a markdown file per note to the vault (slow; off by default —
//             the DB is the source of truth and is what Ask searches).
//
// Design: many exported notes are old / temporary / junk, so we skip near-empty,
// image-only, and numeric-scratch notes. Kept notes are classified (type + tags,
// NO due date), embedded, deduped (skip >= 0.93 vs existing), and tagged
// "apple-notes". Re-running is safe: the dedup pass skips already-imported notes.

import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname, sep } from "node:path";

const {
  NEXT_PUBLIC_SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  OPENROUTER_API_KEY,
  OPENROUTER_CLASSIFY_MODEL,
  GITHUB_TOKEN,
  VAULT_REPO,
  VAULT_BRANCH = "main",
  OWNER_EMAIL,
} = process.env;

const OWNER_ID_FALLBACK = "ea2f992b-f751-4de8-978c-396f067302fb";
const DUP_THRESHOLD = 0.93;
const ALLOWED_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event"];

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const RUN = args.includes("--run");
const WRITE_VAULT = args.includes("--vault");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? Number(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1]) : Infinity;

if (!dir) { console.error("Provide the export directory path."); process.exit(1); }
if (!SB_URL || !SERVICE) { console.error("Missing Supabase env"); process.exit(1); }

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

// ---- walk + parse -----------------------------------------------------------

function walk(root) {
  const out = [];
  (function rec(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name === "__MACOSX" || name === "Attachments" || name.startsWith("._")) continue;
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else if (extname(name).toLowerCase() === ".md") out.push(p);
    }
  })(root);
  return out;
}

function parseNote(file, root) {
  let content = readFileSync(file, "utf8");
  content = content.replace(/^﻿/, "");
  // strip a leading YAML frontmatter block if present
  content = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  // title: first markdown H1, else the filename
  const h1 = content.match(/^\s*#\s+(.+?)\s*$/m);
  let title = (h1 ? h1[1] : basename(file, ".md"))
    .replace(/\*\*/g, "").replace(/[`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) title = "Untitled note";
  // body: drop the title H1 line, neutralise image/links, tidy whitespace
  let body = content
    .replace(/^\s*#\s+.+?\s*$/m, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images -> gone
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const folder = relative(root, file).split(sep).slice(0, -1).filter((s) => s && s !== "Archive");
  return { file, title, body, folder };
}

// heuristic: is this note junk (empty / image-only / numeric scratch)?
function junkReason(n) {
  const text = n.body.replace(/[#*_>`~\-|]/g, " ").replace(/\s+/g, " ").trim();
  const words = text.match(/[A-Za-z][A-Za-z'']{1,}/g) || [];
  const nonSpace = text.replace(/\s/g, "").length;
  const alpha = (text.match(/[A-Za-z]/g) || []).length;
  const combined = `${n.title} ${text}`.trim();
  if (combined.replace(/\s/g, "").length < 15) return "too-short";
  if (words.length < 3) return "no-prose";
  if (nonSpace > 0 && alpha / nonSpace < 0.35 && words.length < 12) return "numeric-scratch";
  return null;
}

// ---- model helpers ----------------------------------------------------------

async function classify(title, body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "Obsidian-X import" },
    body: JSON.stringify({
      model: OPENROUTER_CLASSIFY_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          `Classify an imported personal note (historical archive — do NOT infer due dates). ` +
          `Return ONLY JSON: {"type": one of ${JSON.stringify(ALLOWED_TYPES)}, ` +
          `"tags": 1-5 lowercase kebab-case topical tags, "priority": one of ["low","medium","high"]}.` },
        { role: "user", content: `Title: ${title}\n\n${body.slice(0, 1500)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = (await res.json()).choices?.[0]?.message?.content ?? "{}";
  let c = {};
  try { c = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { /* keep defaults */ }
  const type = ALLOWED_TYPES.includes(c.type) ? c.type : "note";
  const priority = ["low", "medium", "high"].includes(c.priority) ? c.priority : "low";
  const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5) : [];
  return { type, tags, priority };
}

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

// ---- main -------------------------------------------------------------------

const files = walk(dir);
const parsed = files.map((f) => parseNote(f, dir));
const kept = [];
const skipped = {};
for (const n of parsed) {
  const r = junkReason(n);
  if (r) { (skipped[r] ??= []).push(n); continue; }
  kept.push(n);
}

console.log(`Scanned ${files.length} .md files`);
console.log(`  importable: ${kept.length}`);
for (const [r, list] of Object.entries(skipped)) console.log(`  skipped (${r}): ${list.length}`);

if (!RUN) {
  console.log(`\n--- SAMPLE importable (10) ---`);
  for (const n of kept.slice(0, 10)) console.log(`  • ${n.title}  —  ${n.body.replace(/\s+/g, " ").slice(0, 70)}…`);
  console.log(`\n--- SAMPLE skipped (8) ---`);
  for (const list of Object.values(skipped)) for (const n of list.slice(0, 3)) console.log(`  ✗ ${n.title}  —  ${n.body.replace(/\s+/g, " ").slice(0, 50)}`);
  console.log(`\nDRY RUN — nothing written. Re-run with --run (optionally --limit N) to import.`);
  process.exit(0);
}

// --- real import ---
const uid = await ownerId();
const octokit = WRITE_VAULT ? new Octokit({ auth: GITHUB_TOKEN }) : null;
const [vOwner, vRepo] = (VAULT_REPO || "/").split("/");
let imported = 0, dupes = 0, errors = 0;
const byType = {};
const toDo = kept.slice(0, LIMIT);
console.log(`\nImporting ${toDo.length} notes as historical archive (source=apple-notes)…`);

for (let i = 0; i < toDo.length; i++) {
  const n = toDo[i];
  try {
    const emb = await embed(`${n.title}\n\n${n.body}`);
    const { data: neigh } = await admin.rpc("match_neighbors", { query_embedding: emb, owner: uid, exclude_id: null, match_count: 1 });
    if ((neigh?.[0]?.similarity ?? 0) >= DUP_THRESHOLD) { dupes++; continue; }

    const { type, tags, priority } = await classify(n.title, n.body);
    const createdAt = new Date().toISOString();
    const allTags = [...new Set([...tags, ...n.folder.map((f) => f.toLowerCase()), "apple-notes"])].slice(0, 8);
    const { data: item, error } = await admin.from("items").insert({
      user_id: uid, type, title: n.title, body: n.body, raw: n.body, status: "open",
      priority, tags: allTags, source: "apple-notes", embedding: emb,
      created_at: createdAt, valid_from: createdAt, confidence: 1, needs_review: false, entities: [],
    }).select("id").single();
    if (error) throw new Error(error.message);
    byType[type] = (byType[type] ?? 0) + 1;

    if (WRITE_VAULT && octokit) {
      const path = `notes/${new Date(createdAt).getUTCFullYear()}/${item.id}.md`;
      const fm = `---\nid: ${item.id}\ntype: ${type}\ntags:\n${allTags.map((t) => `  - ${JSON.stringify(t)}`).join("\n")}\npriority: ${priority}\nstatus: open\nsource: apple-notes\ncreated_at: ${createdAt}\n---\n\n# ${n.title}\n\n${n.body}\n`;
      await octokit.repos.createOrUpdateFileContents({ owner: vOwner, repo: vRepo, path, message: `import: ${n.title}`, content: Buffer.from(fm, "utf8").toString("base64"), branch: VAULT_BRANCH });
      await admin.from("items").update({ vault_path: path }).eq("id", item.id);
    }
    imported++;
    if (imported % 25 === 0) console.log(`  … ${imported} imported (${dupes} dup, ${errors} err)`);
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`  ✗ "${n.title}": ${String(e.message || e).slice(0, 120)}`);
  }
}

console.log(`\n=== DONE ===`);
console.log(`imported: ${imported} | duplicates skipped: ${dupes} | errors: ${errors}`);
console.log(`by type: ${JSON.stringify(byType)}`);
