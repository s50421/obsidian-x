import type { SupabaseClient } from "@supabase/supabase-js";
import { chatWithTools, toolArgs, type ToolMessage, type Usage } from "@/lib/openrouter";
import { AGENT_TOOLS, runTool, toolSchemas, type ToolContext } from "@/lib/agent-tools";
import type { Turn } from "@/lib/conversation";

// Obsidian-X v4.2.3 — the agent loop.
//
// Replaces the v1.5 intent-router for everything that is not a pure capture.
// The router's failure was structural, not a tuning problem: it picked ONE
// handler from one message, so a question that needed two lookups ("are these
// in ClickUp?" = resolve "these", then check structured data) could only ever
// get one of them, and the handler it picked was a text search over data that
// does not live in text.
//
// A loop fixes that by letting the model gather what it needs before answering.
//
// COST DISCIPLINE. Each step is a full model call, so the loop is bounded at 8
// steps and every turn is logged as op 'agent' with its step count. The brief's
// target is ≤ $0.02 for a typical turn; /ops flags anything over $0.05.

const MAX_STEPS = 8;

/**
 * The wall-clock budget for the whole loop.
 *
 * The route has maxDuration 60. Stopping at 45 leaves room to still SEND a
 * reply — a turn that times out silently is worse than a partial answer, and
 * "here's what I found, still checking X" is a usable thing to receive.
 */
const BUDGET_MS = 45_000;

export type AgentResult = {
  reply: string;
  steps: number;
  toolsUsed: string[];
  /** Items the loop created or touched — fed back into conversation memory. */
  touchedItemIds: string[];
  usage: Usage[];
  timedOut: boolean;
};

function systemPrompt(tz: string, todayISO: string): string {
  return [
    "You are Donna — the owner's chief of staff inside his second brain. You are talking to him",
    "on Telegram. He is one person; there is no other user.",
    `Today is ${todayISO}. His timezone is ${tz}.`,
    "",
    "HOW YOU ANSWER",
    "- Short, direct, plain text. No markdown, no headers, no bullet characters — this is a chat app.",
    "- Say what you did and what you found. Never pad.",
    "- If you changed something, say exactly what changed.",
    "",
    "THE RULE THAT MATTERS MOST — STRUCTURED QUESTIONS GET STRUCTURED TOOLS.",
    "Anything about status, location, counts, due dates, or whether something is on the ClickUp",
    "board is STRUCTURED data. Answer it with list_tasks / clickup_status / memory_get, never with",
    "memory_search. memory_search reads note TEXT and cannot see ClickUp links, statuses or dates.",
    "You may only say something is missing or 'not tracked' AFTER a structured tool confirms it.",
    "Never say 'based on the notes' about a structured question.",
    "",
    "PRONOUNS AND PLURALS",
    "When he says 'these', 'them', 'it', 'that', 'all three', or refers to something from earlier in",
    "the conversation, call recent_conversation_items FIRST. Items he saved a minute ago are there",
    "immediately, even before search can find them. Resolve the referent before acting, and if a",
    "plural does not resolve to the number he said, say so rather than guessing.",
    "",
    "WHEN YOU ACT ON SEVERAL THINGS",
    "Report per item. '2 created, 1 was already on the board' with the links — never a bare 'done'.",
    "",
    "HARD RULES — non-negotiable, set by the owner:",
    "1. DRAFT-ONLY COMMUNICATIONS. This system NEVER sends email, messages, or any communication to",
    "   anyone other than the owner. There is no send tool and there never will be. draft_reply",
    "   writes text HE copies and sends himself. If he asks you to send something, write the draft",
    "   and tell him plainly that you cannot send it for him.",
    "2. PROPOSE, THEN APPROVE. Destructive or outward-facing actions go through the approval flow.",
    "   clickup_create already respects his trust dial — do not try to work around it.",
    "",
    "BE DECISIVE. Call the fewest tools that answer the question, then answer. Do not re-run a",
    "search with a reworded query hoping for a better result — if the structured tools say a thing",
    "is not there, it is not there, and saying so is the correct answer. Every extra step costs the",
    "owner money and makes him wait.",
    "",
    "Be honest when a tool fails or returns nothing. A wrong confident answer is the worst outcome;",
    "'I couldn't check ClickUp just now' is a fine thing to say.",
  ].join("\n");
}

