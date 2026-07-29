import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { resolveOwnerTz, localDateStr } from "@/lib/tz";
import { localDayBoundsUtc } from "@/app/deck/day-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v4.0 W3 — the swipe deck. One GET, two modes:
//   ?mode=daily  (default) — every item created "today" (owner-local calendar
//     date), any source except 'system' (digest notes), oldest first.
//   ?mode=import — pending W2 retitle/split proposals, oldest first (a
//     systematic sweep through the imported backlog), joined to their source
//     item for the original-memory preview.
// Both return a flat DeckCard[] the client renders identically; `proposalKind`
// distinguishes an import card from a daily card.

const DAILY_SAFETY_CAP = 500; // a day's captures are bounded; this is a guardrail, not a real limit
const DEFAULT_LIMIT = 20;

type LinkPreview = { id: string; title: string; type: string };

export type DeckCard = {
  mode: "daily" | "import";
  id: string; // item id (daily) or proposal id (import)
  itemId: string; // underlying item id in both modes
  title: string;
  subtitle: string | null; // old title, shown small (import mode)
  type: string;
  tags: string[];
  priority: string | null;
  status: string;
  source: string;
  createdAt: string;
  body: string;
  raw: string | null;
  entities: { name: string; kind: string }[];
  links: LinkPreview[];
  dueAt: string | null;
  // junk pass (v4.0.1) — surfaced, never auto-archived. 0..10, or null. The
  // client badges >= 8 as "would be junk", 5-7 as "possible junk".
  junkScore: number | null;
  // import-only
  proposalKind: "retitle" | "split" | null;
  reason: string | null;
  confidence: number | null;
  newType: string | null;
  newTags: string[] | null;
  parts: { title: string; body: string; type: string; tags: string[] }[] | null;
};

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

// ---- similarity-link preview -------------------------------------------------

async function resolveLinkPreviews(
  admin: SupabaseClient,
  userId: string,
  ids: string[]
): Promise<Map<string, LinkPreview>> {
  const map = new Map<string, LinkPreview>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  const { data } = await admin
    .from("items")
    .select("id,title,type")
    .eq("user_id", userId)
    .in("id", unique);
  for (const r of data ?? []) map.set(r.id, { id: r.id, title: r.title ?? "(untitled)", type: r.type });
  return map;
}

// ---- daily mode ----------------------------------------------------------------

type ItemRow = {
  id: string;
  type: string;
  title: string | null;
  body: string;
  raw: string | null;
  status: string;
  priority: string | null;
  tags: string[] | null;
  source: string;
  links: string[] | null;
  due_at: string | null;
  entities: { name: string; kind: string }[] | null;
  junk_score: number | null;
  created_at: string;
};

// Shared by the GET handler and the evening nudge cron (app/api/cron/deck-nudge):
// today's non-system items (owner-local calendar date) minus whatever's already
// been swiped keep (audit) or archived (status). See the "kept" note below for
// why archive alone isn't enough to detect a reviewed item.
async function fetchTodayCandidates(
  admin: SupabaseClient,
  userId: string,
  tz: string
): Promise<{ todayStr: string; items: ItemRow[] }> {
  const todayStr = localDateStr(tz);
  const { start, end } = localDayBoundsUtc(tz, todayStr);
  const { data } = await admin
    .from("items")
    .select("id,type,title,body,raw,status,priority,tags,source,links,due_at,entities,junk_score,created_at")
    .eq("user_id", userId)
    .neq("source", "system")
    .gte("created_at", start)
    .lt("created_at", end)
    .order("created_at", { ascending: true }) // oldest first, per the brief — the evening sweep works forward through the day
    .limit(DAILY_SAFETY_CAP);
  return { todayStr, items: (data ?? []) as ItemRow[] };
}

