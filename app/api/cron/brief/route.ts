import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { sendMessage, type InlineKeyboard } from "@/lib/telegram";
import { fetchUpcomingEvents } from "@/lib/calendar";
import { logAudit } from "@/lib/audit";
import {
  resolveOwnerTz,
  localHHMM,
  localDateStr,
  isWithinBriefWindow,
  FALLBACK_TZ,
} from "@/lib/tz";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BRIEF_SENT_ACTION = "brief_sent";

function timeFmt(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

// Has the letter already gone out for this owner's current LOCAL calendar
// date? Recorded as `detail.localDate` on a `brief_sent` audit row (see the
// write-side at the bottom of GET) — this is what makes the hourly gate
// idempotent: many cron ticks fall inside the 06:15-07:15 window, but only
// the first one sends.
async function alreadySentForLocalDate(
  admin: SupabaseClient,
  ownerId: string,
  localDate: string
): Promise<boolean> {
  const { data } = await admin
    .from("audit")
    .select("id")
    .eq("user_id", ownerId)
    .eq("action", BRIEF_SENT_ACTION)
    .eq("detail->>localDate", localDate)
    .limit(1);
  return !!data && data.length > 0;
}

// Morning brief: next 24h of calendar events (all calendars) + items due soon,
// pushed to Telegram — timed to land at 6:30am wherever the owner is (v4.0 W4).
//
// Triggered every hour on the half-hour by Vercel Cron (`30 * * * *`); this
// handler is the gate: it resolves the owner's current timezone, and only
// actually builds + sends the letter when local time falls in a window around
// 6:30am AND it hasn't already sent today (owner's local date). Every other
// tick exits fast with {skipped:true}. `?dry=1` reports what WOULD happen
// without sending or recording anything.
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

  // Resolve the owner's timezone (settings override -> calendar inference ->
  // America/Vancouver). resolveOwnerTz is designed to never throw; BRIEF_TZ is
  // now only a last-resort fallback if resolution totally fails unexpectedly.
  let tz: string;
  try {
    tz = await resolveOwnerTz(admin, owner.id);
  } catch {
    tz = process.env.BRIEF_TZ || FALLBACK_TZ;
  }

  const now = new Date();
  const localTime = localHHMM(tz, now);
  const localDate = localDateStr(tz, now);
  const inWindow = isWithinBriefWindow(localTime);

  if (dry) {
    const wouldSend = inWindow && !(await alreadySentForLocalDate(admin, owner.id, localDate));
    return NextResponse.json({ dry: true, wouldSend, tz, localTime });
  }

  if (!inWindow) {
    return NextResponse.json({ skipped: true, reason: "outside-window", tz, localTime });
  }
  if (await alreadySentForLocalDate(admin, owner.id, localDate)) {
    return NextResponse.json({ skipped: true, reason: "already-sent", tz, localTime });
  }

  const events = await fetchUpcomingEvents(24);

  const in24 = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const { data: dueItems } = await admin
    .from("items")
    .select("id,title,due_at")
    .eq("user_id", owner.id)
    .eq("status", "open")
    .is("valid_to", null)
    .not("due_at", "is", null)
    .lte("due_at", in24)
    .order("due_at");

  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);

  const eventsText = events.length
    ? events
        .map(
          (e) =>
            `• ${e.allDay ? "All day" : timeFmt(tz, e.start)} — ${e.summary}${e.location ? ` @ ${e.location}` : ""}  _(${e.calendar})_`
        )
        .join("\n")
    : "_nothing scheduled_";

  const due = dueItems ?? [];
  const dueText = due.length
    ? due.map((d) => `• ${d.title}${d.due_at ? ` _(due ${d.due_at.slice(0, 10)})_` : ""}`).join("\n")
    : "_nothing due_";

  const brief =
    `☀️ *Morning brief — ${dateStr}*\n\n` +
    `*Next 24h (${events.length}):*\n${eventsText}\n\n` +
    `*Due soon (${due.length}):*\n${dueText}`;

  // One ✓ Done button per due item — tap to complete straight from the brief.
  const reply_markup: InlineKeyboard | undefined = due.length
    ? {
        inline_keyboard: due.map((d) => [
          { text: `✓ ${d.title.slice(0, 40)}`, callback_data: `done:${d.id}` },
        ]),
      }
    : undefined;

  await sendMessage(brief, { reply_markup });
  await logAudit(admin, {
    user_id: owner.id,
    action: BRIEF_SENT_ACTION,
    actor: "system",
    detail: { events: events.length, due: due.length, tz, localDate },
  });

  return NextResponse.json({ ok: true, events: events.length, due: due.length, tz, localTime });
}
