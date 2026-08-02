// Obsidian-X — send the owner a real letter on demand, over any window.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings \
//     scripts/send-test-letter.mjs [--hours 72] [--dry]
//
// Uses the REAL composer, the REAL data and the REAL inline keyboard, so the
// buttons that come back (👍/👎, ✓ Handled, ✓ task) are live and their taps are
// recorded exactly as they would be at 06:45. The only difference from the cron
// is the window: the interesting mail is often older than 24h when you want to
// look at it, and a letter that reads "Nothing needs you" demonstrates nothing.
//
// Deliberately SKIPS the two side-effecting steps the real letter performs —
// draft pre-generation and the ClickUp projection — so a test send never
// creates proposals, tasks or model spend. The "📝 Draft" button still works;
// it falls back to generating on demand.
//
// Sends to the OWNER only, via the product's own Telegram channel. Per the hard
// rule in AGENTS.md, nothing here can address anyone else.

import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);

const { composeLetter, loadInflow, loadActionItems } = await import("../lib/letter.ts");
const { loadSourceStatus, ensureDeclaredSources } = await import("../lib/source-status.ts");
const { fetchUpcomingEventsWithStatus } = await import("../lib/calendar.ts");
const { getDailyBriefing } = await import("../lib/news.ts");
const { latestMorningBrew } = await import("../lib/podcast.ts");
const { sendMessage } = await import("../lib/telegram.ts");
const { localDateStr } = await import("../lib/tz.ts");
const { rescoreRows } = await import("./_rescore.mjs");

const argv = process.argv;
const hours = Number(argv[argv.indexOf("--hours") + 1]) || 24;
const DRY = argv.includes("--dry");
// Rows ingested before the ranker fix still carry their old scores. Replaying
// them in memory shows what the CURRENT ranker makes of them, without
// overwriting real measurements in the database.
const RESCORE = argv.includes("--rescore");

const TZ = process.env.BRIEF_TZ || "America/Vancouver";
const now = new Date();
const since = new Date(now.getTime() - hours * 3600 * 1000);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const { data: users } = await admin.auth.admin.listUsers();
const owner = users.users.find((u) => (u.email ?? "").toLowerCase() === process.env.OWNER_EMAIL.toLowerCase());

const localDate = localDateStr(TZ, now);
await ensureDeclaredSources(admin, owner.id);

const { events } = await fetchUpcomingEventsWithStatus(24);
// Prep notes are built inside the cron route itself rather than in a lib, so
// they are omitted here. They only fire under a matching calendar event, so
// this changes nothing whenever the day is empty.
const [inflow, actions, statusRows, news, episode] = await Promise.all([
  loadInflow(admin, owner.id, since),
  loadActionItems(admin, owner.id, TZ, now),
  loadSourceStatus(admin, owner.id),
  getDailyBriefing(admin, owner.id, localDate, { refresh: false }),
  latestMorningBrew(),
]);

const WORTH_KNOWING_FLOOR = 30;
const ranked = RESCORE
  ? (await rescoreRows(inflow, { admin, userId: owner.id }))
      .filter((r) => (r.ranked_score ?? 0) >= WORTH_KNOWING_FLOOR)
      .sort((a, b) => (b.ranked_score ?? 0) - (a.ranked_score ?? 0))
  : inflow;

const letter = composeLetter({
  tz: TZ,
  now,
  events,
  statusRows,
  inflow: ranked,
  actions,
  briefing: { digest: news.digest, episode, error: news.error },
});

console.log(letter.text);
console.log("\n--- buttons ---");
for (const row of letter.keyboard?.inline_keyboard ?? []) {
  // Print whichever the button actually carries. Printing only callback_data
  // made every URL button look broken ("→ undefined") and cost a real detour.
  console.log(row.map((b) => `[${b.text}] → ${b.callback_data ?? b.url}`).join("  "));
}
console.log(
  `\nwindow: ${hours}h (since ${since.toISOString()}) · inflow rows: ${ranked.length}` +
    (RESCORE ? " · rescored in memory (DB untouched)" : "")
);

if (DRY) {
  console.log("\n(dry — not sent)");
} else {
  const ok = await sendMessage(letter.text, { parse_mode: "plain", reply_markup: letter.keyboard });
  console.log(ok ? "\n✅ sent to the owner's Telegram" : "\n❌ send failed");
}
