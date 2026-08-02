// Obsidian-X — build the entity canon from the raw strings already on items.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings \
//     scripts/backfill-entities.mjs            # dry run
//   … scripts/backfill-entities.mjs --write    # create canon + links
//   … scripts/backfill-entities.mjs --write --suggest   # also propose merges
//
// Two passes, matching the owner's workshop decision:
//   1. DETERMINISTIC — resolve every raw string against the canon by exact,
//      alias and case-insensitive match, creating canon rows as needed. No
//      model, no judgement, no cost.
//   2. SUGGEST (--suggest) — ask the model only about what's LEFT, and write
//      each as a proposal for the owner to approve. Nothing merges silently
//      except the case/alias matches pass 1 already handled.

import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const {
  loadEntities,
  linkItemEntities,
  suggestMerges,
  isSelfOrSystem,
  canonicalName,
} = await import("../lib/entities.ts");

const WRITE = process.argv.includes("--write");
const SUGGEST = process.argv.includes("--suggest");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const { data: users } = await admin.auth.admin.listUsers();
const owner = users.users.find((u) => u.email === process.env.OWNER_EMAIL);

const { data: items } = await admin
  .from("items")
  .select("id,title,entities,status")
  .eq("user_id", owner.id)
  .limit(2000);

const withEntities = items.filter((i) => (i.entities ?? []).length);
console.log(`${items.length} items, ${withEntities.length} carry entity strings`);

if (!WRITE) {
  const seen = new Map();
  for (const i of withEntities) {
    for (const e of i.entities) {
      const k = `${e.name}|${e.kind ?? "other"}`;
      (seen.get(k) ?? seen.set(k, []).get(k)).push(i.title);
    }
  }
  console.log(`\nwould create up to ${seen.size} canon rows:`);
  for (const [k, titles] of [...seen].sort()) {
    const [name] = k.split("|");
    const self = isSelfOrSystem(name) ? "  [edge_eligible=false — self/system]" : "";
    console.log(`  ${canonicalName(name).padEnd(28)} ${k.split("|")[1].padEnd(7)} ×${titles.length}${self}`);
  }
  console.log("\n(dry run — pass --write)");
  process.exit(0);
}

const canon = await loadEntities(admin, owner.id);
let linked = 0;
for (const i of withEntities) {
  linked += await linkItemEntities(admin, owner.id, i.id, i.entities, canon);
}
console.log(`\ncanon rows: ${canon.length} · item↔entity links: ${linked}`);
for (const e of canon.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${e.name.padEnd(28)} ${e.kind.padEnd(7)} ${e.edge_eligible ? "" : "[no edges — self/system]"}`);
}

if (!SUGGEST) {
  console.log("\n(pass --suggest to propose judgement-call merges)");
  process.exit(0);
}

// Context so the model can judge from more than the bare name.
const { data: links } = await admin
  .from("item_entities")
  .select("entity_id,item_id")
  .eq("user_id", owner.id);
const titleById = new Map(items.map((i) => [i.id, i.title]));
const context = new Map();
for (const l of links ?? []) {
  const arr = context.get(l.entity_id) ?? [];
  arr.push(titleById.get(l.item_id) ?? "");
  context.set(l.entity_id, arr);
}

const { merges } = await suggestMerges(canon, context);
console.log(`\n${merges.length} merge(s) proposed by the model:`);
const byName = new Map(canon.map((e) => [e.name, e]));
for (const m of merges) {
  console.log(`  "${m.from}" → "${m.into}"  (${m.confidence}) ${m.reason}`);
  const from = byName.get(m.from);
  const into = byName.get(m.into);
  if (!from || !into) continue;
  await admin.from("proposals").insert({
    user_id: owner.id,
    kind: "entity_merge",
    status: "pending",
    title: `Merge "${m.from}" into "${m.into}"`,
    source: "entity-backfill",
    payload: {
      fromId: from.id,
      intoId: into.id,
      fromName: m.from,
      intoName: m.into,
      reason: m.reason,
      confidence: m.confidence,
    },
  });
  // Flag both ends so the deck can show they're under question rather than
  // presenting an unresolved duplicate as settled fact.
  await admin.from("entities").update({ needs_review: true }).in("id", [from.id, into.id]);
}
console.log("\nProposed, not applied — approve in /approvals.");
