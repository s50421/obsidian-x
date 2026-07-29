// Obsidian-X v4.0 W2 — shared plumbing for the two corpus scripts:
//
//   scripts/retitle-sample.mjs    the owner-approval harness (read-only)
//   scripts/reprocess-corpus.mjs  the full pass (writes proposals)
//
// Both must classify EXACTLY the same way, or the sample David approves is not
// the run he gets. The prompt and the sanitisers come from lib/title-standard.mjs
// (shared with the live capture path); this file only adds the corpus-specific
// plumbing: the DB query, the OpenRouter call, the worker pool and the costing.

import { createClient } from "@supabase/supabase-js";
import { buildReprocessSystem, parseReprocessReply } from "../lib/title-standard.mjs";

// --- pricing ---------------------------------------------------------------
// OPENROUTER_CLASSIFY_MODEL is claude-haiku-4.5 (see instructions/PROJECT-STATE.md).
// USD per 1M tokens, 2026-07. Only used for the printed estimate; the real spend
// is whatever OpenRouter reports back per call, which is what gets logged.
export const HAIKU_USD_IN_PER_M = 1.0;
export const HAIKU_USD_OUT_PER_M = 5.0;

// The system prompt is ~1,100 tokens and the JSON reply ~180; the note itself
// averaged ~380 tokens across the apple-notes corpus.
export const EST_PROMPT_TOKENS = 1_500;
export const EST_COMPLETION_TOKENS = 200;

// Chars of the note shown to the classifier. Long enough for any real note,
// short enough that one runaway row can't blow the budget.
export const MAX_CLASSIFY_CHARS = 12_000;

export function estimateCostUsd(itemCount) {
  const inUsd = (itemCount * EST_PROMPT_TOKENS * HAIKU_USD_IN_PER_M) / 1_000_000;
  const outUsd = (itemCount * EST_COMPLETION_TOKENS * HAIKU_USD_OUT_PER_M) / 1_000_000;
  return inUsd + outUsd;
}

export function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

export function env(requireModel = true) {
  const {
    NEXT_PUBLIC_SUPABASE_URL: SB_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    OPENROUTER_API_KEY,
    OPENROUTER_CLASSIFY_MODEL,
  } = process.env;
  if (!SB_URL || !SERVICE) {
    fail("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  if (requireModel && (!OPENROUTER_API_KEY || !OPENROUTER_CLASSIFY_MODEL)) {
    fail("Missing OPENROUTER_API_KEY / OPENROUTER_CLASSIFY_MODEL");
  }
  return {
    admin: createClient(SB_URL, SERVICE, { auth: { persistSession: false } }),
    apiKey: OPENROUTER_API_KEY,
    model: OPENROUTER_CLASSIFY_MODEL,
  };
}

// --- argument parsing -------------------------------------------------------

export function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (name, fallback = null) => {
    const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i === -1) return fallback;
    const a = args[i];
    return a.includes("=") ? a.split("=").slice(1).join("=") : (args[i + 1] ?? fallback);
  };
  return {
    has: (name) => args.includes(`--${name}`),
    get,
    num: (name, fallback) => {
      const v = get(name);
      const n = Number(v);
      return v === null || !Number.isFinite(n) ? fallback : n;
    },
  };
}

// --- item selection ---------------------------------------------------------

export const ITEM_COLS = "id,user_id,title,body,raw,source,status,tags,created_at";

/**
 * The corpus, keyset-paginated by id (stable while the run writes rows).
 *
 * Excluded, deliberately:
 *   source='system'  the generated daily digests — machine output, not memories
 *   valid_to         already superseded by a bi-temporal write
 *   tag 'junk'       already judged by an earlier junk pass
 */
export async function* eachCorpusItem(admin, { source = "all", pageSize = 200 } = {}) {
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let q = admin
      .from("items")
      .select(ITEM_COLS)
      .neq("source", "system")
      .is("valid_to", null)
      .not("tags", "cs", '{"junk"}')
      .gt("id", after)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (source !== "all") q = q.eq("source", source);

    const { data, error } = await q;
    if (error) fail("select failed: " + error.message);
    if (!data || data.length === 0) return;
    for (const row of data) yield row;
    after = data[data.length - 1].id;
    if (data.length < pageSize) return;
  }
}

