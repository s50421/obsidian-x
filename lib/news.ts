import type { SupabaseClient } from "@supabase/supabase-js";
import { chat, extractJson, type Usage } from "@/lib/openrouter";
import { getSettingValue, setSettingValue } from "@/lib/tz";

// Obsidian-X v4.2.2 (letter refinement) — the morning briefing block.
// NOTE: not v4.3-brief.md, which is the MCP shared brain and is untouched.
//
// The owner asked for markets, geopolitics, tech, and small-talk material in
// the daily letter. Three constraints shape this file:
//
// 1. NEVER INVENT. A hallucinated headline at 6:30am is worse than a blank
//    section — it's the no-half-baked law applied to the outside world. So this
//    uses a web-searching model (Perplexity Sonar via OpenRouter, which keeps
//    the OpenRouter-only rule) and keeps the citations it returns. If the call
//    fails, the section says so; it never falls back to the model's memory.
//
// 2. NOT FINANCIAL ADVICE. The ask included "investment suggestions". This
//    reports what HAPPENED — moves, results, announcements — and is explicitly
//    instructed never to recommend buying, selling or holding anything. That
//    line is in the prompt, not just in a comment, because the model is what
//    would otherwise cross it.
//
// 3. ONE CALL, CACHED PER DAY. Five topic calls cost ~5x and add ~20s to the
//    letter. One structured call covering everything, cached on the owner's
//    LOCAL date, means a preview or a forced resend costs nothing and reads
//    identically to what was sent.

const NEWS_MODEL = process.env.OPENROUTER_NEWS_MODEL || "perplexity/sonar";
const CACHE_KEY = "news_digest";
export const TOPICS_KEY = "news_topics";

export type NewsDigest = {
  /** Owner-local date this was fetched for. */
  date: string;
  markets: string;
  geopolitics: string;
  tech: string;
  /** Two or three conversation-starter items — general knowledge / global updates. */
  smalltalk: string[];
  /**
   * 2-3 things worth KNOWING rather than things that happened.
   *
   * Owner ask (2026-08-02): "general knowledge points … that make me seem up to
   * date and educated". News tells you what changed; this tells you how
   * something works — a concept, a mechanism, a piece of context behind a story
   * everyone is half-discussing. Deliberately separate from `smalltalk`,
   * because merging them produced three more headlines and no understanding.
   */
  knowledge: string[];
  /** Source domains, deduped, in the order the model cited them. */
  sources: string[];
  fetchedAt: string;
};

export type TopicConfig = {
  /** Extra steer, e.g. "weight Canada and Germany" or "include semiconductors". */
  focus?: string;
  /** Regions/markets the owner cares about most. */
  regions?: string[];
};

export async function loadTopicConfig(
  admin: SupabaseClient,
  userId: string
): Promise<TopicConfig> {
  const v = await getSettingValue<TopicConfig>(admin, userId, TOPICS_KEY);
  return v ?? {};
}

