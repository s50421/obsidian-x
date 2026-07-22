import { chat, extractJson } from "@/lib/openrouter";

export type Classification = {
  type: string;
  title: string;
  tags: string[];
  priority: "low" | "medium" | "high";
};

const ALLOWED_TYPES = [
  "note",
  "task",
  "idea",
  "reference",
  "person",
  "event",
  "question",
  "journal",
];
const ALLOWED_PRIORITY = ["low", "medium", "high"];

// Classify a raw captured note into {type, title, tags, priority} via OpenRouter.
export async function classify(text: string): Promise<Classification> {
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system =
    `You classify a captured note for a personal knowledge base. ` +
    `Respond with ONLY a JSON object and no other text. Schema: ` +
    `{"type": one of ${JSON.stringify(ALLOWED_TYPES)}, ` +
    `"title": a concise 3-8 word title, ` +
    `"tags": array of 1-5 lowercase kebab-case topic tags, ` +
    `"priority": one of ${JSON.stringify(ALLOWED_PRIORITY)}}.`;

  const raw = await chat(
    model,
    [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    { json: true, temperature: 0 }
  );

  const parsed = extractJson<Partial<Classification>>(raw);

  const type = ALLOWED_TYPES.includes(String(parsed.type))
    ? String(parsed.type)
    : "note";
  const title =
    (parsed.title && String(parsed.title).trim()) ||
    text.trim().split("\n")[0].slice(0, 60) ||
    "Untitled";
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((t) => String(t).toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const priority = (
    ALLOWED_PRIORITY.includes(String(parsed.priority))
      ? String(parsed.priority)
      : "medium"
  ) as Classification["priority"];

  return { type, title, tags, priority };
}
