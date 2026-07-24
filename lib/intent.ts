import { chat, extractJson, type Usage } from "@/lib/openrouter";

// v1.5 T1 (redesign): the owner texts the bot in plain language — no commands.
// This layer reads each message and decides what they *mean*, so the webhook can
// act (and only ask for a Yes/No on big/risky things like completing everything).

export type IntentKind =
  | "save"
  | "complete"
  | "complete_all"
  | "reopen"
  | "ask"
  | "unknown";

export type Intent = {
  intent: IntentKind;
  summary: string; // short, human-readable read-back addressed to the owner
  target: string; // for "complete"/"reopen": the item the owner refers to, their words
  query: string; // for "ask": the question to answer
  confidence: number;
  usage: Usage;
};

const KINDS: IntentKind[] = [
  "save",
  "complete",
  "complete_all",
  "reopen",
  "ask",
  "unknown",
];

export async function interpretIntent(text: string, todayISO: string): Promise<Intent> {
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system =
    `You are the intent router for a personal second-brain assistant. The owner ` +
    `texts you in natural language — never commands. Read ONE message and decide ` +
    `what they want. Today is ${todayISO}.\n` +
    `Return ONLY a JSON object:\n` +
    `{\n` +
    `  "intent": one of ["save","complete","complete_all","reopen","ask","unknown"],\n` +
    `  "summary": one short sentence, addressed to the owner, describing what you'll do\n` +
    `             (e.g. "Save a task to pick up milk tomorrow", "Mark your dentist task done",\n` +
    `              "Reopen your rent task", "Answer what you owe on invoices"),\n` +
    `  "target": for "complete"/"reopen" ONLY, the item they mean in their own words, else "",\n` +
    `  "query": for "ask" ONLY, the question to answer, else "",\n` +
    `  "confidence": number 0..1\n` +
    `}\n` +
    `Definitions:\n` +
    `- "save": they are capturing something — a note, idea, reminder, or a NEW task/to-do ` +
    `("pick up milk tomorrow", "cool idea: …", "remember that …"). This is the DEFAULT.\n` +
    `- "complete": they say a SPECIFIC existing task is finished/handled/done ` +
    `("finished the report", "dentist is booked", "I paid the rent").\n` +
    `- "complete_all": they say EVERYTHING / all their tasks are done ` +
    `("all done", "done all", "finished everything", "cleared my list").\n` +
    `- "reopen": they want a previously-completed item put back to open / undone ` +
    `("reopen the rent task", "actually I didn't finish the report", "mark the dentist task not done").\n` +
    `- "ask": a genuine question or request to look something up in their notes ` +
    `("what did I say about X", "when's my meeting", "do I owe anything").\n` +
    `- "unknown": genuinely unclear.\n` +
    `Rules: when torn between save and ask, prefer "save" (a statement is usually a note). ` +
    `Only pick complete/complete_all when they clearly report something as DONE, not when ` +
    `they are adding a new task.`;

  const { content, usage } = await chat(
    model,
    [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    { json: true, temperature: 0 }
  );

  let parsed: Record<string, unknown> = {};
  try {
    parsed = extractJson<Record<string, unknown>>(content);
  } catch {
    // fall through to safe defaults (treat as a note)
  }

  const intent = (KINDS as string[]).includes(String(parsed.intent))
    ? (parsed.intent as IntentKind)
    : "save";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const target = typeof parsed.target === "string" ? parsed.target.trim() : "";
  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
  const confidence = clamp01(Number(parsed.confidence));

  return {
    intent,
    summary,
    target,
    query,
    confidence: Number.isFinite(confidence) ? confidence : 0.6,
    usage,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  return Math.min(1, Math.max(0, n));
}
