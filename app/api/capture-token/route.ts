import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";
import { reportSourceStatus } from "@/lib/source-status";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v2.1 — token-authed capture for an iOS Shortcut (trigger via Siri / Action
// Button / Back Tap / Share Sheet). Public route (proxy.ts excludes api/);
// self-authenticates with SHORTCUT_TOKEN via `Authorization: Bearer <token>` or
// `?token=`. Runs the normal capture pipeline.
//
// v4.1 — the same endpoint is now the connector-agent inflow (workstream C).
// A scheduled Claude task posts yesterday's Granola meetings here with
// `source: "granola"` and the meeting id as `externalId`; the id is recorded in
// `inflow_events` so a re-run of the same day is a no-op rather than a
// duplicate. `heartbeat: true` lets the agent report "I ran and there was
// nothing" — which is what keeps the coverage panel honest on a quiet day
// instead of showing a stale ⚠.

/** Sources this endpoint will accept. Anything else falls back to 'shortcut'. */
const ALLOWED_SOURCES = new Set(["shortcut", "granola"]);

type Body = {
  text?: string;
  note?: string;
  q?: string;
  source?: string;
  externalId?: string;
  title?: string;
  attendees?: unknown;
  date?: string;
  heartbeat?: boolean;
};

export async function POST(req: Request) {
  const secret = process.env.SHORTCUT_TOKEN;
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const token = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("token") || "";
  if (!secret || token !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  // Accept JSON {text|note} (+ optional connector fields) or a raw text body.
  let text = "";
  let b: Body = {};
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      b = (await req.json()) as Body;
      text = String(b.text ?? b.note ?? b.q ?? "");
    } else {
      text = await req.text();
    }
  } catch {
    // ignore
  }
  text = text.trim();

  const source = ALLOWED_SOURCES.has(String(b.source ?? "")) ? String(b.source) : "shortcut";
  const externalId = (b.externalId ?? "").trim();
  const heartbeat = b.heartbeat === true;

  if (!text && !heartbeat) return NextResponse.json({ error: "empty" }, { status: 400 });

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  // A heartbeat is the agent saying "I ran, nothing new." It refreshes
  // last_ok so a quiet day doesn't read as a broken source.
  if (heartbeat) {
    await reportSourceStatus(admin, owner.id, {
      source,
      label: source === "granola" ? "Granola" : "iOS Shortcut",
      connected: true,
      error: null,
      detail: { heartbeat_at: new Date().toISOString() },
    });
    return NextResponse.json({ ok: true, heartbeat: true, source });
  }

  // Connector inflow: record the arrival first, and bail out early if this
  // external id has already been ingested. The unique index on
  // (user_id, source, external_id) is what makes re-runs safe.
  let inflowId: string | null = null;
  if (source === "granola" && externalId) {
    const { data: seen } = await admin
      .from("inflow_events")
      .select("id,item_id")
      .eq("user_id", owner.id)
      .eq("source", source)
      .eq("external_id", externalId)
      .maybeSingle();
    if (seen) {
      return NextResponse.json({ ok: true, duplicate: true, itemId: seen.item_id ?? null });
    }

    const ts = b.date ? new Date(b.date) : new Date();
    const { data: ins } = await admin
      .from("inflow_events")
      .insert({
        user_id: owner.id,
        source,
        external_id: externalId,
        ts: Number.isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString(),
        subject: (b.title ?? "").slice(0, 300) || null,
        snippet: text.slice(0, 500),
        participants: Array.isArray(b.attendees) ? b.attendees : [],
        raw_ref: { meetingId: externalId },
        state: "new",
      })
      .select("id")
      .maybeSingle();
    inflowId = (ins?.id as string) ?? null;
  }

  try {
    const outcome = await captureText(owner.id, text, source);
    const itemId = outcome.created[0]?.item.id ?? null;

    if (inflowId) {
      await admin
        .from("inflow_events")
        .update({ state: "actioned", item_id: itemId })
        .eq("id", inflowId);
    }

    if (source === "granola") {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await admin
        .from("inflow_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", owner.id)
        .eq("source", "granola")
        .gte("ts", since);
      await reportSourceStatus(admin, owner.id, {
        source: "granola",
        label: "Granola",
        connected: true,
        events24h: count ?? 0,
        error: null,
      });
      await logAudit(admin, {
        user_id: owner.id,
        item_id: itemId,
        action: "granola_ingested",
        actor: "worker",
        detail: { meetingId: externalId, title: b.title ?? null },
      });
    }

    return NextResponse.json({
      ok: true,
      created: outcome.created.length,
      itemId,
      titles: outcome.created.map((c) => c.item.title),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (source === "granola") {
      await reportSourceStatus(admin, owner.id, {
        source: "granola",
        label: "Granola",
        connected: true,
        error: message.slice(0, 200),
      });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
