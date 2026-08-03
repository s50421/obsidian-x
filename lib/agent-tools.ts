import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolSchema } from "@/lib/openrouter";
import { answerQuestion } from "@/lib/ask-core";
import { draftForTask } from "@/lib/draft";
import { fetchUpcomingEvents } from "@/lib/calendar";
import { loadSourceStatus, healthOf } from "@/lib/source-status";
import { clickupConfigured, getClickUpTaskStatus, isClickUpDone } from "@/lib/clickup";
import { proposeClickUpTaskForItem, applyProposal, notifyClickUpProposal } from "@/lib/proposals";
import { projectionMode, effectiveMode } from "@/lib/task-projection";
import { captureText } from "@/lib/capture-core";
import { logAudit } from "@/lib/audit";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { localDateStr } from "@/lib/tz";
import { explainStory, getDailyBriefing } from "@/lib/news";

// Obsidian-X v4.2.3 — the toolbox.
//
// ONE registry, TWO consumers: the Telegram agent loop today, v4.3's MCP server
// later. That is why nothing here knows about Telegram — every tool is a pure
// function of (ctx, args) returning a small JSON-serialisable object. Adding the
// MCP transport should mean wrapping these, not rewriting them.
//
// WHY THIS EXISTS AT ALL. The old bot classified an intent and ran one handler.
// On 2026-08-02 the owner asked "are these in ClickUp?" about items saved sixty
// seconds earlier; the router sent it to the RAG path, which searched note TEXT
// for the word "ClickUp", found nothing, and reported the task "doesn't appear
// to exist". The linkage lives in `items.external` — structured data the text
// search cannot see. Hence the governing rule, repeated in the system prompt:
//
//   STRUCTURED QUESTIONS GET STRUCTURED TOOLS. Status, location, count and due
//   questions are answered from the database, never from semantic text search.
//   "Not tracked" may only be said after list_tasks/clickup_status confirm it.
//
// HARD RULE (AGENTS.md #1): there is no send tool. There will never be a send
// tool. draft_reply produces text the owner sends himself. If a future task
// seems to need one, the answer is a better draft path.

export type ToolContext = {
  admin: SupabaseClient;
  userId: string;
  tz: string;
  /** Item ids touched earlier in THIS conversation — the "these/it/that" fix. */
  recentItemIds?: string[];
};

export type ToolResult = Record<string, unknown> | { error: string };

export type AgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True for tools that change something — used for audit + MCP gating. */
  mutates?: boolean;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Compact item shape. Small on purpose — tool output competes for context. */
function briefItem(i: Record<string, unknown>) {
  const ext = (i.external ?? {}) as { clickup?: { id?: string; url?: string } };
  return {
    id: i.id,
    title: i.title ?? "(untitled)",
    type: i.type,
    status: i.status,
    due: i.due_at ?? null,
    clickup: ext.clickup?.url ?? null,
    tags: i.tags ?? [],
  };
}

// ---------------------------------------------------------------------------

const memory_search: AgentTool = {
  name: "memory_search",
  description:
    "Semantic search over the owner's saved memories. Use for OPEN questions about what he wrote " +
    "(\"what did I say about the roof?\"). Do NOT use for status, counts, due dates, or whether " +
    "something is on ClickUp — those are structured and have their own tools.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language question" },
    },
    required: ["query"],
  },
  async run(ctx, args) {
    const query = str(args.query);
    if (!query) return { error: "query required" };
    const { answer, sources } = await answerQuestion(ctx.userId, query);
    return {
      answer,
      sources: sources.slice(0, 5).map((s) => ({ n: s.n, title: s.title })),
      note: "This is a TEXT search. It cannot see ClickUp links, status or due dates.",
    };
  },
};

const memory_get: AgentTool = {
  name: "memory_get",
  description:
    "Full detail for one memory by id, INCLUDING structured fields: status, due date, ClickUp " +
    "link, tags, entities. Use this to answer anything factual about a specific item.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Item id" } },
    required: ["id"],
  },
  async run(ctx, args) {
    const id = str(args.id);
    if (!id) return { error: "id required" };
    const { data } = await ctx.admin
      .from("items")
      .select("id,title,body,type,status,priority,tags,due_at,external,entities,source,created_at,sensitive")
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (!data) return { error: "no such item" };
    // The privacy law holds for agents too (v4.3 brief says the same).
    const body = data.sensitive ? "(sensitive — body withheld)" : str(data.body).slice(0, 2000);
    return { ...briefItem(data), body, source: data.source, created: data.created_at };
  },
};

