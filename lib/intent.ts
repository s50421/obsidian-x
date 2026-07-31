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
    `  "intent": one of ["save","complete","complete_all","reopen","ask","clickup","refine","unknown"],\n` +
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
