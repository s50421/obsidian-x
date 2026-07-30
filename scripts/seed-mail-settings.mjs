// Obsidian-X v4.1 — seed / update the mail ranking settings.
//
//   node --env-file=.env.local scripts/seed-mail-settings.mjs            # show current
//   node --env-file=.env.local scripts/seed-mail-settings.mjs --write    # apply DEFAULTS below
//
// These live in the `settings` table (owner-scoped) rather than in code so they
// can be tuned without a deploy. There is deliberately no UI for them yet —
// that's on the phase-2 backlog.
//
//   mail_identities — every address that IS the owner. Forwarded mail keeps its
//                     original To:, so without this the whole forwarded stream
//                     reads as "not addressed to me" and sinks below the bar.
//   mail_streams    — Gmail label name → the logical stream it represents, so
//                     forwarded personal mail is counted as its own source.
//   mail_vip        — senders that must never be missed. NOTE: the auto-create
//                     bar requires a VIP match, so an empty list means nothing
//                     is ever auto-created.
//   mail_demote     — senders/subjects that are never important.

import { createClient } from "@supabase/supabase-js";

const WORK = "david@manhartgroup.com";
const PERSONAL = "davi.manhart@gmail.com";

const DEFAULTS = {
  mail_identities: { addresses: [WORK, PERSONAL] },
  mail_streams: { "via-personal": PERSONAL },
  // Fill these in with the owner's real list — see the note above about
  // auto-create being gated on a VIP match.
  mail_vip: { addresses: [], domains: [], names: [] },
  mail_demote: { addresses: [], domains: [], subjects: [] },
};

const KEYS = Object.keys(DEFAULTS);
const write = process.argv.includes("--write");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: users, error: ue } = await admin.auth.admin.listUsers();
if (ue) throw ue;
const owner = users.users.find(
  (u) => (u.email ?? "").toLowerCase() === (process.env.OWNER_EMAIL ?? "").toLowerCase()
);
if (!owner) throw new Error("owner not found");

const { data: existing } = await admin
  .from("settings")
  .select("key,value")
  .eq("user_id", owner.id)
  .in("key", KEYS);

const current = Object.fromEntries((existing ?? []).map((r) => [r.key, r.value]));

console.log("current:");
for (const k of KEYS) console.log(` ${k} =`, JSON.stringify(current[k] ?? null));

if (!write) {
  console.log("\n(dry run — pass --write to apply the defaults above)");
  process.exit(0);
}

// Never clobber a non-empty VIP/demote list with the empty default: that would
// silently disarm auto-create the next time this script is run.
const isEmptyList = (v) =>
  !v || Object.values(v).every((a) => !Array.isArray(a) || a.length === 0);

for (const key of KEYS) {
  const preserve = (key === "mail_vip" || key === "mail_demote") && !isEmptyList(current[key]);
  if (preserve) {
    console.log(`skip ${key} (already populated — not overwriting)`);
    continue;
  }
  const { error } = await admin
    .from("settings")
    .upsert(
      { user_id: owner.id, key, value: DEFAULTS[key] },
      { onConflict: "user_id,key" }
    );
  if (error) throw error;
  console.log(`wrote ${key}`);
}

console.log("\ndone.");
