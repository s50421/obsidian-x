import type { SupabaseClient } from "@supabase/supabase-js";
import {
  accessTokenFor,
  loadAccounts,
  setHistoryId,
  type GoogleAccount,
} from "@/lib/google-auth";
import {
  getMessageBody,
  getMessageMeta,
  getProfile,
  getThreadMeta,
  listHistoryAdded,
  listLabels,
  listMessageIds,
  parseAddresses,
  type GmailMessageMeta,
} from "@/lib/gmail";
import {
  canSkipContentPass,
  deterministicSignals,
  loadDemote,
  loadIdentities,
  loadStreamMap,
  loadVip,
  othersSpokeLast,
  readMailContent,
  resolveStream,
  scoreMail,
  MIN_CONFIDENCE,
  SURFACE_THRESHOLD,
  type Ranked,
} from "@/lib/rank-mail";
import { reportSourceStatus } from "@/lib/source-status";
import { logLlmUsage } from "@/lib/usage";
import { logAudit } from "@/lib/audit";
import { captureText } from "@/lib/capture-core";

// Obsidian-X v4.1 — Gmail inflow sync.
//
// Design rule (v4.1 brief): mail is INFLOW, not memory. Every message becomes
// an `inflow_events` row holding headers + a snippet. Only messages that clear
// the strict auto-create bar become `items`, and those are routed into the
// evening swipe deck (they carry source='gmail' and today's created_at, which
// is exactly what /api/deck?mode=daily already selects) so the owner still gets
// a one-swipe veto. Everything else stays inflow-only.

/** Owner decision 2026-07-29: 30 days at launch, not the whole archive. */
export const BACKFILL_DAYS = 30;
/** Per-run ceiling so one sync can't blow the serverless time budget. */
const BACKFILL_CAP = 400;
const INCREMENTAL_CAP = 150;
/** Concurrency against the Gmail API — polite, and well inside rate limits. */
const FETCH_CONCURRENCY = 8;

export type SyncResult = {
  mailbox: string;
  mode: "backfill" | "incremental" | "resync";
  seen: number;
  inserted: number;
  ranked: number;
  autoCreated: number;
  skippedLowConfidence: number;
  /** Messages ingested per logical stream, so coverage can report each one. */
  streams: Record<string, number>;
  error?: string;
};

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Which of these message ids do we already have? Keeps sync idempotent. */
async function existingIds(
  admin: SupabaseClient,
  userId: string,
  ids: string[]
): Promise<Set<string>> {
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await admin
      .from("inflow_events")
      .select("external_id")
      .eq("user_id", userId)
      .eq("source", "gmail")
      .in("external_id", chunk);
    for (const r of data ?? []) have.add(r.external_id as string);
  }
  return have;
}

/**
 * Rank one message and write its inflow row. Returns the ranked verdict so the
 * caller can decide about auto-creation.
 */
async function ingestMessage(
  admin: SupabaseClient,
  userId: string,
  account: GoogleAccount,
  token: string,
  msg: GmailMessageMeta,
  vip: Awaited<ReturnType<typeof loadVip>>,
  demote: Awaited<ReturnType<typeof loadDemote>>,
  identities: string[],
  /** The logical inflow stream this message belongs to (see resolveStream) —
   *  the personal address for forwarded mail, else the mailbox itself. */
  stream: string,
  todayISO: string
): Promise<{ ranked: Ranked; inflowId: string | null }> {

  // Thread state ("do I owe a reply?") only matters for non-bulk mail that is
  // part of a conversation — skip the extra API call otherwise.
  let othersLast: boolean | undefined;
  const pre = deterministicSignals(msg, identities, vip, demote);
  if (!pre.bulk && !pre.promotionsLabel && pre.threadReply) {
    try {
      othersLast = othersSpokeLast(await getThreadMeta(token, msg.threadId), identities);
    } catch {
      othersLast = undefined; // thread fetch is best-effort
    }
  }

  const signals = deterministicSignals(msg, identities, vip, demote, othersLast);
  const content = canSkipContentPass(signals)
    ? {
        importance: 0.1,
        deadline: false,
        question: false,
        money: false,
        reason: "bulk/automated — not classified",
        confidence: 1,
        usage: null,
      }
    : await readMailContent(msg, todayISO);

  if (content.usage) await logLlmUsage(admin, userId, "rank_mail", content.usage);

  const ranked = scoreMail(signals, content);

  const from = parseAddresses(msg.headers.from)[0] ?? null;
  const participants = [
    ...(from ? [{ name: from.name, email: from.email, role: "from" }] : []),
    ...parseAddresses(msg.headers.to).map((a) => ({ ...a, role: "to" })),
    ...parseAddresses(msg.headers.cc).map((a) => ({ ...a, role: "cc" })),
  ];

  const { data, error } = await admin
    .from("inflow_events")
    .upsert(
      {
        user_id: userId,
        source: "gmail",
        external_id: msg.id,
        // `account` is the LOGICAL stream, not the mailbox we fetched from —
        // that's what lets forwarded personal mail report as its own source.
        account: stream,
        ts: new Date(msg.internalDate || Date.now()).toISOString(),
        sender: msg.headers.from ?? null,
        participants,
        subject: msg.headers.subject ?? null,
        snippet: msg.snippet.slice(0, 500),
        raw_ref: {
          messageId: msg.id,
          threadId: msg.threadId,
          historyId: msg.historyId ?? null,
          rfcMessageId: msg.headers["message-id"] ?? null,
          mailbox: account.email,
        },
        ranked_score: ranked.score,
        ranked_reason: {
          signals: ranked.signals,
          vip: ranked.vip,
          bulk: ranked.bulk,
          confidence: ranked.confidence,
          reason: ranked.reason,
          autoCreate: ranked.autoCreate,
        },
        state: "new",
      },
      { onConflict: "user_id,source,external_id" }
    )
    .select("id")
    .maybeSingle();

  if (error) return { ranked, inflowId: null };
  return { ranked, inflowId: (data?.id as string) ?? null };
}