export async function saveTopicConfig(
  admin: SupabaseClient,
  userId: string,
  cfg: TopicConfig
): Promise<void> {
  await setSettingValue(admin, userId, TOPICS_KEY, cfg);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Strip the model's inline [1][2] citation markers — they mean nothing in Telegram. */
export function stripCitationMarkers(s: string): string {
  return s
    .replace(/\[\d+\](?:\[\d+\])*/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildPrompt(cfg: TopicConfig): string {
  const focus = cfg.focus ? `\nExtra steer from the owner: ${cfg.focus}` : "";
  const regions = cfg.regions?.length
    ? `\nWeight coverage toward: ${cfg.regions.join(", ")}.`
    : "";
  return (
    `You are writing the news block of a busy executive's 6:30am briefing. ` +
    `Search the web for what has actually happened in the LAST 24 HOURS and report it.\n\n` +
    `Return ONLY a JSON object:\n` +
    `{\n` +
    `  "markets": "2 sentences for a LONG-TERM investor: what moved, and what it ` +
    `signals about the underlying macro trend. Plain language, no jargon.",\n` +
    `  "geopolitics": "one sentence on the most consequential geopolitical development",\n` +
    `  "tech": "one sentence on the most consequential technology/industry development",\n` +
    `  "smalltalk": ["2-3 short, genuinely interesting items a well-read person would ` +
    `mention in conversation — science, culture, sport, a notable global update. NOT ` +
    `repeats of the three above."],\n` +
    `  "knowledge": ["2-3 things worth UNDERSTANDING rather than things that just ` +
    `happened: the mechanism behind a story in the news, a concept or number that ` +
    `explains it, or a piece of history/context that makes the reader sound informed ` +
    `rather than merely current. Each self-contained and explained in plain language."]\n` +
    `}\n\n` +
    `HARD RULES:\n` +
    `- Report only what you actually found in search results from the last 24-48 hours. ` +
    `If you genuinely cannot find current news for a field, set it to "" — an empty ` +
    `string is correct and expected. NEVER write from memory, never speculate, never ` +
    `fill space.\n` +
    `- MARKETS ARE FOR UNDERSTANDING, NOT TRADING. The reader is a long-term ` +
    `investor who wants to understand macroeconomic and global trends — the forces ` +
    `underneath the number, in language a smart non-economist follows. Prefer the ` +
    `structural read ("energy costs feed into inflation, which is what central banks ` +
    `respond to") over the daily tick.\n` +
    `- NO FINANCIAL ADVICE, and this is absolute. Describe what happened and why it ` +
    `moved. Never recommend buying, selling, holding, allocating or avoiding ` +
    `anything, never name a security as an opportunity, and never imply what the ` +
    `reader should do with their money. Explaining a trend is not advising on it.\n` +
    `- Be specific: names, numbers, places. "Markets were volatile" is a failure; ` +
    `"Brent crude rose 4% to $X on Hormuz disruption fears" is right.\n` +
    `- Under 300 characters per field, under 220 per list item. Plain text, no ` +
    `markdown, no emoji. Explain, don't lecture — no "it's important to note".` +
    focus +
    regions
  );
}

export type FetchResult = { digest: NewsDigest | null; usage: Usage | null; error: string | null };

/** Fetch a fresh digest. No caching here — see getDailyBriefing. */
export async function fetchDigest(
  localDate: string,
  cfg: TopicConfig = {}
): Promise<FetchResult> {
  try {
    const { content, usage, annotations } = await chatWithAnnotations(buildPrompt(cfg));

    const parsed = extractJson<{
      markets?: unknown;
      geopolitics?: unknown;
      tech?: unknown;
      smalltalk?: unknown;
      knowledge?: unknown;
    }>(content);

    // Markets now carries TWO sentences (what moved + what it signals), so the
    // old 300-char cap sliced it off mid-clause — "...which then filter into".
    // A truncated explanation is worse than a short one: it reads as a bug.
    const str = (v: unknown, max = 300) =>
      typeof v === "string" ? stripCitationMarkers(v).slice(0, max) : "";

    const list = (v: unknown) =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string")
            .map((x) => stripCitationMarkers(x).slice(0, 220))
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const smalltalk = list(parsed.smalltalk);
    const knowledge = list(parsed.knowledge);

    const sources = [
      ...new Set(
        annotations
          .map((a) => domainOf(a))
          .filter(Boolean)
          // The model often cites a section index page; those are still real
          // sources, so they stay — but drop anything that isn't a hostname.
          .slice(0, 12)
      ),
    ].slice(0, 4);

    const digest: NewsDigest = {
      date: localDate,
      markets: str(parsed.markets, 460),
      geopolitics: str(parsed.geopolitics),
      tech: str(parsed.tech),
      smalltalk,
      knowledge,
      sources,
      fetchedAt: new Date().toISOString(),
    };

    // If literally nothing came back, treat it as a failure rather than
    // shipping an empty block that looks like "nothing happened today".
    if (!digest.markets && !digest.geopolitics && !digest.tech && !smalltalk.length && !knowledge.length) {
      return { digest: null, usage, error: "search returned nothing usable" };
    }
    return { digest, usage, error: null };
  } catch (e) {
    return { digest: null, usage: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** chat() doesn't surface Perplexity's url_citation annotations, so call directly. */
async function chatWithAnnotations(
  prompt: string
): Promise<{ content: string; usage: Usage; annotations: string[] }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
      "X-Title": "Obsidian-X",
    },
    body: JSON.stringify({
      model: NEWS_MODEL,
      temperature: 0,
      max_tokens: 1300,
      usage: { include: true },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    throw new Error(`news ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message ?? {};
  const u = data?.usage ?? {};
  const annotations: string[] = (msg.annotations ?? [])
    .map((a: { url_citation?: { url?: string } }) => a?.url_citation?.url ?? "")
    .filter(Boolean);
  return {
    content: msg.content ?? "",
    usage: {
      model: data?.model ?? NEWS_MODEL,
      prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
      completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
      cost_usd: typeof u.cost === "number" ? u.cost : null,
    },
    annotations,
  };
}

/**
 * The digest for this local date, fetched once and reused.
 *
 * Caching on the owner's LOCAL date is what makes `?preview=1` free and makes a
 * forced resend identical to what was actually delivered — you can't review a
 * letter whose contents change every time you look at it.
 */
export async function getDailyBriefing(
  admin: SupabaseClient,
  userId: string,
  localDate: string,
  opts: { refresh?: boolean } = {}
): Promise<{ digest: NewsDigest | null; usage: Usage | null; error: string | null }> {
  if (!opts.refresh) {
    const cached = await getSettingValue<NewsDigest>(admin, userId, CACHE_KEY);
    if (cached?.date === localDate) return { digest: cached, usage: null, error: null };
  }

  const cfg = await loadTopicConfig(admin, userId);
  const result = await fetchDigest(localDate, cfg);
  if (result.digest) {
    await setSettingValue(admin, userId, CACHE_KEY, result.digest);
  }
  return result;
}

// ---- going deeper ------------------------------------------------------------

/**
 * Answer a follow-up about something in this morning's briefing.
 *
 * Separate from Ask (`lib/ask-core.ts`), which searches the owner's OWN notes.
 * The news was never captured into the brain, so routing "tell me more about
 * the oil story" through Ask would correctly find nothing and look broken.
 *
 * The day's digest is passed in as context so the model knows which story is
 * meant from a vague reference ("the oil one"), and the same web-searching
 * model answers with real sources rather than from memory.
 */
export async function explainStory(
  question: string,
  digest: NewsDigest | null
): Promise<{ answer: string; sources: string[]; usage: Usage | null; error: string | null }> {
  const context = digest
    ? [
        digest.markets && `Markets: ${digest.markets}`,
        digest.geopolitics && `World: ${digest.geopolitics}`,
        digest.tech && `Tech: ${digest.tech}`,
        ...digest.smalltalk.map((s) => `Also: ${s}`),
        ...(digest.knowledge ?? []).map((k) => `Background: ${k}`),
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const prompt =
    `The owner read this in his briefing this morning:\n\n${context || "(no briefing available)"}\n\n` +
    `He now asks: "${question}"\n\n` +
    `Search the web and explain it properly — what happened, why it matters, and the ` +
    `context someone would need to hold their own in a conversation about it. ` +
    `Aim for 4-8 sentences.\n\n` +
    `RULES:\n` +
    `- Report only what you find in search results. If you cannot verify something, ` +
    `say so plainly rather than filling the gap.\n` +
    `- Plain language. Explain the mechanism, not just the event — he wants to ` +
    `UNDERSTAND it, not just know it happened.\n` +
    `- NO FINANCIAL ADVICE. Never recommend buying, selling or holding anything, ` +
    `and never imply what he should do with his money. Explaining a trend is fine; ` +
    `advising on it is not.\n` +
    `- Plain text. No markdown, no headers, no bullet characters — this is read in ` +
    `a chat app.`;

  try {
    const { content, usage, annotations } = await chatWithAnnotations(prompt);
    const sources = [...new Set(annotations.map((a) => domainOf(a)).filter(Boolean))].slice(0, 4);
    const answer = stripCitationMarkers(content).trim();
    if (!answer) return { answer: "", sources, usage, error: "no answer returned" };
    return { answer, sources, usage, error: null };
  } catch (e) {
    return {
      answer: "",
      sources: [],
      usage: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