const recent_conversation_items: AgentTool = {
  name: "recent_conversation_items",
  description:
    "Items created or discussed in the CURRENT conversation, newest first. ALWAYS call this " +
    "first when the owner says \"these\", \"them\", \"it\", \"that\", \"all three\" or similar — " +
    "before any search. Freshly created items are here immediately, even before they are " +
    "searchable.",
  parameters: { type: "object", properties: {} },
  async run(ctx) {
    // Two sources, because either alone has a blind spot: ids the loop recorded
    // this conversation, plus anything captured in the last hour (which catches
    // items saved a minute ago that semantic search has not caught up with).
    const ids = ctx.recentItemIds ?? [];
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();

    const [byId, byTime] = await Promise.all([
      ids.length
        ? ctx.admin
            .from("items")
            .select("id,title,type,status,due_at,external,tags,created_at")
            .eq("user_id", ctx.userId)
            .in("id", ids)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ctx.admin
        .from("items")
        .select("id,title,type,status,due_at,external,tags,created_at")
        .eq("user_id", ctx.userId)
        .neq("status", "archived")
        .is("valid_to", null)
        .gte("created_at", hourAgo)
        .order("created_at", { ascending: false })
        .limit(12),
    ]);

    const seen = new Set<string>();
    const items: ReturnType<typeof briefItem>[] = [];
    for (const r of [...(byId.data ?? []), ...(byTime.data ?? [])]) {
      const id = r.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(briefItem(r));
    }
    return { items, count: items.length };
  },
};

const list_tasks: AgentTool = {
  name: "list_tasks",
  description:
    "Structured list of the owner's tasks from the database. Use for \"what's on my plate\", " +
    "\"what's due this week\", \"what's on my board\" — never semantic search for these.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "done", "all"], description: "Default open" },
      due_within_days: { type: "number", description: "Only tasks due within N days" },
      on_clickup: { type: "boolean", description: "true = only tasks linked to ClickUp" },
      limit: { type: "number", description: "Default 20" },
    },
  },
  async run(ctx, args) {
    const status = str(args.status, "open");
    let q = ctx.admin
      .from("items")
      .select("id,title,type,status,due_at,external,tags")
      .eq("user_id", ctx.userId)
      .eq("type", "task")
      .is("valid_to", null)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(Math.min(50, num(args.limit, 20)));

    if (status !== "all") q = q.eq("status", status);
    if (typeof args.due_within_days === "number") {
      const until = new Date(Date.now() + args.due_within_days * 86400_000).toISOString();
      q = q.lte("due_at", until).not("due_at", "is", null);
    }

    const { data, error } = await q;
    if (error) return { error: error.message };
    let items = (data ?? []).map(briefItem);
    if (args.on_clickup === true) items = items.filter((i) => i.clickup);
    if (args.on_clickup === false) items = items.filter((i) => !i.clickup);
    return { items, count: items.length, today: localDateStr(ctx.tz) };
  },
};

const clickup_status: AgentTool = {
  name: "clickup_status",
  description:
    "Whether a memory is on the ClickUp board, and its LIVE status there. This is the ONLY " +
    "correct way to answer \"is this in ClickUp?\" — the link lives in structured data that " +
    "text search cannot see.",
  parameters: {
    type: "object",
    properties: {
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: "One or more item ids to check",
      },
    },
    required: ["item_ids"],
  },
  async run(ctx, args) {
    const ids = Array.isArray(args.item_ids) ? args.item_ids.filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) return { error: "item_ids required" };

    const { data } = await ctx.admin
      .from("items")
      .select("id,title,external")
      .eq("user_id", ctx.userId)
      .in("id", ids);

    const results = [];
    for (const r of data ?? []) {
      const ext = (r.external ?? {}) as { clickup?: { id?: string; url?: string } };
      if (!ext.clickup?.id) {
        results.push({ id: r.id, title: r.title, on_board: false });
        continue;
      }
      // Live check, not just the stored ref — the owner may have closed it in
      // ClickUp, and reporting a stale "open" is the kind of half-right answer
      // the no-half-baked law exists to prevent.
      let live: string | null = null;
      try {
        const s = await getClickUpTaskStatus(ext.clickup.id);
        live = s ? `${s.status}${isClickUpDone(s.type) ? " (done)" : ""}` : null;
      } catch {
        live = null;
      }
      results.push({
        id: r.id,
        title: r.title,
        on_board: true,
        url: ext.clickup.url ?? null,
        clickup_status: live,
      });
    }
    // Ids that matched no item at all must be reported, not silently dropped.
    const found = new Set((data ?? []).map((r) => r.id as string));
    for (const id of ids) if (!found.has(id)) results.push({ id, error: "no such item" });
    return { results, configured: clickupConfigured() };
  },
};