// Resolves today's candidates down to the ones still owed a swipe. Single
// source of truth for both the card-list query and the two count-only callers.
async function resolveRemainingDaily(
  admin: SupabaseClient,
  userId: string,
  tz: string
): Promise<{ todayStr: string; total: number; remaining: ItemRow[] }> {
  const { todayStr, items } = await fetchTodayCandidates(admin, userId, tz);
  const total = items.length;

  // "Kept" items are still status='open' (keep never mutates the item) — the
  // only way to know a card was swiped right is the audit trail. Archived
  // items (via deck-left or any other path, e.g. W2's junk pass) are already
  // excluded by status below, so they don't need an audit lookup.
  const ids = items.map((i) => i.id);
  const keptIds = new Set<string>();
  if (ids.length) {
    const { data: auditRows } = await admin
      .from("audit")
      .select("item_id,action,created_at")
      .eq("user_id", userId)
      .in("item_id", ids)
      .in("action", ["deck_reviewed", "deck_reviewed_undo"])
      .order("created_at", { ascending: true });
    for (const row of auditRows ?? []) {
      if (!row.item_id) continue;
      if (row.action === "deck_reviewed") keptIds.add(row.item_id);
      else keptIds.delete(row.item_id); // deck_reviewed_undo — net effect: back in the deck
    }
  }

  const remaining = items.filter((i) => i.status !== "archived" && !keptIds.has(i.id));
  return { todayStr, total, remaining };
}

// Used by app/api/cron/deck-nudge — count only, no card payload.
export async function countDailyUnreviewed(
  admin: SupabaseClient,
  userId: string,
  tz: string
): Promise<{ total: number; reviewed: number; remaining: number }> {
  const { total, remaining } = await resolveRemainingDaily(admin, userId, tz);
  return { total, reviewed: total - remaining.length, remaining: remaining.length };
}

// Used by app/api/cron/deck-nudge — count only, no card payload.
export async function countPendingImportProposals(admin: SupabaseClient, userId: string): Promise<number> {
  const { count } = await admin
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending")
    .in("kind", ["retitle", "split"]);
  return count ?? 0;
}

async function handleDaily(admin: SupabaseClient, userId: string, cursorRaw: string | null, limit: number) {
  const tz = await resolveOwnerTz(admin, userId);
  const { todayStr, total: totalToday, remaining } = await resolveRemainingDaily(admin, userId, tz);
  const reviewed = totalToday - remaining.length;

  const offset = Math.max(0, Number(cursorRaw) || 0);
  const page = remaining.slice(offset, offset + limit);
  const nextCursor = offset + limit < remaining.length ? String(offset + limit) : null;

  const linkPreviews = await resolveLinkPreviews(admin, userId, page.flatMap((i) => i.links ?? []));

  const cards: DeckCard[] = page.map((i) => ({
    mode: "daily",
    id: i.id,
    itemId: i.id,
    title: i.title ?? "(untitled)",
    subtitle: null,
    type: i.type,
    tags: i.tags ?? [],
    priority: i.priority,
    status: i.status,
    source: i.source,
    createdAt: i.created_at,
    body: i.body,
    raw: i.raw,
    entities: i.entities ?? [],
    links: (i.links ?? []).map((id) => linkPreviews.get(id)).filter((x): x is LinkPreview => !!x),
    dueAt: i.due_at,
    junkScore: typeof i.junk_score === "number" ? i.junk_score : null,
    proposalKind: null,
    reason: null,
    confidence: null,
    newType: null,
    newTags: null,
    parts: null,
  }));

  return NextResponse.json({
    mode: "daily",
    tz,
    localDate: todayStr,
    total: totalToday,
    reviewed,
    cards,
    nextCursor,
  });
}

// ---- import mode -----------------------------------------------------------------

type RetitlePayload = {
  itemId?: string;
  oldTitle?: string;
  newTitle?: string;
  newType?: string;
  newTags?: string[];
  dueAt?: string | null;
  entities?: { name: string; kind: string }[];
  confidence?: number;
  reason?: string;
  junkScore?: number;
};

