// Obsidian-X — re-score already-ingested mail with the CURRENT ranker.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings \
//     scripts/rescore-inflow.mjs           # dry run, prints before → after
//   … scripts/rescore-inflow.mjs --write   # persist the new scores
//
// The ranker's deterministic layer is pure, so a change to it can be evaluated
// against the real corpus instead of against fixtures — which matters because
// every ranking bug found so far was invisible until real mail arrived.
//
// The LLM content read is NOT re-run: it is stored on the row, it costs money,
// and holding it fixed is what isolates the scoring change as the only variable.

import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { scoreMail, deterministicSignals, loadVip, loadDemote, loadIdentities } = await import(
  "../lib/rank-mail.ts"
);

const WRITE = process.argv.includes("--write");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: users } = await admin.auth.admin.listUsers();
const owner = users.users.find((u) => u.email === process.env.OWNER_EMAIL);

const vip = await loadVip(admin, owner.id);
const demote = await loadDemote(admin, owner.id);
const identities = await loadIdentities(admin, owner.id, "david@manhartgroup.com");

const { data: rows } = await admin
  .from("inflow_events")
  .select("id,subject,sender,snippet,ranked_score,ranked_reason,raw_ref,state,item_id,ts")
  .eq("user_id", owner.id)
  .eq("source", "gmail")
  .order("ts");

// Rebuild the GmailMessageMeta shape the ranker expects from what was stored.
// Only the headers that feed deterministic signals survive on the row, so this
// reconstruction is faithful for exactly the fields being tested.
function toMeta(r) {
  const rr = r.ranked_reason ?? {};
  const signals = new Set(rr.signals ?? []);
  return {
    id: r.id,
    snippet: r.snippet ?? "",
    labelIds: signals.has("promotions") ? ["CATEGORY_PROMOTIONS"] : [],
    headers: {
      from: r.sender ?? "",
      to: signals.has("direct to me") ? identities[0] : "someone-else@example.com",
      cc: "",
      subject: r.subject ?? "",
      date: r.ts,
      "list-unsubscribe": signals.has("bulk") ? "<mailto:x@y.z>" : "",
      "auto-submitted": signals.has("automated") ? "auto-generated" : "",
      "in-reply-to": signals.has("thread reply") ? "<x@y.z>" : "",
    },
  };
}

const contentOf = (r) => {
  const rr = r.ranked_reason ?? {};
  const sig = new Set(rr.signals ?? []);
  const base = (r.ranked_score ?? 0) -
    (sig.has("VIP sender") ? 35 : 0) -
    (sig.has("direct to me") ? 15 : 0) -
    (sig.has("awaiting my reply") ? 20 : sig.has("thread reply") ? 5 : 0) -
    (sig.has("deadline") ? 20 : 0) -
    (sig.has("direct question") ? 15 : 0) -
    (sig.has("money/legal") ? 15 : 0);
  return {
    importance: Math.min(1, Math.max(0, base / 25)),
    deadline: sig.has("deadline"),
    question: sig.has("direct question"),
    money: sig.has("money/legal"),
    reason: rr.reason ?? "",
    confidence: Number(rr.confidence ?? 0),
    usage: null,
  };
};

const SURFACE = 55;
const MENTION = 30;
const band = (n) => (n >= SURFACE ? "NEEDS YOU " : n >= MENTION ? "worth know" : "—         ");

let moved = 0;
for (const r of rows) {
  // A capped/floored score can't be inverted, so rows the old ranker pinned are
  // reconstructed approximately; the BAND is what matters here.
  const s = deterministicSignals(toMeta(r), identities, vip, demote, false);
  const c = contentOf(r);
  const next = scoreMail(s, c);
  const before = r.ranked_score ?? 0;
  if (band(before) === band(next.score) && Math.abs(before - next.score) < 3) continue;
  moved++;
  console.log(
    `${band(before)} ${String(before).padStart(2)} → ${band(next.score)} ${String(next.score).padStart(2)}  ` +
      `${(r.sender ?? "").slice(0, 38)}\n      "${(r.subject ?? "").slice(0, 66)}"\n` +
      `      ${next.signals.join(", ")}${next.autoCreate ? "  [AUTO-CREATE]" : ""}`
  );
  if (WRITE) {
    await admin
      .from("inflow_events")
      .update({
        ranked_score: next.score,
        ranked_reason: {
          ...(r.ranked_reason ?? {}),
          signals: next.signals,
          vip: next.vip,
          bulk: next.bulk,
          autoCreate: next.autoCreate,
          rescored: "2026-08-02",
        },
      })
      .eq("id", r.id);
  }
}
console.log(`\n${moved} of ${rows.length} messages changed band or score. ${WRITE ? "WRITTEN." : "(dry run)"}`);
