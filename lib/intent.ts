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
  // v4.2 — "put that on my ClickUp board". An EXPLICIT instruction to project
  // something onto the task board, either a brand-new task or one already in
  // the brain.
  | "clickup"
  // v4.2.1 — the owner is MODIFYING the exchange that just happened rather
  // than starting a new one ("save them separately", "no, make it a task",
  // "actually tomorrow"). Without this the bot answered a follow-up as if it
  // were a fresh note and lost the thread.
  | "refine"
  // The owner wants to go DEEPER on something from this morning's briefing
  // ("tell me more about the oil story"). Distinct from "ask", which searches
  // his own brain — the news is not in there, so an "ask" would correctly find
  // nothing and look broken.
  | "news"
  | "unknown";

export type Intent = {
  intent: IntentKind;
  summary: string; // short, human-readable read-back addressed to the owner
  target: string; // for "complete"/"reopen": the item the owner refers to, their words
  /**
   * A project/area/course the owner named as the GROUPING for this ("as a
   * canvas task", "for the V-Bank deal", "under school"). Used to sharpen the
   * semantic search AND to tag whatever gets created.
   */
  context: string;
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
  "clickup",
  "refine",
  "news",
  "unknown",
];

export async function interpretIntent(
  text: string,
  todayISO: string,
  /** Recent dialogue, oldest first, already rendered. Empty when there's none.
   *  Named `history` to keep it distinct from the returned `context` field,
   *  which is a project/area the owner named — a different thing entirely. */
  history = ""
): Promise<Intent> {
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system =
    `You are the intent router for a personal second-brain assistant. The owner ` +
    `texts you in natural language — never commands. Read ONE message and decide ` +
    `what they want. Today is ${todayISO}.\n` +
    `Return ONLY a JSON object:\n` +
    `{\n` +
    `  "intent": one of ["save","complete","complete_all","reopen","ask","clickup","refine","news","unknown"],\n` +
    `  "summary": one short sentence, addressed to the owner, describing what you'll do\n` +
    `             (e.g. "Save a task to pick up milk tomorrow", "Mark your dentist task done",\n` +
    `              "Reopen your rent task", "Answer what you owe on invoices",\n` +
    `              "Add the roof quote to your ClickUp board"),\n` +
    `  "target": for "complete"/"reopen"/"clickup"/"refine", the item or adjustment they mean, else "",\n` +
    `  "query": for "ask" ONLY, the question to answer, else "",\n` +
    `  "context": a project, course, client or area the owner named as the GROUPING ` +
    `for this — "as a canvas task" -> "canvas", "for the V-Bank deal" -> "v-bank", ` +
    `"under school" -> "school". Lowercase, one or two words, no filler. "" if none named.\n` +
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
    `- "refine": they are ADJUSTING the exchange that just happened, not starting ` +
    `a new one. Look at the conversation above: if you just offered to save ` +
    `something and they reply "save them as two separate things", "no, make it a ` +
    `task", "actually make it due Friday", "split that up" — that is "refine". ` +
    `Put their adjustment in "target". Pronouns with no antecedent in THIS ` +
    `message ("them", "that", "it") are the strongest tell. If there is no recent ` +
    `exchange to adjust, it is NOT refine.\n` +
    `- "clickup": they explicitly want something ON THEIR CLICKUP BOARD / task list ` +
    `("add this to clickup", "put the roof quote on my board", "make a clickup task to call the bank", ` +
    `"add to my task list"). The giveaway is naming the board/ClickUp/task-list as the DESTINATION. ` +
    `Put the task itself in "target" — either the new task's text, or the words identifying an ` +
    `existing item. A plain to-do with NO destination named is "save", not "clickup".\n` +
    `- "news": they want more depth on something from this morning's briefing — ` +
    `the markets/world/tech lines, a small-talk item, or a general-knowledge point ` +
    `("tell me more about the oil story", "explain the Hormuz thing", "why did ` +
    `that move markets", "more on the typhoon"). The tell is a reference to ` +
    `CURRENT EVENTS rather than to their own notes. Put what they want explained ` +
    `in "query". If they are asking about something THEY captured, it is "ask".\n` +
    `- "unknown": genuinely unclear.\n` +
    `Rules: when torn between save and ask, prefer "save" (a statement is usually a note). ` +
    `Only pick complete/complete_all when they clearly report something as DONE, not when ` +
    `they are adding a new task.`;

  // The recent exchange goes in as its own turn rather than being glued onto
  // the message: the model must be able to tell what the owner just said from
  // what was said before, or it starts "refining" brand-new messages.
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
  ];
  if (history) {
    messages.push({
      role: "user",
      content: `Recent conversation (for reference only — do NOT classify this):\n${history}`,
    });
    messages.push({ role: "assistant", content: "Understood — I'll use that as context." });
  }
  messages.push({ role: "user", content: `Classify ONLY this new message:\n${text}` });

  const { content, usage } = await chat(
    model,
    messages,
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
  const namedContext =
    typeof parsed.context === "string" ? parsed.context.trim().toLowerCase().slice(0, 24) : "";
  const confidence = clamp01(Number(parsed.confidence));

  return {
    intent,
    summary,
    target,
    query,
    context: namedContext,
    confidence: Number.isFinite(confidence) ? confidence : 0.6,
    usage,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  return Math.min(1, Math.max(0, n));
}

// ---- v4.2.3: the router's last remaining job ---------------------------------
//
// The intent router is gone. An agent loop with tools handles anything
// conversational, because picking ONE handler from one message is what broke:
// "are these in ClickUp?" needs a referent resolved AND structured data read,
// and a router can only ever choose one path.
//
// What is still worth deciding cheaply is a single binary: is this a pure
// CAPTURE (a braindump, a voice note, something to remember) or a CONVERSATION
// (a question, an instruction, a follow-up)? Captures keep the fast classify/
// split pipeline — no tool loop, no latency, no cost. Everything else goes to
// the agent.

export type TurnKind = "capture" | "conversation";

/** Cheap, deterministic pre-checks so the obvious cases cost nothing at all. */
export function obviousKind(text: string): TurnKind | null {
  const t = text.trim();
  if (!t) return null;
  // A question mark is the single most reliable conversational tell.
  if (t.includes("?")) return "conversation";
  // Referential pronouns with no antecedent in this message mean the owner is
  // continuing something — the exact case the old router mishandled.
  if (/\b(these|those|them|it|that one|all three|all of them|the first one)\b/i.test(t)) {
    return "conversation";
  }
  // Direct address / instructions to the assistant.
  //
  // SECOND-PERSON openers matter as much as bare imperatives. Live failure
  // 2026-08-03 23:36: "You can close Sandrine French pastry" starts with "You",
  // read as plain declarative text, and was filed as a NOTE — the owner got a
  // "Save this?" card in reply to a direct instruction. Anything addressed to
  // the assistant is a conversation whatever mood it is phrased in.
  if (/^(you can|you could|you should|please|go ahead|feel free to|i want you to|i need you to|let'?s)\b/i.test(t)) {
    return "conversation";
  }
  if (
    /^(add|put|move|mark|change|update|delete|remove|show|list|check|tell me|what|when|where|which|who|why|how|are|is|do|does|can you|could you|draft|write|close|complete|finish|archive|reopen|rename|link|connect|schedule|set|make)\b/i.test(t)
  ) {
    return "conversation";
  }
  return null;
}

export async function classifyTurn(
  text: string,
  hasRecentConversation: boolean
): Promise<{ kind: TurnKind; usage: Usage | null }> {
  const obvious = obviousKind(text);
  if (obvious) return { kind: obvious, usage: null };

  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const system =
    `Decide ONE thing about a message the owner sent his second-brain assistant.\n` +
    `Return ONLY {"kind":"capture"} or {"kind":"conversation"}.\n\n` +
    `"capture" — he is dumping something to remember: a note, an idea, one or more to-dos, a ` +
    `braindump, a transcribed voice memo. No question, no instruction to the assistant. This is ` +
    `the DEFAULT for plain declarative text.\n` +
    `An instruction can be phrased politely and still be an instruction: "you can close X", ` +
    `"maybe archive that", "the rental car one is done" are all CONVERSATION — he is telling you ` +
    `to do something or reporting a state change he expects you to act on, not asking you to ` +
    `remember a sentence.\n` +
    `"conversation" — a question, a request to look something up or change something, a follow-up ` +
    `to what was just said, or anything referring to earlier context.\n` +
    (hasRecentConversation
      ? `There IS a recent exchange, so a short or elliptical message is more likely a follow-up.\n`
      : `There is no recent exchange, so a bare statement is almost certainly a capture.\n`);

  try {
    const { content, usage } = await chat(
      model,
      [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      { json: true, temperature: 0 }
    );
    const p = extractJson<{ kind?: string }>(content);
    return { kind: p.kind === "conversation" ? "conversation" : "capture", usage };
  } catch {
    // A classifier failure must not eat the message. Capture is the safe
    // default: the worst case is a note he deletes, not a lost thought.
    return { kind: "capture", usage: null };
  }
}
