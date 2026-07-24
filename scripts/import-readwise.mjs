// Readwise → Obsidian-X importer (v2.4). Pulls all highlights via the Readwise
// export API and stores one item per source (book/article), grouping its
// highlights. Idempotent: re-runs skip sources already imported (matched on the
// Readwise source id in items.external.readwise.id).
//
// Usage:
//   node --env-file=.env.local scripts/import-readwise.mjs [--run] [--vault]
// Dry-run by default (reports what would import). READWISE_TOKEN in .env.rotation.

import { createClient } from "@supabase/supabase-js";

const {
  NEXT_PUBLIC_SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  READWISE_TOKEN,
  OWNER_EMAIL,
} = process.env;

const OWNER_ID_FALLBACK = "ea2f992b-f751-4de8-978c-396f067302fb";
const RUN = process.argv.includes("--run");

if (!SB_URL || !SERVICE) { console.error("Missing Supabase env"); process.exit(1); }
if (!READWISE_TOKEN) { console.error("Missing READWISE_TOKEN"); process.exit(1); }

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

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

// Pull every source (book/article + its highlights) from the export endpoint.
async function fetchAllSources() {
  const out = [];
  let cursor = null;
  do {
    const url = new URL("https://readwise.io/api/v2/export/");
    if (cursor) url.searchParams.set("pageCursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Token ${READWISE_TOKEN}` } });
    if (!res.ok) throw new Error(`readwise export ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    out.push(...(j.results || []));
    cursor = j.nextPageCursor || null;
  } while (cursor);
  return out;
}

function kebab(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

const sources = (await fetchAllSources()).filter((s) => (s.highlights || []).length > 0);
const totalHl = sources.reduce((a, s) => a + (s.highlights || []).length, 0);
console.log(`Readwise: ${sources.length} sources, ${totalHl} highlights`);

if (sources.length === 0) {
  console.log("Nothing to import — add highlights in Readwise, then re-run.");
  process.exit(0);
}

if (!RUN) {
  console.log("\n--- SAMPLE (5) ---");
  for (const s of sources.slice(0, 5)) console.log(`  • ${s.title} — ${(s.highlights || []).length} highlights (${s.category || "?"})`);
  console.log(`\nDRY RUN — nothing written. Re-run with --run to import.`);
  process.exit(0);
}

const uid = await ownerId();
// existing Readwise source ids, to skip on re-run
const { data: existing } = await admin.from("items").select("external").eq("user_id", uid).eq("source", "readwise");
const seen = new Set((existing || []).map((r) => r.external?.readwise?.id).filter(Boolean));

let imported = 0, skipped = 0, errors = 0;
for (const s of sources) {
  const rid = String(s.user_book_id ?? s.id ?? "");
  if (rid && seen.has(rid)) { skipped++; continue; }
  try {
    const body = (s.highlights || [])
      .map((h) => `• ${(h.text || "").trim()}${h.note ? `\n  ↳ ${h.note.trim()}` : ""}`)
      .join("\n");
    const title = (s.title || "Untitled").slice(0, 120);
    const tags = [kebab(s.author), kebab(s.category), "readwise"].filter(Boolean).slice(0, 5);
    const emb = await embed(`${title}\n\n${body}`);
    const now = new Date().toISOString();
    const { error } = await admin.from("items").insert({
      user_id: uid, type: "reference", title, body, raw: body, status: "open",
      priority: "low", tags, source: "readwise", embedding: emb,
      created_at: now, valid_from: now, confidence: 1, needs_review: false, entities: [],
      external: rid ? { readwise: { id: rid, url: s.readwise_url ?? s.source_url ?? null } } : null,
    });
    if (error) throw new Error(error.message);
    imported++;
    if (imported % 20 === 0) console.log(`  … ${imported} imported`);
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`  ✗ "${s.title}": ${String(e.message || e).slice(0, 120)}`);
  }
}
console.log(`\n=== DONE === imported: ${imported} | skipped (already): ${skipped} | errors: ${errors}`);
