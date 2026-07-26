import type { Usage } from "@/lib/openrouter";

// v3.1 — read a screenshot / photo with an AI vision model (OpenRouter-only,
// same approach as voice transcription in transcribe.ts) rather than classic
// OCR. The model transcribes visible text verbatim and adds a light one-line
// context note, so the result flows into the normal classify → embed → store
// ingest just like an extracted document.

const DEFAULT_MODEL = "google/gemini-2.5-flash"; // multimodal, cheap, good at screenshots

const PROMPT =
  "You are reading an image (a screenshot or photo) for someone's personal " +
  "knowledge base. Transcribe ALL text visible in the image verbatim, preserving " +
  "structure (headings, lists, line breaks). Do NOT invent, complete, or guess " +
  "text that isn't clearly visible. After the transcription, if it adds meaning, " +
  "add one final line starting with 'Context: ' describing what the image is (the " +
  "app/site or kind of content). If the image has no meaningful text or content, " +
  "output an empty string and nothing else.";

export async function readImage(
  dataBase64: string,
  mimeType: string
): Promise<{ text: string; usage: Usage }> {
  const model = process.env.OPENROUTER_VISION_MODEL || DEFAULT_MODEL;
  const mime = mimeType && mimeType.startsWith("image/") ? mimeType : "image/png";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
      "X-Title": "Obsidian-X",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      usage: { include: true },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${dataBase64}` } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`read-image ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const u = data?.usage ?? {};
  return {
    text: (data?.choices?.[0]?.message?.content ?? "").trim(),
    usage: {
      model: data?.model ?? model,
      prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
      completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
      cost_usd: typeof u.cost === "number" ? u.cost : null,
    },
  };
}