export async function countCorpus(admin, source = "all") {
  let q = admin
    .from("items")
    .select("id", { count: "exact", head: true })
    .neq("source", "system")
    .is("valid_to", null)
    .not("tags", "cs", '{"junk"}');
  if (source !== "all") q = q.eq("source", source);
  const { count, error } = await q;
  if (error) fail("count failed: " + error.message);
  return count ?? 0;
}

/**
 * Resumability: ids that already carry a retitle/split proposal in ANY state.
 * Pending means the deck hasn't reached it yet; approved/rejected means David
 * already ruled. Either way the item is done — never re-propose over a decision.
 */
export async function fetchDecidedItemIds(admin, ids) {
  const decided = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await admin
      .from("proposals")
      .select("source_item_id")
      .in("kind", ["retitle", "split"])
      .in("source_item_id", slice);
    if (error) fail("proposal lookup failed: " + error.message);
    for (const row of data ?? []) if (row.source_item_id) decided.add(row.source_item_id);
  }
  return decided;
}

/**
 * Second half of resumability: items already handled by a previous pass that
 * produced NO proposal (junk-archived, flagged for a human title, or genuinely
 * unchanged). Without this a re-run would pay to re-classify them.
 */
export async function fetchReprocessedItemIds(admin, ids) {
  const done = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await admin
      .from("audit")
      .select("item_id")
      .eq("action", "reprocess_pass")
      .in("item_id", slice);
    if (error) fail("audit lookup failed: " + error.message);
    for (const row of data ?? []) if (row.item_id) done.add(row.item_id);
  }
  return done;
}

// --- the model call ---------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractJson(text) {
  const t = String(text ?? "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Classify one already-captured item. Classification runs on `raw || body` —
 * the ORIGINAL text, not the cleaned body, so a re-title sees what the capture
 * actually said.
 *
 * Returns { verdict, usage, error }. Never throws: one unreadable note must not
 * end a 669-item run.
 */
export async function classifyItem({ apiKey, model, item, todayISO, fetchImpl = fetch }) {
  const text = String(item.raw || item.body || "").slice(0, MAX_CLASSIFY_CHARS);
  const oldTitle = String(item.title ?? "");
  const user = [
    // The current title is usually the note's raw first line — it is the thing
    // being fixed, so it is presented as evidence, never as a starting point.
    `Current title (auto-generated, usually just the note's first line — ignore it unless it genuinely describes the content): ${oldTitle || "(none)"}`,
    `Captured: ${String(item.created_at ?? "").slice(0, 10)} · source: ${item.source}`,
    ``,
    `--- note ---`,
    text,
  ].join("\n");

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    let res;
    try {
      res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Obsidian-X reprocess",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: buildReprocessSystem(todayISO) },
            { role: "user", content: user },
          ],
          temperature: 0,
          usage: { include: true },
          response_format: { type: "json_object" },
        }),
      });
    } catch (e) {
      lastErr = e?.message ?? String(e);
      continue;
    }
    if (!res.ok) {
      lastErr = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) break;
      continue;
    }
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content);
    const u = data?.usage ?? {};
    const usage = {
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      cost_usd: typeof u.cost === "number" ? u.cost : null,
    };
    if (!parsed) {
      // A reply we cannot read is NOT a verdict: parseReprocessReply degrades it
      // to a low-confidence "needs a human", which the caller skips proposing.
      return { verdict: parseReprocessReply(null, item), usage, error: "unreadable model reply" };
    }
    return { verdict: parseReprocessReply(parsed, item), usage, error: null };
  }
  return { verdict: null, usage: null, error: lastErr || "classify failed" };
}

// --- worker pool ------------------------------------------------------------

/** Run `worker` over `items` with a fixed number of workers, in order-agnostic
 *  fashion. Resolves when every item has been handled. */
export async function pool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// --- formatting -------------------------------------------------------------

export function truncate(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + "…";
}

export function pad(s, n) {
  const t = String(s ?? "");
  // Pad on display width, treating the one-char ellipsis as width 1.
  return t.length >= n ? t : t + " ".repeat(n - t.length);
}