/**
 * Turn a high-bar message into a real item. Pulls the body ON DEMAND (the only
 * place full mail text is read) and runs it through the normal capture pipeline
 * so it gets the same title standard, embedding, links and vault projection as
 * everything else.
 */
async function autoCreateItem(
  admin: SupabaseClient,
  userId: string,
  token: string,
  msg: GmailMessageMeta,
  inflowId: string | null
): Promise<string | null> {
  try {
    const body = await getMessageBody(token, msg.id, 8000);
    const from = parseAddresses(msg.headers.from)[0];
    const text =
      `Email from ${from?.name || from?.email || "unknown"} — ${msg.headers.subject ?? "(no subject)"}\n\n` +
      (body || msg.snippet);

    const outcome = await captureText(userId, text, "gmail");
    const itemId = outcome.created[0]?.item.id ?? null;

    if (itemId && inflowId) {
      await admin
        .from("inflow_events")
        .update({ state: "actioned", item_id: itemId })
        .eq("id", inflowId);
    }
    if (itemId) {
      await logAudit(admin, {
        user_id: userId,
        item_id: itemId,
        action: "gmail_auto_created",
        actor: "system",
        detail: { messageId: msg.id, subject: msg.headers.subject ?? null },
      });
    }
    return itemId;
  } catch {
    // Failing to create must not fail the sync — the inflow row still exists,
    // so the message is not lost, it just stays inflow-only.
    return null;
  }
}

