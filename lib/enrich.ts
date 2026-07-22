import { chat, extractJson } from "@/lib/openrouter";

// v1.2 enrichment: one OpenRouter call cleans, (optionally) splits, and
// classifies a raw capture, resolving due dates and pulling out entities.

export type Entity = { name: string; kind: "person" | "place" | "org" | "other" };

export type EnrichedItem = {
  title: string;
  type: string;
  body: string; // cleaned
  tags: string[];
  priority: "low" | "medium" | "high";
  due_date: string | null; // "YYYY-MM-DD" or null
  entities: Entity[];
};

export type EnrichResult = { items: EnrichedItem[]; confidence: number };

// Must match the items_* check constraints in the database.
const ALLOWED_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event"];
const ALLOWED_PRIORITY = ["low", "medium", "high"];
const ENTITY_KINDS = ["person", "place", "org", "other"];

type RawItem = {
  title?: unknown;
  type?: unknown;
  body?: unknown;
  tags?: unknown;
  priority?: unknown;
  due_date?: unknown;
  entities?: unknown;
};

export async function enrich(text: string, todayISO: string): Promise<EnrichResult> {
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system =
    `You process a raw captured note for a personal knowledge base. Today is ${todayISO}.\n` +
    `Return ONLY a JSON object of this shape:\n` +
    `{\n` +
    `  "confidence": number between 0 and 1 (your certainty in this classification),\n` +
    `  "items": [ {\n` +
    `     "title": concise 3-8 word title,\n` +
    `     "type": one of ${JSON.stringify(ALLOWED_TYPES)},\n` +
    `     "body": the note cleaned up — fix grammar/typos, drop filler, keep every fact, invent nothing,\n` +
    `     "tags": 1-5 lowercase kebab-case tags,\n` +
    `     "priority": one of ${JSON.stringify(ALLOWED_PRIORITY)},\n` +
    `     "due_date": ISO "YYYY-MM-DD" if a deadline is implied (resolve relative dates against today), else null,\n` +
    `     "entities": [ {"name": string, "kind": one of ${JSON.stringify(ENTITY_KINDS)}} ]\n` +
    `  } ]\n` +
    `}\n` +
    `Split into MULTIPLE items ONLY if the note clearly holds separate, unrelated thoughts; otherwise return exactly one item.`;

  const rawText = await chat(
    model,
    [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    { json: true, temperature: 0 }
  );

  const parsed = extractJson<{ confidence?: unknown; items?: unknown }>(rawText);

  const confidence = clamp01(Number(parsed?.confidence));
  const rawItems: RawItem[] =
    Array.isArray(parsed?.items) && parsed.items.length
      ? (parsed.items as RawItem[])
      : [parsed as RawItem];

  const items = rawItems.map((it) => sanitizeItem(it, text));
  return {
    items: items.length ? items : [sanitizeItem({}, text)],
    confidence: Number.isFinite(confidence) ? confidence : 0.6,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function sanitizeItem(it: RawItem, fallbackText: string): EnrichedItem {
  const type = ALLOWED_TYPES.includes(String(it?.type)) ? String(it.type) : "note";
  const body = str(it?.body) || fallbackText.trim();
  const title = str(it?.title) || body.split("\n")[0].slice(0, 60) || "Untitled";
  const tags = Array.isArray(it?.tags)
    ? it.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
    : [];
  const priority = (
    ALLOWED_PRIORITY.includes(String(it?.priority)) ? String(it.priority) : "medium"
  ) as EnrichedItem["priority"];
  const due_date = isValidISODate(it?.due_date) ? String(it.due_date) : null;
  const entities: Entity[] = Array.isArray(it?.entities)
    ? it.entities
        .map((e): Entity => {
          const rec = (e ?? {}) as { name?: unknown; kind?: unknown };
          const kind = ENTITY_KINDS.includes(String(rec.kind))
            ? (String(rec.kind) as Entity["kind"])
            : "other";
          return { name: String(rec.name ?? "").trim(), kind };
        })
        .filter((e) => e.name)
        .slice(0, 12)
    : [];

  return { title, type, body, tags, priority, due_date, entities };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  return Math.min(1, Math.max(0, n));
}

function isValidISODate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}
