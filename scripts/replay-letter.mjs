// Obsidian-X — replay a real morning's letter from the mail that actually arrived.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings \
//     scripts/replay-letter.mjs 2026-08-01
//
// The letter is the product, so "is it good?" can only be answered against real
// inflow, not fixtures. This reads the REAL inflow_events for the 24h window a
// given morning's letter would have used and runs the REAL composer over them.
// It sends nothing and writes nothing.
//
// Why this exists: on 2026-08-01 the delivered letter's entire NEEDS YOU
// section was three Canvas notifications whose own ranked reason said "no
// action required". Replaying the morning is how that gets seen rather than
// argued about.

import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { composeLetter } = await import("../lib/letter.ts");
const { scoreMail, deterministicSignals, loadVip, loadDemote, loadIdentities } = await import(
  "../lib/rank-mail.ts"
);

// --rescore replays the SAME mail through the CURRENT ranker, holding the
// stored model read fixed so the scoring change is the only variable.
const RESCORE = process.argv.includes("--rescore");

const TZ = process.env.BRIEF_TZ || "America/Vancouver";
const dateArg = process.argv[2];
if (!dateArg) {
  console.error("usage: replay-letter.mjs <YYYY-MM-DD>   (owner-local date)");
  process.exit(1);
}

// The letter fires ~06:45 local; the window is the preceding 24h.
const sendLocal = new Date(`${dateArg}T13:45:00.000Z`); // 06:45 America/Vancouver
const since = new Date(sendLocal.getTime() - 24 * 3600 * 1000);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: users } = await admin.auth.admin.listUsers();
const owner = users.users.find((u) => u.email === process.env.OWNER_EMAIL);

const WORTH_KNOWING_FLOOR = 30;

let { data: inflow } = await admin
  .from("inflow_events")
  .select("id,subject,sender,snippet,ranked_score,ranked_reason,item_id,account,ts,state")
  .eq("user_id", owner.id)
  .gte("ts", since.toISOString())
  .lt("ts", sendLocal.toISOString())
  // The owner's own "✓ Handled" taps are respected; 'actioned' (set by
  // auto-create) is not a reason to hide mail — see lib/letter.ts loadInflow.
  .neq("state", "dismissed")
  .order("ranked_score", { ascending: false })
  .limit(60);

if (RESCORE) {
  const vip = await loadVip(admin, owner.id);
  const demote = await loadDemote(admin, owner.id);
  const identities = await loadIdentities(admin, owner.id, "david@manhartgroup.com");

  inflow = inflow.map((r) => {
    const rr = r.ranked_reason ?? {};
    const sig = new Set(rr.signals ?? []);
    // Recover the model's importance from the stored total by subtracting the
    // deterministic contributions. Exact for uncapped rows, and the BAND is
    // what this replay is judging.
    const base =
      (r.ranked_score ?? 0) -
      (sig.has("VIP sender") ? 35 : 0) -
      (sig.has("direct to me") ? 15 : 0) -
      (sig.has("awaiting my reply") ? 20 : sig.has("thread reply") ? 5 : 0) -
      (sig.has("deadline") ? 20 : 0) -
      (sig.has("direct question") ? 15 : 0) -
      (sig.has("money/legal") ? 15 : 0);
    const c = {
      importance: Math.min(1, Math.max(0, base / 25)),
      deadline: sig.has("deadline"),
      question: sig.has("direct question"),
      money: sig.has("money/legal"),
      reason: rr.reason ?? "",
      confidence: Number(rr.confidence ?? 0),
      usage: null,
    };
    const meta = {
      id: r.id,
      snippet: r.snippet ?? "",
      labelIds: sig.has("promotions") ? ["CATEGORY_PROMOTIONS"] : [],
      headers: {
        from: r.sender ?? "",
        to: sig.has("direct to me") ? identities[0] : "someone-else@example.com",
        subject: r.subject ?? "",
        date: r.ts,
        "list-unsubscribe": sig.has("bulk") ? "<mailto:x@y.z>" : "",
        "auto-submitted": sig.has("automated") ? "auto-generated" : "",
        "in-reply-to": sig.has("thread reply") ? "<x@y.z>" : "",
      },
    };
    const next = scoreMail(deterministicSignals(meta, identities, vip, demote, false), c);
    return { ...r, ranked_score: next.score, ranked_reason: { ...rr, signals: next.signals } };
  });
}

inflow = inflow
  .filter((r) => (r.ranked_score ?? 0) >= WORTH_KNOWING_FLOOR)
  .sort((a, b) => (b.ranked_score ?? 0) - (a.ranked_score ?? 0));

const letter = composeLetter({
  tz: TZ,
  now: sendLocal,
  events: [],
  statusRows: [],
  inflow: inflow ?? [],
  actions: [],
});

console.log(`\n### Replay of the ${dateArg} letter (window ${since.toISOString()} → ${sendLocal.toISOString()})`);
console.log(`### ${(inflow ?? []).length} messages scored ≥ ${WORTH_KNOWING_FLOOR} in that window\n`);
console.log(letter.text.split("\n— — —")[0]);

console.log("\n--- what the ranker thought of each ---");
for (const r of inflow ?? []) {
  const rr = r.ranked_reason ?? {};
  console.log(
    `[${String(r.ranked_score).padStart(2)}] conf=${rr.confidence} ${(r.sender || "").slice(0, 42)}\n` +
      `      "${(r.subject || "").slice(0, 70)}"\n` +
      `      ${rr.reason}\n` +
      `      signals: ${(rr.signals || []).join(", ")}`
  );
}
