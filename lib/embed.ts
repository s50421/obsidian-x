import { createAdminClient } from "@/lib/supabase/admin";

// v4.0 W1 — embeddings.
//
// NEW (v2): OpenAI `text-embedding-3-large` truncated to 1024 dims. This is the
// ONE sanctioned exception to the OpenRouter-only rule (owner-approved
// 2026-07-28) — gte-small's high similarity floor was the root cause of
// duplicate false-flags and link noise. Writes/reads `items.embedding_v2`.
//
// LEGACY: `embed()` below still calls the Supabase `embed` edge function
// (gte-small, 384-dim) and still backs the `items.embedding` column. It is kept
// ONLY because prod runs on it until the v4.0 deploy and because a few routes
// (telegram webhook, cron/consolidate) are owned by other workstreams.
// DO NOT call it from new code — use embedText/embedBatch.

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
export const EMBED_MODEL = "text-embedding-3-large";
export const EMBED_DIMS = 1024;

// text-embedding-3 accepts 8191 tokens per input. ~30k chars is a safe cap at
// the conservative ~3.7 chars/token English ratio, and it keeps a whole batch
// well under the per-request payload limit.
const MAX_CHARS = 30_000;

// USD per 1M tokens (text-embedding-3-large, 2026-07).
const USD_PER_MILLION_TOKENS = 0.13;

const MAX_BATCH = 100;

function truncate(text: string): string {
  const t = (text ?? "").toString();
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
}

type EmbedApiResult = {
  vectors: number[][];
  promptTokens: number | null;
  totalTokens: number | null;
  model: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// One POST to OpenAI, with a single retry on 429 / 5xx (transient classes only —
// a 400/401 is a bug or a bad key and must surface immediately).
async function callOpenAI(inputs: string[]): Promise<EmbedApiResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const body = JSON.stringify({
    model: EMBED_MODEL,
    dimensions: EMBED_DIMS,
    input: inputs,
  });

  let lastStatus = 0;
  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1500);

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBED_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      // Network-level failure is transient too — retry once, then surface.
      lastStatus = 0;
      lastDetail = e instanceof Error ? e.message : String(e);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const rows = data?.data;
      if (!Array.isArray(rows) || rows.length !== inputs.length) {
        throw new Error(
          `embeddings returned ${Array.isArray(rows) ? rows.length : "n/a"} rows for ${inputs.length} inputs`
        );
      }
      // The API may return rows out of order; `index` is authoritative.
      const vectors: number[][] = new Array(inputs.length);
      for (const row of rows) {
        const idx = typeof row?.index === "number" ? row.index : -1;
        const emb = row?.embedding;
        if (idx < 0 || idx >= inputs.length) throw new Error(`embeddings returned bad index ${idx}`);
        if (!Array.isArray(emb) || emb.length !== EMBED_DIMS) {
          throw new Error(
            `embeddings returned unexpected shape (len=${Array.isArray(emb) ? emb.length : "n/a"}, want ${EMBED_DIMS})`
          );
        }
        vectors[idx] = emb as number[];
      }
      if (vectors.some((v) => !v)) throw new Error("embeddings response missing an index");

      const u = data?.usage ?? {};
      return {
        vectors,
        promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
        totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
        model: typeof data?.model === "string" ? data.model : EMBED_MODEL,
      };
    }

    lastStatus = res.status;
    lastDetail = await res.text().catch(() => "");
    const transient = res.status === 429 || res.status >= 500;
    if (!transient) break;
  }

  throw new Error(`OpenAI embeddings ${lastStatus}: ${lastDetail.slice(0, 500)}`);
}

// Record embedding spend alongside chat spend. Same table + shape as
// logLlmUsage(); embeddings have no completion tokens. Never breaks the flow.
async function logEmbedUsage(
  userId: string,
  model: string,
  promptTokens: number | null,
  totalTokens: number | null
): Promise<void> {
  try {
    const tokens = promptTokens ?? totalTokens;
    await createAdminClient()
      .from("llm_usage")
      .insert({
        user_id: userId,
        operation: "embed",
        model,
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: totalTokens ?? promptTokens,
        cost_usd: tokens === null ? null : (tokens / 1_000_000) * USD_PER_MILLION_TOKENS,
      });
  } catch {
    // swallow — usage accounting must never fail a capture or an answer
  }
}

// Embed one string -> 1024-dim vector. Pass `userId` to record the spend.
export async function embedText(text: string, userId?: string): Promise<number[]> {
  const [v] = await embedBatch([text], userId);
  return v;
}

// Embed many strings in order. Inputs are chunked to 100 per request; each
// chunk is one API call (and one llm_usage row when userId is given).
export async function embedBatch(texts: string[], userId?: string): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    // OpenAI rejects empty strings; a blank input still needs a slot in the
    // output, so substitute a single space.
    const chunk = texts.slice(i, i + MAX_BATCH).map((t) => truncate(t) || " ");
    const r = await callOpenAI(chunk);
    out.push(...r.vectors);
    if (userId) await logEmbedUsage(userId, r.model, r.promptTokens, r.totalTokens);
  }
  return out;
}

// ---------------------------------------------------------------------------
// LEGACY — gte-small via the Supabase edge function. 384-dim, `items.embedding`.
// Superseded by embedText/embedBatch. Do not call from new code.
// ---------------------------------------------------------------------------
export async function embed(input: string): Promise<number[]> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/embed`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embed edge function ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  const embedding = data?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 384) {
    throw new Error(
      `embed returned unexpected shape (len=${
        Array.isArray(embedding) ? embedding.length : "n/a"
      })`
    );
  }
  return embedding as number[];
}
