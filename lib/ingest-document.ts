import { createAdminClient } from "@/lib/supabase/admin";
import { chat, extractJson } from "@/lib/openrouter";
import { detectSensitive } from "@/lib/sensitivity";
import { logLlmUsage } from "@/lib/usage";
import { storeEnrichedItem, type CaptureOutcome } from "@/lib/capture-core";
import type { EnrichedItem, Entity } from "@/lib/enrich";
import {
  ALLOWED_TYPES,
  ALLOWED_PRIORITY,
  ENTITY_KINDS,
  CONFIDENCE_BAR,
  TITLE_RULES,
  TITLE_EXAMPLES,
  TAG_RULES,
  CONFIDENCE_RULES,
  cleanTitle,
  titleQualityIssues,
  normalizeTags,
  sanitizeEntities,
  coerceType,
  coercePriority,
  isValidISODate,
} from "@/lib/title-standard.mjs";

// v3.1 — ingest an uploaded document / screenshot into the knowledge base.
// Unlike a typed capture, an upload is classified as ONE item (no split), keeps
// its full extracted text as the body, and embeds on a concise summary (which
// fits the embedding window better than a long, truncated body). Beyond title /
// type / tags it also pulls out a due date (appointments, deadlines) and named
// entities (people / places / orgs) so uploads enrich the graph like captures.
//
// v4.0 W2 — the title standard applies to uploads too: same topic-first spec,
// same constrained taxonomy, same confidence bar. A filename is a hint, never a
// title of record — falling back to it flags the item for review.

const MAX_BODY = 100_000; // cap stored body so a huge doc can't bloat a row/vault file
const MAX_CLASSIFY = 16_000; // chars of the doc shown to the classifier

function baseName(filename: string): string {
  const cleaned = cleanTitle(
    String(filename ?? "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
  );
  return cleaned || "Untitled document";
}

type ClassifyResult = {
  title: string;
  type: string;
  tags: string[];
  priority: EnrichedItem["priority"];
  summary: string;
  due_date: string | null;
  entities: Entity[];
  confidence: number;
  review_reason: string | null;
};

type RawDoc = {
  title?: unknown;
  type?: unknown;
  tags?: unknown;
  priority?: unknown;
  summary?: unknown;
  due_date?: unknown;
  entities?: unknown;
  confidence?: unknown;
};

async function classifyDocument(
  text: string,
  filename: string,
  todayISO: string,
  userId: string
): Promise<ClassifyResult> {
  const admin = createAdminClient();
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system = [
    `You classify an uploaded file (a document or a screenshot/photo) for a personal`,
    `knowledge base. Today is ${todayISO}. Documents are usually "reference"; a`,
    `screenshot of an appointment/event is an "event", a to-do is a "task", etc.`,
    `Do NOT rewrite or split the content.`,
    ``,
    `Return ONLY a JSON object:`,
    `{`,
    `  "title": the topic-first title (see TITLE RULES),`,
    `  "type": one of ${JSON.stringify(ALLOWED_TYPES)},`,
    `  "tags": array of tags (see TAG RULES),`,
    `  "priority": one of ${JSON.stringify(ALLOWED_PRIORITY)},`,
    `  "summary": 1-3 sentences on what this is and its key content,`,
    `  "due_date": "YYYY-MM-DD" if the content implies a specific date, deadline or`,
    `              appointment (resolve relative dates against today), else null,`,
    `  "entities": [ {"name": string, "kind": one of ${JSON.stringify(ENTITY_KINDS)}} ]`,
    `              — people, places and organisations named in the content,`,
    `  "confidence": number 0..1`,
    `}`,
    ``,
    `The filename is a hint only. Title the CONTENT, not the file: "Invoice 4471"`,
    `is a filename, "Q3 hosting invoice — Hetzner, 412 EUR" is a title.`,
    ``,
    TITLE_RULES,
    ``,
    TITLE_EXAMPLES,
    ``,
    TAG_RULES,
    ``,
    CONFIDENCE_RULES,
  ].join("\n");

  const { content, usage } = await chat(
    model,
    [
      { role: "system", content: system },
      { role: "user", content: `Filename: ${filename}\n\n${text.slice(0, MAX_CLASSIFY)}` },
    ],
    { json: true, temperature: 0 }
  );
  await logLlmUsage(admin, userId, "classify_document", usage);

  // Resilient parse — a malformed model reply must not 500 the upload; fall back
  // to a filename-based classification instead, flagged for review.
  let p: RawDoc;
  try {
    p = extractJson<RawDoc>(content);
  } catch {
    return {
      title: baseName(filename),
      type: "reference",
      tags: [],
      priority: "medium",
      summary: "",
      due_date: null,
      entities: [],
      confidence: 0.3,
      review_reason: "classifier returned unreadable output — titled from the filename",
    };
  }

  const type = coerceType(p.type, "reference");
  const priority = coercePriority(p.priority) as EnrichedItem["priority"];
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  const due_date = isValidISODate(p.due_date) ? p.due_date : null;
  const entities = sanitizeEntities(p.entities);
  let confidence = Number.isFinite(Number(p.confidence)) ? Math.min(1, Math.max(0, Number(p.confidence))) : 0.7;

  // Title: enforce the spec mechanically, then fall back to the filename ONLY
  // with a flag — a filename is not a title of record.
  let title = cleanTitle(p.title);
  let review_reason: string | null = null;
  if (!title || titleQualityIssues(title, summary || text).length) {
    title = baseName(filename);
    review_reason = "auto-title fell back to the filename — confirm it";
    confidence = Math.min(confidence, 0.5);
  }

  return {
    title,
    type,
    tags: normalizeTags(p.tags),
    priority,
    summary,
    due_date,
    entities,
    confidence,
    review_reason,
  };
}

export async function ingestDocument(
  userId: string,
  fullText: string,
  filename: string,
  source: string = "upload"
): Promise<CaptureOutcome> {
  const admin = createAdminClient();
  const todayISO = new Date().toISOString().slice(0, 10);
  const { sensitive, text: cleanText } = detectSensitive(fullText);
  const body = cleanText.slice(0, MAX_BODY);

  let item: EnrichedItem;
  let confidence: number;
  let embedText: string;

  if (sensitive) {
    // Sensitive content stays local — no third-party LLM, so no AI title is
    // possible: title from the filename and flag it (no-half-baked law).
    item = {
      title: baseName(filename),
      type: "reference",
      body,
      tags: ["private"],
      priority: "medium",
      due_date: null,
      entities: [],
      confidence: 1,
      needs_review: true,
      review_reason: "private document — titled from the filename, not by the model",
    };
    confidence = 1;
    embedText = item.title;
  } else {
    const c = await classifyDocument(cleanText, filename, todayISO, userId);
    item = {
      title: c.title,
      type: c.type,
      body,
      tags: c.tags,
      priority: c.priority,
      due_date: c.due_date,
      entities: c.entities,
      confidence: c.confidence,
      needs_review: c.confidence < CONFIDENCE_BAR || !!c.review_reason,
      review_reason:
        c.review_reason ??
        (c.confidence < CONFIDENCE_BAR ? "low classification confidence — please confirm" : null),
    };
    confidence = c.confidence;
    embedText = c.summary ? `${c.title}\n\n${c.summary}` : `${c.title}\n\n${body.slice(0, 2000)}`;
  }

  const created = await storeEnrichedItem(admin, userId, item, {
    source,
    rawText: fullText,
    sensitive,
    confidence,
    split: false,
    embedText,
  });

  return { created: [created], confidence, split: false };
}