type SplitPart = { title: string; body: string; type: string; tags: string[] };
type SplitPayload = {
  itemId?: string;
  oldTitle?: string;
  parts?: SplitPart[];
  confidence?: number;
  reason?: string;
  junkScore?: number;
};

type ProposalRow = {
  id: string;
  kind: string;
  title: string | null;
  payload: RetitlePayload | SplitPayload | null;
  source_item_id: string | null;
  created_at: string;
};

async function handleImport(admin: SupabaseClient, userId: string, cursorRaw: string | null, limit: number) {
  let q = admin
    .from("proposals")
    .select("id,kind,title,payload,source_item_id,created_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .in("kind", ["retitle", "split"])
    .order("created_at", { ascending: true })
    .limit(limit + 1);
  if (cursorRaw) q = q.gt("created_at", cursorRaw);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as ProposalRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;

  const { count: pendingCount } = await admin
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending")
    .in("kind", ["retitle", "split"]);
  const { count: decidedCount } = await admin
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("status", "pending")
    .in("kind", ["retitle", "split"]);

  const itemIds = [...new Set(page.map((p) => p.source_item_id).filter((x): x is string => !!x))];
  const itemsById = new Map<string, ItemRow>();
  if (itemIds.length) {
    const { data: itemRows } = await admin
      .from("items")
      .select("id,type,title,body,raw,status,priority,tags,source,links,due_at,entities,junk_score,created_at")
      .eq("user_id", userId)
      .in("id", itemIds);
    for (const r of (itemRows ?? []) as ItemRow[]) itemsById.set(r.id, r);
  }
  const linkPreviews = await resolveLinkPreviews(
    admin,
    userId,
    [...itemsById.values()].flatMap((i) => i.links ?? [])
  );

  const cards: DeckCard[] = page
    .map((p): DeckCard | null => {
      const item = p.source_item_id ? itemsById.get(p.source_item_id) : undefined;
      if (!item) return null; // source item missing/deleted — skip, nothing to review
      const isSplit = p.kind === "split";
      const payload = (p.payload ?? {}) as RetitlePayload & SplitPayload;
      const title = isSplit
        ? (payload.parts ?? []).map((pt) => pt.title).join("  •  ") || item.title || "(untitled split)"
        : payload.newTitle ?? item.title ?? "(untitled)";
      return {
        mode: "import",
        id: p.id,
        itemId: item.id,
        title,
        subtitle: payload.oldTitle ?? item.title ?? null,
        type: item.type,
        tags: item.tags ?? [],
        priority: item.priority,
        status: item.status,
        source: item.source,
        createdAt: item.created_at,
        body: item.body,
        raw: item.raw,
        entities: (isSplit ? item.entities : payload.entities ?? item.entities) ?? [],
        links: (item.links ?? []).map((id) => linkPreviews.get(id)).filter((x): x is LinkPreview => !!x),
        dueAt: isSplit ? item.due_at : (payload.dueAt ?? item.due_at ?? null),
        junkScore:
          typeof payload.junkScore === "number"
            ? payload.junkScore
            : typeof item.junk_score === "number"
              ? item.junk_score
              : null,
        proposalKind: isSplit ? "split" : "retitle",
        reason: payload.reason ?? null,
        confidence: typeof payload.confidence === "number" ? payload.confidence : null,
        newType: isSplit ? null : (payload.newType ?? null),
        newTags: isSplit ? null : (payload.newTags ?? null),
        parts: isSplit ? (payload.parts ?? []) : null,
      };
    })
    .filter((c): c is DeckCard => !!c);

  return NextResponse.json({
    mode: "import",
    total: (pendingCount ?? 0) + (decidedCount ?? 0),
    reviewed: decidedCount ?? 0,
    cards,
    nextCursor,
  });
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "import" ? "import" : "daily";
  const limit = clampLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor");

  const admin = createAdminClient();
  return mode === "import" ? handleImport(admin, user.id, cursor, limit) : handleDaily(admin, user.id, cursor, limit);
}
