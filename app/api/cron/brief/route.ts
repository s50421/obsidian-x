import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { checkTelegramHealth, sendMessage } from "@/lib/telegram";
import { fetchUpcomingEventsWithStatus, type CalEvent } from "@/lib/calendar";
import { logAudit } from "@/lib/audit";
import { embedText } from "@/lib/embed";
import {
  ensureDeclaredSources,
  loadSourceStatus,
  reportSourceStatus,
} from "@/lib/source-status";
import {
  composeLetter,
  eventKey,
  loadActionItems,
  loadInflow,
  type InflowRow,
} from "@/lib/letter";
import { pregenerateDrafts } from "@/lib/letter-drafts";
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

// v4.2 — THE DAILY LETTER. The brief is no longer a recap; it's a decision
// queue (see lib/letter.ts for the section contract and why the order is
// fixed). This route is the plumbing around that: the timezone gate, the
// once-a-day marker, data loading, drafts, and delivery.
//
// Timing: still fired repeatedly by the GitHub Actions pinger and self-gated to
// ~6:30am LOCAL. Only the first in-window tick of the owner's local date
// actually sends.
//
//   ?dry=1     — would it fire? (no build, no send)
//   ?preview=1 — build the real letter and return it WITHOUT sending or
//                recording. This is how the letter gets reviewed.
//   ?force=1   — send now, bypassing the window and the once-a-day gate, and
//                deliberately do NOT record the marker so the real 6:30am
//                delivery still happens.

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

/**
 * A one-line "you already know something about this" note per meeting.
 *
 * Deliberately conservative: only a strong semantic hit counts, and only the
 * single best one is shown. A weak association printed under a meeting is
 * noise at 6:30am, and noise is what makes a letter stop being read.
 */
const PREP_MIN_SIMILARITY = 0.55;
const PREP_MAX_EVENTS = 4;

async function buildPrepNotes(
  admin: SupabaseClient,
  userId: string,
  events: CalEvent[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const soon = events.filter((e) => !e.allDay).slice(0, PREP_MAX_EVENTS);
  for (const e of soon) {
    try {
      const embedding = await embedText(e.summary, userId);
      const { data } = await admin.rpc("match_items_v2", {
        query_embedding: embedding,
        query_text: e.summary,
        match_count: 2,
        owner: userId,
      });
      const hit = (data ?? [])[0] as { title?: string; similarity?: number } | undefined;
      if (hit?.title && Number(hit.similarity ?? 0) >= PREP_MIN_SIMILARITY) {
        out.set(eventKey(e), `you have notes: ${hit.title}`);
      }
    } catch {
      // prep notes are a nicety — never let one failure cost the letter
    }
  }
  return out;
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1";
  const force = params.get("force") === "1";
  const preview = params.get("preview") === "1";

  const admin = createAdminClient();
  const { data: list, error: le } = await admin.auth.admin.listUsers();
  if (le) return NextResponse.json({ error: le.message }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

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

  if (!force && !preview) {
    if (!inWindow) {
      return NextResponse.json({ skipped: true, reason: "outside-window", tz, localTime });
    }
    if (await alreadySentForLocalDate(admin, owner.id, localDate)) {
      return NextResponse.json({ skipped: true, reason: "already-sent", tz, localTime });
    }
  }

  // ---- coverage (v4.1) --------------------------------------------------------
  const { events, calendars } = await fetchUpcomingEventsWithStatus(24);
  const calOk = calendars.filter((c) => c.ok).length;
  const calFailed = calendars.filter((c) => !c.ok);
  await reportSourceStatus(admin, owner.id, {
    source: "calendar",
    label: "Calendars",
    connected: calendars.length > 0,
    events24h: events.length,
    error: calFailed.length
      ? `${calFailed.length} of ${calendars.length} failed: ${calFailed.map((c) => c.name).slice(0, 3).join(", ")}`
      : null,
    detail: { total: calendars.length, ok: calOk },
  });
  for (const c of calendars) {
    await reportSourceStatus(admin, owner.id, {
      source: "calendar",
      channel: c.name,
      label: c.name,
      connected: c.ok,
      events24h: c.count,
      error: c.error,
    });
  }

  await ensureDeclaredSources(admin, owner.id);
  const tgHealth = await checkTelegramHealth();
  await reportSourceStatus(admin, owner.id, {
    source: "telegram",
    label: "Telegram",
    connected: tgHealth.ok,
    error: tgHealth.error,
  });

  // ---- the letter's contents --------------------------------------------------
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const [inflow, actions, statusRows, prep] = await Promise.all([
    loadInflow(admin, owner.id, since),
    loadActionItems(admin, owner.id, tz, now),
    loadSourceStatus(admin, owner.id),
    buildPrepNotes(admin, owner.id, events),
  ]);

  // Drafts for the mail that wants a reply. Skipped entirely on preview so a
  // review pass costs nothing and writes no proposals.
  let drafted = new Set<string>();
  if (!preview) {
    drafted = await pregenerateDrafts(admin, owner.id, inflow as InflowRow[]);
  }

  const letter = composeLetter({
    tz,
    now,
    events,
    statusRows,
    inflow,
    actions,
    prep,
    draftedInflowIds: drafted,
  });

  if (preview) {
    return NextResponse.json({
      preview: true,
      sent: false,
      tz,
      localTime,
      counts: letter.counts,
      coverage: letter.coverage,
      calendars: { total: calendars.length, ok: calOk, failed: calFailed.map((c) => c.name) },
      buttons: letter.keyboard?.inline_keyboard.flat().map((b) => b.text) ?? [],
      letter: letter.text,
    });
  }

  // Plain text on purpose: the letter carries subjects and sender names the
  // owner never wrote, and one stray asterisk would break Markdown parsing for
  // the whole message.
  await sendMessage(letter.text, { parse_mode: "plain", reply_markup: letter.keyboard });

  if (!force) {
    await logAudit(admin, {
      user_id: owner.id,
      action: BRIEF_SENT_ACTION,
      actor: "system",
      detail: { ...letter.counts, tz, localDate, drafts: drafted.size },
    });
  }

  // Mark what was shown so tomorrow's letter doesn't repeat it. Items that
  // became real items keep their own state.
  if (letter.surfacedInflowIds.length) {
    await admin
      .from("inflow_events")
      .update({ state: "surfaced" })
      .eq("user_id", owner.id)
      .eq("state", "new")
      .in("id", letter.surfacedInflowIds);
  }

  return NextResponse.json({
    ok: true,
    forced: force,
    tz,
    localTime,
    counts: letter.counts,
    coverage: letter.coverage,
    drafts: drafted.size,
  });
}
