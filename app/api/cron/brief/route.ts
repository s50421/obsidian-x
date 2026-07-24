import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { sendMessage, type InlineKeyboard } from "@/lib/telegram";
import { fetchUpcomingEvents } from "@/lib/calendar";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = process.env.BRIEF_TZ || "America/Los_Angeles";

function timeFmt(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

// Morning brief: next 24h of calendar events (all calendars) + items due soon,
// pushed to Telegram. Triggered by Vercel Cron (or a manual authorized call).
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: list, error: le } = await admin.auth.admin.listUsers();
  if (le) return NextResponse.json({ error: le.message }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  const events = await fetchUpcomingEvents(24);

  const in24 = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
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
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date());

  const eventsText = events.length
    ? events
        .map(
          (e) =>
            `• ${e.allDay ? "All day" : timeFmt(e.start)} — ${e.summary}${e.location ? ` @ ${e.location}` : ""}  _(${e.calendar})_`
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
    action: "morning_brief",
    actor: "system",
    detail: { events: events.length, due: due.length },
  });

  return NextResponse.json({ ok: true, events: events.length, due: due.length });
}
