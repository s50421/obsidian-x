import { chat, extractJson, type Usage } from "@/lib/openrouter";
import {
  ALLOWED_TYPES,
  ALLOWED_PRIORITY,
  ENTITY_KINDS,
  TITLE_RULES,
  TITLE_EXAMPLES,
  TYPE_RULES,
  TAG_RULES,
  SPLIT_RULES,
  JUNK_RULES,
  CONFIDENCE_RULES,
  MAX_SPLIT_PARTS,
  parseEnrichPayload,
} from "@/lib/title-standard.mjs";
import type { Entity, JunkVerdict } from "@/lib/title-standard.mjs";

// v4.0 W2 — enrichment: ONE OpenRouter call cleans a raw capture, writes exactly
// one clean topic-first title per topic, classifies it against the constrained
// tag taxonomy, resolves due dates, pulls out entities, and detects whether the
// capture actually holds several distinct topics (multi-topic detection happens
// in this same pass — no second model call).
//
// The title spec, the taxonomy and the mechanical sanitisers live in
// lib/title-standard.mjs so the live capture path and the corpus re-process
// (scripts/reprocess-corpus.mjs) cannot drift apart.
//
// No-half-baked law: a below-bar confidence, or a title that still breaks the
// spec after sanitising, sets needs_review on the item instead of quietly
// surfacing a bad title.

export type { Entity };

export type EnrichedItem = {
  title: string;
  type: string;
  body: string; // cleaned
  tags: string[];
  priority: "low" | "medium" | "high";
  due_date: string | null; // "YYYY-MM-DD" or null
  entities: Entity[];
  // v4.0 W2 — per-item review verdict. On a split, one part can be confident
  // while another is not, so these are per item rather than per capture.
  confidence?: number;
  needs_review?: boolean;
  review_reason?: string | null;
  // v4.0.1 — junk pass (ruthlessness 8/10), surfaced not acted on. 'review' keeps
  // the item and flags it (score 8+ is badged "would be junk" in the deck; 5-7 is
  // "possible junk"); 'keep' says nothing. Nothing is auto-archived. See
  // scoreJunk() in lib/title-standard.mjs.
  junk_score?: number;
  junk_verdict?: JunkVerdict;
  junk_reason?: string | null;
};

export type EnrichResult = {
  items: EnrichedItem[];
  confidence: number;
  usage: Usage;
  split: boolean;
};

export function buildEnrichSystemPrompt(todayISO: string): string {
  return [
    `You process a raw captured note for a personal knowledge base. Today is ${todayISO}.`,
    `The owner never organises anything by hand: your output IS the filing.`,
    ``,
    `Return ONLY a JSON object of this shape:`,
    `{`,
    `  "confidence": number 0..1 — your certainty in the whole reading,`,
    `  "items": [ {`,
    `     "title": the topic-first title (see TITLE RULES),`,
    `     "type": one of ${JSON.stringify(ALLOWED_TYPES)},`,
    `     "body": this topic's content, cleaned — fix grammar and typos, drop`,
    `             filler, keep every fact, invent nothing,`,
    `     "tags": array of tags (see TAG RULES),`,
    `     "priority": one of ${JSON.stringify(ALLOWED_PRIORITY)},`,
    `     "due_date": "YYYY-MM-DD" if a deadline is implied (resolve relative`,
    `                 dates against today), else null,`,
    `     "entities": [ {"name": string, "kind": one of ${JSON.stringify(ENTITY_KINDS)}} ],`,
    `     "junk_score": integer 0..10 for THIS item (see JUNK SCORE),`,
    `     "confidence": number 0..1 for THIS item specifically`,
    `  } ]`,
    `}`,
    ``,
    `"items" holds ONE entry for a single-topic note and one entry per topic for a`,
    `multi-topic one — never more than ${MAX_SPLIT_PARTS}.`,
    ``,
    TITLE_RULES,
    ``,
    TITLE_EXAMPLES,
    ``,
    TYPE_RULES,
    ``,
    TAG_RULES,
    ``,
    SPLIT_RULES,
    ``,
    JUNK_RULES,
    ``,
    CONFIDENCE_RULES,
  ].join("\n");
}

export async function enrich(text: string, todayISO: string): Promise<EnrichResult> {
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;

  const { content: rawText, usage } = await chat(
    model,
    [
      { role: "system", content: buildEnrichSystemPrompt(todayISO) },
      { role: "user", content: text },
    ],
    { json: true, temperature: 0 }
  );

  return { ...parseEnrichReply(rawText, text), usage };
}

/**
 * Parse + sanitise a model reply into enriched items.
 *
 * The JSON is extracted here; the whole reply -> item-fields mapping lives in
 * parseEnrichPayload() in lib/title-standard.mjs, which is pure ESM and is
 * unit-tested against fabricated model output by scripts/test-retitle-core.mjs.
 *
 * NEVER throws. A malformed reply degrades to a single low-confidence item
 * carrying the original text and flagged for review — a capture is never lost
 * and the route never 500s.
 */
export function parseEnrichReply(
  rawText: string,
  originalText: string
): Omit<EnrichResult, "usage"> {
  let parsed: unknown = null;
  try {
    parsed = extractJson<unknown>(rawText);
  } catch {
    parsed = null;
  }
  return parseEnrichPayload(parsed, originalText) as Omit<EnrichResult, "usage">;
}