/** Sync one mailbox. Never throws — errors come back on the result. */
export async function syncMailbox(
  admin: SupabaseClient,
  userId: string,
  account: GoogleAccount,
  opts: { max?: number } = {}
): Promise<SyncResult> {
  const base: SyncResult = {
    mailbox: account.email,
    mode: "incremental",
    seen: 0,
    inserted: 0,
    ranked: 0,
    autoCreated: 0,
    skippedLowConfidence: 0,
    streams: {},
  };

  let token: string;
  try {
    token = await accessTokenFor(admin, userId, account);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }

  try {
    let ids: string[] = [];
    let mode: SyncResult["mode"] = "incremental";
    let newHistoryId: string | null = null;

    if (!account.history_id) {
      // First run for this mailbox: bounded backfill (owner chose 30 days).
      mode = "backfill";
      ids = await listMessageIds(token, {
        query: `newer_than:${BACKFILL_DAYS}d -in:chats -in:drafts -in:sent`,
        max: opts.max ?? BACKFILL_CAP,
      });
      newHistoryId = (await getProfile(token)).historyId;
    } else {
      const h = await listHistoryAdded(token, account.history_id, opts.max ?? INCREMENTAL_CAP);
      if (h.expired) {
        // The cursor aged out. Re-scan a short window rather than skipping mail —
        // a silent gap is exactly what the completeness law forbids. The
        // dedupe index makes the overlap free.
        mode = "resync";
        ids = await listMessageIds(token, {
          query: "newer_than:3d -in:chats -in:drafts -in:sent",
          max: opts.max ?? INCREMENTAL_CAP,
        });
        newHistoryId = (await getProfile(token)).historyId;
      } else {
        ids = h.ids;
        newHistoryId = h.historyId ?? (await getProfile(token)).historyId;
      }
    }

    base.mode = mode;
    base.seen = ids.length;

    const have = await existingIds(admin, userId, ids);
    const fresh = ids.filter((id) => !have.has(id));

    const vip = await loadVip(admin, userId);
    const demote = await loadDemote(admin, userId);
    // Every address that is "me" — the authenticated mailbox plus any account
    // that forwards into it (the personal Gmail, which an Internal OAuth app
    // cannot be granted directly).
    const identities = await loadIdentities(admin, userId, account.email);
    const streamMap = await loadStreamMap(admin, userId);
    // Only worth a labels call if the owner has actually configured a stream.
    const labelNames = Object.keys(streamMap).length
      ? await listLabels(token).catch(() => new Map<string, string>())
      : new Map<string, string>();
    const todayISO = new Date().toISOString().slice(0, 10);

    const metas = (
      await mapLimit(fresh, FETCH_CONCURRENCY, async (id) => {
        try {
          return await getMessageMeta(token, id);
        } catch {
          return null;
        }
      })
    ).filter((m): m is GmailMessageMeta => !!m);

    for (const msg of metas) {
      const stream = resolveStream(msg.labelIds, labelNames, streamMap, account.email);
      const { ranked, inflowId } = await ingestMessage(
        admin,
        userId,
        account,
        token,
        msg,
        vip,
        demote,
        identities,
        stream,
        todayISO
      );
      base.inserted += 1;
      base.streams[stream] = (base.streams[stream] ?? 0) + 1;
      if (ranked.score >= SURFACE_THRESHOLD) base.ranked += 1;
      // A confident-enough score is required to surface. Low-confidence reads
      // are kept in inflow for /ops tuning and never reach the brief.
      if (ranked.score >= SURFACE_THRESHOLD && ranked.confidence < MIN_CONFIDENCE) {
        base.skippedLowConfidence += 1;
      }
      if (ranked.autoCreate) {
        const itemId = await autoCreateItem(admin, userId, token, msg, inflowId);
        if (itemId) base.autoCreated += 1;
      }
    }

    if (newHistoryId) await setHistoryId(admin, userId, account.email, newHistoryId);
    return base;
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sync every connected mailbox and report coverage. The parent `gmail` row
 * aggregates; each logical STREAM gets its own channel row.
 *
 * Stream, not mailbox, is the right unit here: forwarded personal mail arrives
 * inside the Workspace mailbox but is a separate inflow the owner wants to see
 * counted on its own. Reporting per mailbox would collapse the two and hide
 * exactly the thing the coverage panel exists to show.
 */
export async function syncAllMailboxes(
  admin: SupabaseClient,
  userId: string,
  opts: { max?: number } = {}
): Promise<SyncResult[]> {
  const accounts = await loadAccounts(admin, userId);

  if (!accounts.length) {
    await reportSourceStatus(admin, userId, {
      source: "gmail",
      label: "Gmail",
      connected: false,
      events24h: 0,
      error: null,
      detail: { mailboxes: 0 },
    });
    return [];
  }

  const results: SyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncMailbox(admin, userId, account, opts));
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // One channel row per logical stream, counted straight off the ledger so the
  // number survives a run that ingested nothing.
  const { data: recent } = await admin
    .from("inflow_events")
    .select("account")
    .eq("user_id", userId)
    .eq("source", "gmail")
    .gte("ts", since);

  const per24h: Record<string, number> = {};
  for (const r of recent ?? []) {
    const k = (r.account as string) ?? "unknown";
    per24h[k] = (per24h[k] ?? 0) + 1;
  }

  // Every stream we know about: ones seen this run, ones seen in the last 24h,
  // and every connected mailbox (so a silent stream still has a row rather than
  // disappearing from the panel).
  const streams = new Set<string>([
    ...accounts.map((a) => a.email.toLowerCase()),
    ...Object.keys(per24h),
    ...results.flatMap((r) => Object.keys(r.streams)),
  ]);

  // A mailbox-level failure belongs on every stream that arrives through it.
  const errorFor = (stream: string): string | null => {
    const owning = results.find(
      (r) => r.mailbox.toLowerCase() === stream || Object.hasOwn(r.streams, stream)
    );
    return owning?.error ?? results.find((r) => r.error)?.error ?? null;
  };

  for (const stream of streams) {
    const isMailbox = accounts.some((a) => a.email.toLowerCase() === stream);
    const err = errorFor(stream);
    await reportSourceStatus(admin, userId, {
      source: "gmail",
      channel: stream,
      label: isMailbox ? stream : `${stream} (forwarded)`,
      connected: !err,
      events24h: per24h[stream] ?? 0,
      error: err,
    });
  }

  const count = (recent ?? []).length;

  const errors = results.filter((r) => r.error);
  await reportSourceStatus(admin, userId, {
    source: "gmail",
    label: "Gmail",
    connected: results.some((r) => !r.error),
    events24h: count,
    error: errors.length ? errors.map((e) => `${e.mailbox}: ${e.error}`).join("; ") : null,
    detail: {
      mailboxes: accounts.length,
      streams: [...streams],
      autoCreated: results.reduce((a, r) => a + r.autoCreated, 0),
    },
  });

  return results;
}
