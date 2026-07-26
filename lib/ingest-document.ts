import { createAdminClient } from "@/lib/supabase/admin";
import { chat, extractJson } from "@/lib/openrouter";
import { detectSensitive } from "@/lib/sensitivity";
import { logLlmUsage } from "@/lib/usage";
import { storeEnrichedItem, type CaptureOutcome } from "@/lib/capture-core";
import type { EnrichedItem } from "@/lib/enrich";

// v3.1 — ingest an uploaded document into the knowledge base. Unlike a typed
// capture, a document is classified as ONE item (no split), keeps its full
// extracted text as the body, and embeds on a concise summary (which fits
// gte-small's window better than a long, truncated body).

const ALLOWED_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event"];
const ALLOWED_PRIORITY = ["low", "medium", "high"];
const MAX_BODY = 100_000; // cap stored body so a huge doc can't bloat a row/vault file
const MAX_CLASSIFY = 16_000; // chars of the doc shown to the classifier

function baseName(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 60) || "Document";
}

type RawDoc = { title?: unknown; type?: unknown; tags?: unknown; priority?: unknown; summary?: unknown; confidence?: unknown };

async function classifyDocument(text: string, filename: string, todayISO: string, userId: string) {
  const admin = createAdminClient();
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system =
    `You classify an uploaded document for a personal knowledge base. Today is ${todayISO}.\n` +
    `Documents are usually "reference" material. Do NOT rewrite or split the content.\n` +
    `Return ONLY a JSON object:\n` +
    `{\n` +
    `  "title": concise 3-8 word title for the document,\n` +
    `  "type": one of ${JSON.stringify(ALLOWED_TYPES)} (default "reference"),\n` +
    `  "tags": 1-6 lowercase kebab-case topical tags,\n` +
    `  "priority": one of ${JSON.stringify(ALLOWED_PRIORITY)},\n` +
    `  "summary": 1-3 sentences on what this document is and its key content,\n` +
    `  "confidence": number 0..1\n` +
    `}`;
  const { content, usage } = await chat(
    model,
    [
      { role: "system", content: system },
      { role: "user", content: `Filename: ${filename}\n\n${text.slice(0, MAX_CLASSIFY)}` },
    ],
    { json: true, temperature: 0 }
  );
  await logLlmUsage(admin, userId, "classify_document", usage);

  const p = extractJson<RawDoc>(content) ?? {};
  const type = ALLOWED_TYPES.includes(String(p.type)) ? String(p.type) : "reference";
  const priority = ALLOWED_PRIORITY.includes(String(p.priority)) ? String(p.priority) : "medium";
  const title = (typeof p.title === "string" && p.title.trim()) || baseName(filename);
  const tags = Array.isArray(p.tags)
    ? [...new Set(p.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 6)
    : [];
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  const confidence = Number.isFinite(Number(p.confidence)) ? Math.min(1, Math.max(0, Number(p.confidence))) : 0.7;
  return { title, type, tags, priority: priority as EnrichedItem["priority"], summary, confidence };
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
    // Sensitive content stays local — no third-party LLM, minimal classification.
    item = { title: baseName(filename), type: "reference", body, tags: ["private"], priority: "medium", due_date: null, entities: [] };
    confidence = 1;
    embedText = item.title;
  } else {
    const c = await classifyDocument(cleanText, filename, todayISO, userId);
    item = { title: c.title, type: c.type, body, tags: c.tags, priority: c.priority, due_date: null, entities: [] };
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
