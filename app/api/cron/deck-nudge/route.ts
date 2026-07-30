import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { sendMessage, type InlineKeyboard } from "@/lib/telegram";
import { logAudit } from "@/lib/audit";
import { resolveOwnerTz, localHHMM, localDateStr, FALLBACK_TZ } from "@/lib/tz";
import { countDailyUnreviewed, countPendingImportProposals } from "@/app/api/deck/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NUDGE_SENT_ACTION = "deck_nudge_sent";
const DECK_URL = "https://obsidian.manhartgroup.com/deck";
// Mirrors app/api/cron/brief/route.ts's hourly-gate pattern (W4): Vercel Cron
// fires this every hour on the :45 (`45 * * * *` in vercel.json), and this
// handler is the gate — it resolves the owner's CURRENT timezone every tick
// and only actually sends when local time falls in the 20:45-21:45 evening
// window AND nothing has gone out yet for the owner's local calendar date
// (idempotency via the `deck_nudge_sent` audit marker, keyed on
// `detail.localDate`, exactly like `brief_sent`). Every other tick exits fast
// with {skipped:true}. Because the gate re-resolves tz on every tick, this is
// correct across a timezone change mid-week (e.g. PST -> CET) the same way
// the brief cron is — no once-a-day UTC fixed-time gap.
// Floor + late backstop, for the same reason the brief's window was widened
// (see lib/tz.ts): the pinger's real gaps are 1h40m-3h25m, so a 60-minute slot
// gets skipped outright on most days. Send on the first tick after 20:45 local
// and keep accepting until just before midnight — the `deck_nudge_sent` marker
// still guarantees one per local date.
const WINDOW_START = "20:45";
const WINDOW_END = "23:30";

function inWindow(hhmm: string): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const t = toMin(hhmm);
  return t >= toMin(WINDOW_START) && t <= toMin(WINDOW_END);
}

async function alreadySentToday(admin: ReturnType<typeof createAdminClient>, ownerId: string, localDate: string) {
  const { data } = await admin
    .from("audit")
    .select("id")
    .eq("user_id", ownerId)
    .eq("action", NUDGE_SENT_ACTION)
    .eq("detail->>localDate", localDate)
    .limit(1);
  return !!data && data.length > 0;
}

// Evening deck nudge (v4.0 W3). Counts today's unreviewed daily-deck items +
// pending import proposals; if there's anything to review, pushes a Telegram
// message with a URL button that deep-links straight into /deck. `?dry=1`
// reports the count + would-send decision without sending or recording.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  const admin = createAdminClient();
  const { data: list, error: le } = await admin.auth.admin.listUsers();
  if (le) return NextResponse.json({ error: le.message }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  let tz: string;
  try {
    tz = await resolveOwnerTz(admin, owner.id);
  } catch {
    tz = FALLBACK_TZ;
  }
  const localTime = localHHMM(tz);
  const localDate = localDateStr(tz);
  const withinEveningWindow = inWindow(localTime);

  const [{ remaining: dailyRemaining }, importPending] = await Promise.all([
    countDailyUnreviewed(admin, owner.id, tz),
    countPendingImportProposals(admin, owner.id),
  ]);
  const total = dailyRemaining + importPending;

  if (dry) {
    const wouldSend = withinEveningWindow && total > 0 && !(await alreadySentToday(admin, owner.id, localDate));
    return NextResponse.json({ dry: true, wouldSend, tz, localTime, dailyRemaining, importPending, total });
  }

  if (!withinEveningWindow) {
    return NextResponse.json({ skipped: true, reason: "outside-window", tz, localTime, total });
  }
  if (total === 0) {
    return NextResponse.json({ skipped: true, reason: "nothing-to-review", tz, localTime, total });
  }
  if (await alreadySentToday(admin, owner.id, localDate)) {
    return NextResponse.json({ skipped: true, reason: "already-sent", tz, localTime, total });
  }

  const parts: string[] = [];
  if (dailyRemaining > 0) parts.push(`${dailyRemaining} new ${dailyRemaining === 1 ? "memory" : "memories"} today`);
  if (importPending > 0) parts.push(`${importPending} import${importPending === 1 ? "" : "s"} to review`);
  const text = `🃏 ${parts.join(" · ")} — review your deck`;

  const reply_markup: InlineKeyboard = { inline_keyboard: [[{ text: "Open the deck →", url: DECK_URL }]] };
  await sendMessage(text, { parse_mode: "plain", reply_markup });
  await logAudit(admin, {
    user_id: owner.id,
    action: NUDGE_SENT_ACTION,
    actor: "system",
    detail: { dailyRemaining, importPending, total, tz, localDate },
  });

  return NextResponse.json({ ok: true, tz, localTime, dailyRemaining, importPending, total });
}
