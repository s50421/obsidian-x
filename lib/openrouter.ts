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
  /** Prompt tokens served from cache. Only set when caching is in play. */
  cached_tokens?: number | null;
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

// ---- tool calling (v4.2.3) ---------------------------------------------------
//
// OpenAI-compatible, per OpenRouter's docs. Three things the format demands and
// that are easy to get wrong:
//   1. `tools` must be sent on EVERY request in the loop, not just the first —
//      the router validates the schema per call.
//   2. `function.arguments` comes back as a JSON *string*, not an object.
//   3. A tool result is its own message: role "tool" + the originating
//      `tool_call_id`. Pairing on anything else silently mismatches when the
//      model calls two tools in one turn.

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** A message in a tool-using conversation. Superset of ChatMessage. */
export type ToolMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolTurn = {
  /** Assistant prose. Empty when the model only asked for tools. */
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
};

export async function chatWithTools(
  model: string,
  messages: ToolMessage[],
  tools: ToolSchema[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<ToolTurn> {
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
      tools,
      tool_choice: "auto",
      // PROMPT CACHING, and it is not optional at these sizes.
      //
      // A tool loop re-sends the system prompt and all 13 tool schemas on EVERY
      // step. Measured before this: a 3-step turn cost $0.0355 against a $0.02
      // budget, almost all of it re-reading the same input. OpenRouter's
      // automatic mode puts the breakpoint on the last cacheable block and
      // advances it as the conversation grows, which is exactly the shape of a
      // loop; cache reads bill at 0.1x input.
      cache_control: { type: "ephemeral" },
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1200,
      usage: { include: true },
    }),
    // A tool loop can make several of these; a hung call must not eat the
    // whole 60s route budget on its own.
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const u = data?.usage ?? {};

  return {
    content: typeof msg.content === "string" ? msg.content : "",
    toolCalls: Array.isArray(msg.tool_calls) ? (msg.tool_calls as ToolCall[]) : [],
    finishReason: choice.finish_reason ?? null,
    usage: {
      model: data?.model ?? model,
      prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
      completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
      cost_usd: typeof u.cost === "number" ? u.cost : null,
      cached_tokens:
        typeof u?.prompt_tokens_details?.cached_tokens === "number"
          ? u.prompt_tokens_details.cached_tokens
          : null,
    },
  };
}

/** Parse a tool call's arguments, tolerating an empty string for no-arg tools. */
export function toolArgs<T = Record<string, unknown>>(call: ToolCall): T {
  const raw = (call.function.arguments ?? "").trim();
  // Some providers omit `arguments` entirely for parameterless tools.
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}
