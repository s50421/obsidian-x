// Thin wrapper over the OpenRouter chat completions API.
// This is the ONLY model provider the app talks to.

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatOptions = {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
};

export type Usage = {
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
};

export type ChatResult = { content: string; usage: Usage };

export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<ChatResult> {
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
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens,
      // Ask OpenRouter to include token + cost accounting in the response.
      usage: { include: true },
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  const u = data?.usage ?? {};
  return {
    content: data?.choices?.[0]?.message?.content ?? "",
    usage: {
      model: data?.model ?? model,
      prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
      completion_tokens:
        typeof u.completion_tokens === "number" ? u.completion_tokens : null,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
      cost_usd: typeof u.cost === "number" ? u.cost : null,
    },
  };
}

// Parse a JSON object out of a model response, tolerating stray prose or fences.
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error(`Model did not return JSON: ${trimmed.slice(0, 200)}`);
  }
}
