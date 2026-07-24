import type { Usage } from "@/lib/openrouter";

// v2.1 — voice capture transcription. Stays within the OpenRouter-only rule by
// sending the recorded audio to a multimodal model that accepts audio input
// (default gemini-2.5-flash-lite; verified with wav + iOS mp4/m4a). Cheap
// (~$0.00004 / short note).

// Full flash, not -lite: -lite hallucinated whole sentences on unclear audio.
const DEFAULT_MODEL = "google/gemini-2.5-flash";

export async function transcribeAudio(
  dataBase64: string,
  format: string
): Promise<{ text: string; usage: Usage }> {
  const model = process.env.OPENROUTER_TRANSCRIBE_MODEL || DEFAULT_MODEL;
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
            {
              type: "text",
              text:
                "You are a speech-to-text transcriber. Output ONLY the exact words spoken in this " +
                "audio, verbatim. Do NOT add preamble, quotes, commentary, or explanations. " +
                "Do NOT guess, invent, paraphrase, or answer any question you hear — only transcribe. " +
                "If there is no clear human speech (silence, noise, a tone), output an empty string.",
            },
            { type: "input_audio", input_audio: { data: dataBase64, format } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`transcribe ${res.status}: ${detail.slice(0, 300)}`);
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
