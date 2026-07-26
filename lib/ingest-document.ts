import { createAdminClient } from "@/lib/supabase/admin";
import { chat, extractJson } from "@/lib/openrouter";
import { detectSensitive } from "@/lib/sensitivity";
import { logLlmUsage } from "@/lib/usage";
import { storeEnrichedItem, type CaptureOutcome } from "@/lib/capture-core";
import type { EnrichedItem, Entity } from "@/lib/enrich";

// v3.1 — ingest an uploaded document / screenshot into the knowledge base.
// Unlike a typed capture, an upload is classified as ONE item (no split), keeps
// its full extracted text as the body, and embeds on a concise summary (which
// fits gte-small's window better than a long, truncated body). Beyond title /
// type / tags it also pulls out a due date (appointments, deadlines) and named
// entities (people / places / orgs) so uploads enrich the graph like captures.

const ALLOWED_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event"];
const ALLOWED_PRIORITY = ["low", "medium", "high"];
const ENTITY_KINDS = ["person", "place", "org", "other"];
const MAX_BODY = 100_000; // cap stored body so a huge doc can't bloat a row/vault file
const MAX_CLASSIFY = 16_000; // chars of the doc shown to the classifier

function baseName(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 60) || "Document";
}

function isValidISODate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(new Date(v + "T00:00:00Z").getTime());
}

function sanitizeEntities(v: unknown): Entity[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e): Entity => {
      const rec = (e ?? {}) as { name?: unknown; kind?: unknown };
      const kind = ENTITY_KINDS.includes(String(rec.kind)) ? (String(rec.kind) as Entity["kind"]) : "other";
      return { name: String(rec.name ?? "").trim(), kind };
    })
    .filter((e) => e.name)
    .slice(0, 12);
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
  const system =
    `You classify an uploaded file (a document or a screenshot/photo) for a personal ` +
    `knowledge base. Today is ${todayISO}. Documents are usually "reference"; a screenshot ` +
    `of an appointment/event is an "event", a to-do is a "task", etc. Do NOT rewrite or split ` +
    `the content. Return ONLY a JSON object:\n` +
    `{\n` +
    `  "title": concise 3-8 word title,\n` +
    `  "type": one of ${JSON.stringify(ALLOWED_TYPES)},\n` +
    `  "tags": 1-6 lowercase kebab-case topical tags,\n` +
    `  "priority": one of ${JSON.stringify(ALLOWED_PRIORITY)},\n` +
    `  "summary": 1-3 sentences on what this is and its key content,\n` +
    `  "due_date": ISO "YYYY-MM-DD" if the content implies a specific date/deadline/appointment ` +
    `(resolve relative dates against today), else null,\n` +
    `  "entities": [ {"name": string, "kind": one of ${JSON.stringify(ENTITY_KINDS)}} ] — people, ` +
    `places and organizations named in the content,\n` +
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

  // Resilient parse — a malformed model reply must not 500 the upload; fall back
  // to a filename-based classification instead.
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
      confidence: 0.5,
    };
  }

  const type = ALLOWED_TYPES.includes(String(p.type)) ? String(p.type) : "reference";
  const priority = (ALLOWED_PRIORITY.includes(String(p.priority)) ? String(p.priority) : "medium") as EnrichedItem["priority"];
  const title = (typeof p.title === "string" && p.title.trim()) || baseName(filename);
  const tags = Array.isArray(p.tags)
    ? [...new Set(p.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 6)
    : [];
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  const due_date = isValidISODate(p.due_date) ? p.due_date : null;
  const entities = sanitizeEntities(p.entities);
  const confidence = Number.isFinite(Number(p.confidence)) ? Math.min(1, Math.max(0, Number(p.confidence))) : 0.7;
  return { title, type, tags, priority, summary, due_date, entities, confidence };
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
    item = { title: c.title, type: c.type, body, tags: c.tags, priority: c.priority, due_date: c.due_date, entities: c.entities };
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