const clickup_create: AgentTool = {
  name: "clickup_create",
  description:
    "Put an existing memory onto the ClickUp board. Respects the owner's trust dial: a task " +
    "with a due date is created immediately, an undated one is proposed for approval. " +
    "Returns per-item outcomes.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      item_ids: { type: "array", items: { type: "string" } },
    },
    required: ["item_ids"],
  },
  async run(ctx, args) {
    const ids = Array.isArray(args.item_ids) ? args.item_ids.filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) return { error: "item_ids required" };
    if (!clickupConfigured()) return { error: "ClickUp is not configured" };

    const dial = await projectionMode(ctx.admin, ctx.userId);
    const { data: items } = await ctx.admin
      .from("items")
      .select("id,title,due_at,external")
      .eq("user_id", ctx.userId)
      .in("id", ids);

    const results = [];
    for (const it of items ?? []) {
      const ext = (it.external ?? {}) as { clickup?: { id?: string; url?: string } };
      if (ext.clickup?.id) {
        results.push({ id: it.id, title: it.title, outcome: "already on the board", url: ext.clickup.url ?? null });
        continue;
      }
      const proposal = await proposeClickUpTaskForItem(ctx.admin, ctx.userId, it.id as string, "agent");
      if (!proposal) {
        results.push({ id: it.id, title: it.title, outcome: "could not propose" });
        continue;
      }
      // Propose-then-approve is the design law; the dial is the owner's own
      // documented exception for tasks he already committed to with a date.
      if (effectiveMode(dial, !!it.due_at) === "auto") {
        const applied = await applyProposal(ctx.admin, ctx.userId, proposal.id);
        results.push({
          id: it.id,
          title: it.title,
          outcome: applied.ok ? "created" : `failed: ${applied.message ?? "unknown"}`,
          url: applied.url ?? null,
        });
      } else {
        await notifyClickUpProposal(proposal);
        results.push({ id: it.id, title: it.title, outcome: "proposed — waiting for your approval" });
      }
    }
    const found = new Set((items ?? []).map((r) => r.id as string));
    for (const id of ids) if (!found.has(id)) results.push({ id, outcome: "no such item" });
    return { results };
  },
};

const update_item: AgentTool = {
  name: "update_item",
  description:
    "Change one memory's title, status or due date. Small, reversible edits only — audited. " +
    "Confirm with the owner in your reply what you changed.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      status: { type: "string", enum: ["open", "done", "archived"] },
      due_at: { type: "string", description: "ISO date, or empty string to clear" },
    },
    required: ["id"],
  },
  async run(ctx, args) {
    const id = str(args.id);
    if (!id) return { error: "id required" };

    const { data: before } = await ctx.admin
      .from("items")
      .select("id,title,status,due_at")
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (!before) return { error: "no such item" };

    const patch: Record<string, unknown> = {};
    if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim().slice(0, 300);
    if (typeof args.status === "string" && ["open", "done", "archived"].includes(args.status)) {
      patch.status = args.status;
    }
    if (typeof args.due_at === "string") patch.due_at = args.due_at.trim() || null;
    if (!Object.keys(patch).length) return { error: "nothing to change" };

    const { error } = await ctx.admin.from("items").update(patch).eq("id", id).eq("user_id", ctx.userId);
    if (error) return { error: error.message };
    await reprojectItemToVault(ctx.admin, id).catch(() => {});
    // `before` is recorded so the change is undo-able and so the corrections
    // report can tell what actually changed.
    await logAudit(ctx.admin, {
      user_id: ctx.userId,
      item_id: id,
      action: "agent_update_item",
      actor: "agent",
      detail: { patch, before: { title: before.title, status: before.status, due_at: before.due_at } },
    });
    return { ok: true, id, changed: Object.keys(patch), before: { title: before.title, status: before.status, due_at: before.due_at } };
  },
};

const calendar_tool: AgentTool = {
  name: "calendar",
  description: "The owner's upcoming calendar events. Use for \"what's on tomorrow\" / \"am I free\".",
  parameters: {
    type: "object",
    properties: { hours: { type: "number", description: "Window in hours, default 24" } },
  },
  async run(ctx, args) {
    const events = await fetchUpcomingEvents(Math.min(24 * 14, num(args.hours, 24)));
    return {
      events: events.slice(0, 25).map((e) => ({
        summary: e.summary,
        start: e.start.toISOString(),
        end: e.end?.toISOString() ?? null,
        allDay: e.allDay,
        calendar: e.calendar,
        location: e.location ?? null,
      })),
      count: events.length,
    };
  },
};

const draft_reply: AgentTool = {
  name: "draft_reply",
  description:
    "Write a reply or message for the owner to send HIMSELF. This system never sends anything " +
    "to anyone else — the draft comes back as text he copies. There is no send tool.",
  parameters: {
    type: "object",
    properties: {
      about: { type: "string", description: "What the reply should say / who it is to" },
    },
    required: ["about"],
  },
  async run(ctx, args) {
    const about = str(args.about);
    if (!about) return { error: "about required" };
    const { draft } = await draftForTask(ctx.userId, about);
    return {
      draft,
      reminder: "DRAFT ONLY — nothing was sent. The owner copies and sends this himself.",
    };
  },
};

