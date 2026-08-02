// Obsidian-X — rebuild the typed edge graph, and purge the legacy links.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings \
//     scripts/rebuild-edges.mjs                  # dry run
//   … scripts/rebuild-edges.mjs --write          # rebuild edges
//   … scripts/rebuild-edges.mjs --write --purge  # …and clear items.links
//
// THE PURGE (brain-quality brief, Phase 2 item 3). `items.links` held 13
// entries on 2026-08-02: 12 were braindump siblings and 1 was a similarity link
// made in the abandoned gte-small space. The owner's workshop ranking did not
// include thread/braindump provenance as a connection kind, so they are removed
// rather than migrated. The `edges` table is the only source of connections now.
//
// Audited, because deleting a relationship is still deleting data.

import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { rebuildEdges } = await import("../lib/edges.ts");

const WRITE = process.argv.includes("--write");
const PURGE = process.argv.includes("--purge");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const { data: users } = await admin.auth.admin.listUsers();
const owner = users.users.find((u) => u.email === process.env.OWNER_EMAIL);

const { data: items } = await admin
  .from("items")
  .select("id,title,links")
  .eq("user_id", owner.id);
const titleById = new Map(items.map((i) => [i.id, i.title]));
const legacy = items.filter((i) => (i.links ?? []).length);
const legacyCount = legacy.reduce((n, i) => n + i.links.length, 0);

console.log(`legacy items.links entries: ${legacyCount} across ${legacy.length} items`);
for (const i of legacy) {
  for (const l of i.links) {
    console.log(`  ${(i.title ?? "").slice(0, 40).padEnd(40)} → ${(titleById.get(l) ?? "(missing)").slice(0, 40)}`);
  }
}

if (!WRITE) {
  console.log("\n(dry run — pass --write [--purge])");
  process.exit(0);
}

const res = await rebuildEdges(admin, owner.id, { includeSimilar: true });
console.log(`\nedges rebuilt: ${res.written} ${JSON.stringify(res.byKind)}`);

if (PURGE) {
  for (const i of legacy) {
    await admin.from("items").update({ links: [] }).eq("id", i.id).eq("user_id", owner.id);
    await admin.from("audit").insert({
      user_id: owner.id,
      item_id: i.id,
      action: "legacy_links_purged",
      actor: "system",
      detail: {
        removed: i.links.length,
        removed_titles: i.links.map((l) => titleById.get(l) ?? l),
        why: "brain-quality Phase 2 — braindump-sibling and pre-embedding_v2 links; connections now live in the typed `edges` table",
      },
    });
  }
  console.log(`purged ${legacyCount} legacy links from ${legacy.length} items (audited)`);
} else {
  console.log("(pass --purge to also clear items.links)");
}
