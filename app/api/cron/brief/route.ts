import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { checkTelegramHealth, sendMessage } from "@/lib/telegram";
import { fetchUpcomingEventsWithStatus, type CalEvent } from "@/lib/calendar";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";
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
import { loadProjectableTasks, projectActionItems } from "@/lib/task-projection";
import { getDailyBriefing } from "@/lib/news";
import { latestMorningBrew } from "@/lib/podcast";
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
// Timing — TWO independent triggers, because one wasn't enough:
//   1. Vercel Cron, once daily at 13:20 UTC. That's 06:20 in the owner's home
//      timezone (America/Vancouver), so it lands squarely in the window
//      whenever they're home. Reliable, but fixed-UTC, so it drifts out of the
//      window as soon as they travel.
//   2. The GitHub Actions pinger, all day. Timezone-proof, but its real firing
//      gaps are 1h40m-3h25m on the free tier.
// Neither alone is sufficient: (1) misses when travelling, (2) missed the
// entire 60-minute window on 2026-07-30 and no letter arrived. Together with
// the widened window (lib/tz.ts) delivery is effectively guaranteed, and the
// `brief_sent` marker keyed on the owner's LOCAL date means the two triggers
// can never produce two letters.
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
      // match_neighbors_v2, NOT match_items_v2: the latter returns SETOF items
      // and therefore carries no `similarity` column. Reading it gave
      // undefined -> 0, so the threshold below was always false and prep notes
      // could never appear. Silent dead code from the day it shipped.
      const { data } = await admin.rpc("match_neighbors_v2", {
        query_embedding: embedding,
        owner: userId,
        exclude_id: null,
        match_count: 2,
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
  // The news fetch and the podcast feed run alongside everything else — both
  // are best-effort and neither can fail the letter. `refresh=1` forces a new
  // search; otherwise the digest is cached on the owner's local date so a
  // preview costs nothing and reads exactly like what was delivered.
  const refreshNews = params.get("refresh") === "1";
  const [inflow, actions, statusRows, prep, news, episode] = await Promise.all([
    loadInflow(admin, owner.id, since),
    loadActionItems(admin, owner.id, tz, now),
    loadSourceStatus(admin, owner.id),
    buildPrepNotes(admin, owner.id, events),
    getDailyBriefing(admin, owner.id, localDate, { refresh: refreshNews }),
    latestMorningBrew(),
  ]);
  if (news.usage) await logLlmUsage(admin, owner.id, "news", news.usage);

  // Drafts for the mail that wants a reply, and the ClickUp projection. Both
  // are skipped entirely on preview so a review pass costs nothing and writes
  // no proposals, tasks or spend.
  let drafted = new Set<string>();
  let projection = null as Awaited<ReturnType<typeof projectActionItems>> | null;
  // Tasks that qualified for the board but were held back by this run's cap.
  // Reported rather than dropped silently — a cap the owner can't see reads
  // exactly like a projection that quietly stopped working.
  let projectionBacklog = 0;
  if (!preview) {
    drafted = await pregenerateDrafts(admin, owner.id, inflow as InflowRow[]);
    // v4.2 B — today's action items ARE the board by the time the letter lands.
    //
    // The board gets MORE than today, though: a task dated weeks out still
    // belongs on the kanban now, and projecting only today's items is why the
    // Nano Nuclear vote never appeared there. Union, deduped by id — today's
    // items keep priority, and loadProjectableTasks caps the rest so a backlog
    // arrives over several mornings instead of as one wall of approvals.
    const extra = await loadProjectableTasks(admin, owner.id);
    const seen = new Set(actions.map((a) => a.id));
    const toProject = [...actions, ...extra.tasks.filter((t) => !seen.has(t.id))];
    projection = await projectActionItems(admin, owner.id, toProject);
    if (extra.remaining) projectionBacklog = extra.remaining;
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
    briefing: { digest: news.digest, episode, error: news.error },
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
      news: news.digest ? { sources: news.digest.sources, cached: !news.usage } : null,
      newsError: news.error,
      podcast: episode?.title ?? null,
      letter: letter.text,
    });
  }

  // Plain text on purpose: the letter carries subjects and sender names the
  // owner never wrote, and one stray asterisk would break Markdown parsing for
  // the whole message.
  // sendMessage is best-effort by design (a Telegram hiccup must never throw
  // into a cron), but discarding its result meant this route reported ok:true
  // for a letter that was never delivered — the same class of invisible failure
  // as the missed window. A send that didn't land is now an error, and the
  // once-a-day marker is NOT written, so the next tick retries.
  const delivery = await sendMessage(letter.text, {
    parse_mode: "plain",
    reply_markup: letter.keyboard,
  });
  if (!delivery) {
    await logAudit(admin, {
      user_id: owner.id,
      action: "brief_send_failed",
      actor: "system",
      detail: { tz, localDate, localTime },
    });
    return NextResponse.json(
      { ok: false, sent: false, error: "telegram rejected the message", tz, localTime },
      { status: 502 }
    );
  }

  if (!force) {
    await logAudit(admin, {
      user_id: owner.id,
      action: BRIEF_SENT_ACTION,
      actor: "system",
      // localTime is recorded so delivery punctuality is measurable rather
      // than assumed — the 2026-07-30 miss was invisible until it was looked for.
      detail: { ...letter.counts, tz, localDate, localTime, drafts: drafted.size, projection },
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
    sent: true,
    messageId: delivery.message_id,
    forced: force,
    tz,
    localTime,
    counts: letter.counts,
    coverage: letter.coverage,
    drafts: drafted.size,
    projection: projection ? { ...projection, backlog: projectionBacklog } : null,
  });
}