/** Conversation history as real chat turns, so the model sees its own past actions. */
function historyMessages(turns: Turn[]): ToolMessage[] {
  return turns.map((t) =>
    t.role === "user"
      ? { role: "user" as const, content: t.text }
      : { role: "assistant" as const, content: t.text }
  );
}

export async function runAgent(
  admin: SupabaseClient,
  userId: string,
  message: string,
  opts: {
    tz: string;
    turns: Turn[];
    recentItemIds?: string[];
    /** Called before each tool step so the caller can keep a typing indicator alive. */
    onStep?: (step: number, tool: string) => void;
  }
): Promise<AgentResult> {
  const model = process.env.OPENROUTER_ANSWER_MODEL!;
  const todayISO = new Date().toISOString().slice(0, 10);
  const started = Date.now();

  const ctx: ToolContext = {
    admin,
    userId,
    tz: opts.tz,
    recentItemIds: [...(opts.recentItemIds ?? [])],
  };

  const messages: ToolMessage[] = [
    { role: "system", content: systemPrompt(opts.tz, todayISO) },
    ...historyMessages(opts.turns),
    { role: "user", content: message },
  ];

  const schemas = toolSchemas(AGENT_TOOLS);
  // Deterministic repeat guard. Prompting alone did not stop the model calling
  // memory_search four times in one turn with reworded queries; this makes the
  // second identical call free and tells it plainly to move on.
  const called = new Map<string, string>();
  const usage: Usage[] = [];
  const toolsUsed: string[] = [];
  const touched = new Set<string>(opts.recentItemIds ?? []);
  let steps = 0;
  let timedOut = false;

  while (steps < MAX_STEPS) {
    if (Date.now() - started > BUDGET_MS) {
      timedOut = true;
      break;
    }

    const turn = await chatWithTools(model, messages, schemas);
    usage.push(turn.usage);

    if (!turn.toolCalls.length) {
      return {
        reply: turn.content.trim() || "I'm not sure what to do with that.",
        steps,
        toolsUsed,
        touchedItemIds: [...touched],
        usage,
        timedOut: false,
      };
    }

    // The assistant message carrying the tool calls MUST be appended before the
    // results, or the tool_call_id pairing has nothing to attach to.
    messages.push({ role: "assistant", content: turn.content || null, tool_calls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      steps += 1;
      opts.onStep?.(steps, call.function.name);
      toolsUsed.push(call.function.name);

      const args = toolArgs(call);
      const signature = `${call.function.name}:${JSON.stringify(args)}`;
      let result: Awaited<ReturnType<typeof runTool>>;
      if (called.has(signature)) {
        result = {
          error: "You already called this exact tool with these arguments in this turn.",
          hint: "Use the earlier result and answer now. Do not re-search.",
        };
      } else {
        result = await runTool(ctx, call.function.name, args);
        called.set(signature, "done");
      }

      // Any item the loop sees becomes part of the conversation's referents, so
      // a later "add those to ClickUp" resolves without another search.
      collectItemIds(result, touched);
      ctx.recentItemIds = [...touched];

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  // Out of steps or out of time. Ask for a final answer with tools disabled, so
  // the owner gets what was actually found rather than silence.
  try {
    const final = await chatWithTools(
      model,
      [
        ...messages,
        {
          role: "user",
          content:
            "Stop using tools and answer now with what you have. If something is still unchecked, " +
            "say which part you could not confirm.",
        },
      ],
      [],
      { maxTokens: 600 }
    );
    usage.push(final.usage);
    return {
      reply: final.content.trim() || "I ran out of time on that one — try asking again?",
      steps,
      toolsUsed,
      touchedItemIds: [...touched],
      usage,
      timedOut,
    };
  } catch {
    return {
      reply: "That took longer than I allow myself. Ask again and I'll pick it up.",
      steps,
      toolsUsed,
      touchedItemIds: [...touched],
      usage,
      timedOut: true,
    };
  }
}

/** Pull any item ids out of a tool result, however it nested them. */
export function collectItemIds(result: unknown, into: Set<string>): void {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const walk = (v: unknown, depth = 0) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "id" && typeof val === "string" && UUID.test(val)) into.add(val);
      else walk(val, depth + 1);
    }
  };
  walk(result);
}