const coverage_status: AgentTool = {
  name: "coverage_status",
  description: "What the system can currently see — which sources are connected and healthy.",
  parameters: { type: "object", properties: {} },
  async run(ctx) {
    const rows = await loadSourceStatus(ctx.admin, ctx.userId);
    const now = Date.now();
    return {
      sources: rows
        .filter((r) => !r.channel)
        .map((r) => ({ source: r.source, label: r.label, health: healthOf(r, now), last24h: r.events_24h ?? 0 })),
    };
  },
};

const save_memory: AgentTool = {
  name: "save_memory",
  description:
    "Save something new into the brain, through the normal capture pipeline (classify, title, " +
    "split, embed). Use when the owner asks you to remember or add something mid-conversation.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Exactly what the owner said, not a paraphrase" },
    },
    required: ["text"],
  },
  async run(ctx, args) {
    const text = str(args.text);
    if (!text.trim()) return { error: "text required" };
    // The owner's RAW words. A paraphrase measurably changes how the splitter
    // files things (v4.2.1 measured this twice), so the tool description says
    // so and this is the one place it matters most.
    const outcome = await captureText(ctx.userId, text, "agent");
    return {
      created: outcome.created.map((c) => ({
        id: c.item.id,
        title: c.item.title,
        type: c.item.type,
        due: c.due_at,
      })),
      split: outcome.split,
    };
  },
};

const news_lookup: AgentTool = {
  name: "news_lookup",
  description:
    "Explain a story from this morning's briefing, or look up current events on the web. Use when " +
    "the owner asks about the news, markets, or something from his morning letter — that content " +
    "was never captured into the brain, so memory_search would correctly find nothing and look broken.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "What he wants explained" } },
    required: ["question"],
  },
  async run(ctx, args) {
    const question = str(args.question);
    if (!question) return { error: "question required" };
    const { digest } = await getDailyBriefing(ctx.admin, ctx.userId, localDateStr(ctx.tz));
    const { answer, sources, error } = await explainStory(question, digest);
    if (error || !answer) return { error: error ?? "no answer" };
    return { answer, sources };
  },
};

const complete_tasks: AgentTool = {
  name: "complete_tasks",
  description:
    "Mark one or more tasks done. Reversible (they can be reopened) and audited. CONFIRM WITH THE " +
    "OWNER IN CHAT before completing more than three at once — 'mark everything done' is a big " +
    "blast radius and he should say yes first.",
  mutates: true,
  parameters: {
    type: "object",
    properties: { item_ids: { type: "array", items: { type: "string" } } },
    required: ["item_ids"],
  },
  async run(ctx, args) {
    const ids = Array.isArray(args.item_ids) ? args.item_ids.filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) return { error: "item_ids required" };
    // Bounded regardless of what the model asks for. A runaway loop must not be
    // able to close the owner's entire board in one call.
    const capped = ids.slice(0, 25);

    const { data: items } = await ctx.admin
      .from("items")
      .select("id,title,status")
      .eq("user_id", ctx.userId)
      .in("id", capped);

    const results = [];
    for (const it of items ?? []) {
      if (it.status === "done") {
        results.push({ id: it.id, title: it.title, outcome: "was already done" });
        continue;
      }
      await ctx.admin.from("items").update({ status: "done" }).eq("id", it.id).eq("user_id", ctx.userId);
      await reprojectItemToVault(ctx.admin, it.id as string).catch(() => {});
      await logAudit(ctx.admin, {
        user_id: ctx.userId,
        item_id: it.id as string,
        action: "agent_complete",
        actor: "agent",
        detail: { title: it.title },
      });
      results.push({ id: it.id, title: it.title, outcome: "marked done" });
    }
    return { results, skipped: Math.max(0, ids.length - capped.length) };
  },
};

// ---------------------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  recent_conversation_items,
  list_tasks,
  clickup_status,
  memory_get,
  memory_search,
  clickup_create,
  update_item,
  calendar_tool,
  draft_reply,
  coverage_status,
  save_memory,
  complete_tasks,
  news_lookup,
];

export const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

/** The registry as OpenAI/OpenRouter tool schemas. v4.3's MCP server maps the same list. */
export function toolSchemas(tools: AgentTool[] = AGENT_TOOLS): ToolSchema[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Run one tool by name, never throwing.
 *
 * A tool that throws would abort the whole loop and lose the turn; returning the
 * error as data lets the model recover, say what failed, or try another tool —
 * which is the difference between "I couldn't check ClickUp just now" and
 * silence.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.run(ctx, args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
