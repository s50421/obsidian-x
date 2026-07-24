import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";
import { answerQuestion } from "@/lib/ask-core";
import { interpretIntent } from "@/lib/intent";
import { embed } from "@/lib/embed";
import { deleteVaultNote } from "@/lib/vault";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";
import { sendMessage, answerCallbackQuery, editMessageText } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Two-way Telegram bot (v1.5 T1). The owner texts naturally — no commands. Every
// message is run through an intent layer (lib/intent.ts); low-risk intents act
// immediately with an Undo, and only big/risky ones (complete-all) ask Yes/No.
// Security: (1) the webhook's secret_token, echoed in the
// X-Telegram-Bot-Api-Secret-Token header; (2) owner-lock to TELEGRAM_CHAT_ID.
// Public route (excluded from proxy.ts), self-authenticating like inbound-email.

// Always ack Telegram with 200 so it doesn't retry an update we've handled.
const OK = NextResponse.json({ ok: true });

type TgUser = { id: number };
type TgChat = { id: number };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
};
type TgCallback = {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
};
type TgUpdate = { message?: TgMessage; callback_query?: TgCallback };

const HELP = [
  "🧠 Just text me naturally — no commands:",
  "• Save — “pick up milk tomorrow”, “idea: …”, “remember that …”",
  "• Done — “finished the report”, “dentist is booked”, “all done”",
  "• Ask — “what do I owe?”, “when's my meeting?”",
  "I'll act and show an Undo, and check with you before big things.",
].join("\n");

export async function POST(req: Request) {
  // 1. Verify Telegram's secret token.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return OK; // malformed — ignore
  }

  // 2. Owner-lock: ignore anything not from the owner's Telegram id.
  const ownerChatId = process.env.TELEGRAM_CHAT_ID;
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (!ownerChatId || String(fromId) !== String(ownerChatId)) {
    return OK;
  }

  // Resolve the owner's Supabase user id.
  const admin = createAdminClient();
  const { data: list, error: le } = await admin.auth.admin.listUsers();
  if (le || !list) return OK;
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return OK;

  try {
    if (update.callback_query) {
      await handleCallback(admin, owner.id, update.callback_query);
    } else if (update.message && typeof update.message.text === "string") {
      await handleMessage(admin, owner.id, update.message);
    }
  } catch (e) {
    await sendMessage(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`, {
      parse_mode: "plain",
    });
  }
  return OK;
}

// ---- messages: interpret intent, then act -----------------------------------

async function handleMessage(
  admin: SupabaseClient,
  userId: string,
  msg: TgMessage
): Promise<void> {
  const text = (msg.text ?? "").trim();
  if (!text) return;
  if (text === "/start" || text === "/help") {
    await sendMessage(HELP, { parse_mode: "plain" });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const intent = await interpretIntent(text, today);
  await logLlmUsage(admin, userId, "intent", intent.usage);

  switch (intent.intent) {
    case "complete_all":
      await promptBulkDone(admin, userId); // risky -> Yes/No
      break;
    case "complete":
      await handleComplete(admin, userId, intent.target || text);
      break;
    case "ask":
      await runAsk(userId, intent.query || text);
      break;
    case "save":
    case "unknown":
    default:
      await runCapture(admin, userId, text);
      break;
  }
}

// ---- callbacks: button taps -------------------------------------------------

async function handleCallback(
  admin: SupabaseClient,
  userId: string,
  cb: TgCallback
): Promise<void> {
  const [action, id] = (cb.data ?? "").split(":");

  if (action === "done" && id) {
    const title = await markDoneById(admin, userId, id);
    await answerCallbackQuery(cb.id, title ? `✓ Done: ${title}` : "Already done or not found");
    return;
  }
  if (action === "undo" && id) {
    const title = await undoItem(admin, userId, id);
    await answerCallbackQuery(cb.id, title ? "Removed" : "Nothing to undo");
    if (cb.message && title) {
      await editMessageText(cb.message.chat.id, cb.message.message_id, `🗑 Removed: ${title}`);
    }
    return;
  }
  if (action === "reopen" && id) {
    const title = await reopenById(admin, userId, id);
    await answerCallbackQuery(cb.id, title ? "Reopened" : "Nothing to reopen");
    if (cb.message && title) {
      await editMessageText(cb.message.chat.id, cb.message.message_id, `↩ Reopened: ${title}`);
    }
    return;
  }
  if (action === "doneall") {
    const n = await markAllTasksDone(admin, userId);
    await answerCallbackQuery(cb.id, n ? `✓ Completed ${n}` : "Nothing to complete");
    if (cb.message) {
      await editMessageText(
        cb.message.chat.id,
        cb.message.message_id,
        `✓ Marked ${n} task${n === 1 ? "" : "s"} done.`
      );
    }
    return;
  }
  if (action === "cancel") {
    await answerCallbackQuery(cb.id, "Cancelled");
    if (cb.message) {
      await editMessageText(cb.message.chat.id, cb.message.message_id, "Cancelled — nothing changed.");
    }
    return;
  }
  // Unknown / future callbacks (T2 approvals) — just ack.
  await answerCallbackQuery(cb.id);
}

// ---- actions ----------------------------------------------------------------

async function runCapture(admin: SupabaseClient, userId: string, text: string): Promise<void> {
  const outcome = await captureText(userId, text, "telegram");
  const lines = outcome.created.map((c) => {
    const due = c.due_at ? ` (due ${c.due_at.slice(0, 10)})` : "";
    const rev = c.needs_review ? " · needs review" : "";
    return `🧠 Saved ${c.item.type}: ${c.item.title}${due}${rev}`;
  });
  // One Undo per saved item (reversible: deletes the item + its vault note).
  const buttons = outcome.created.map((c) => [
    { text: `↩ Undo: ${c.item.title.slice(0, 32)}`, callback_data: `undo:${c.item.id}` },
  ]);
  await sendMessage(lines.join("\n") || "🧠 Saved.", {
    parse_mode: "plain",
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
}

async function runAsk(userId: string, question: string): Promise<void> {
  const { answer, sources } = await answerQuestion(userId, question);
  let reply = answer;
  if (sources.length) {
    reply += `\n\n📎 Sources:\n${sources.slice(0, 5).map((s) => `[${s.n}] ${s.title}`).join("\n")}`;
  }
  await sendMessage(reply, { parse_mode: "plain" });
}

// gte-small has a high similarity floor (even unrelated short text pairs score
// ~0.75), so a fixed low threshold matches everything. Instead we look for a
// candidate that clearly STANDS OUT: strong absolute score AND a margin over the
// pack. STRONG separates a real match (~0.9) from the noise floor (~0.78).
const COMPLETE_STRONG = 0.8;
const COMPLETE_MARGIN = 0.07;

// Complete a specific item the owner reported as done. Resolves their phrasing to
// open items semantically. Clear winner -> do it (with Undo); a close cluster ->
// let them pick; nothing convincing -> offer recent open items to tap.
async function handleComplete(admin: SupabaseClient, userId: string, target: string): Promise<void> {
  const matches = await resolveOpenMatches(admin, userId, target); // open only, sorted desc
  const top = matches[0]?.similarity ?? 0;

  if (matches.length && top >= COMPLETE_STRONG) {
    const cluster = matches.filter((m) => m.similarity >= top - COMPLETE_MARGIN);
    if (cluster.length === 1) {
      const title = await markDoneById(admin, userId, cluster[0].id);
      await sendMessage(title ? `✓ Marked done: ${title}` : "Couldn't mark that done.", {
        parse_mode: "plain",
        reply_markup: title
          ? { inline_keyboard: [[{ text: "↩ Undo", callback_data: `reopen:${cluster[0].id}` }]] }
          : undefined,
      });
      return;
    }
    await sendMessage("Which one did you finish?", {
      parse_mode: "plain",
      reply_markup: {
        inline_keyboard: cluster.slice(0, 5).map((m) => [
          { text: `✓ ${m.title.slice(0, 40)}`, callback_data: `done:${m.id}` },
        ]),
      },
    });
    return;
  }

  // No convincing match — let the owner tap the one they mean.
  const { data: recent } = await admin
    .from("items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .order("created_at", { ascending: false })
    .limit(6);
  const open = recent ?? [];
  if (open.length === 0) {
    await sendMessage("You have no open items to complete.", { parse_mode: "plain" });
    return;
  }
  await sendMessage(`I wasn't sure which you meant by “${target}”. Tap the one you finished:`, {
    parse_mode: "plain",
    reply_markup: {
      inline_keyboard: open.map((m) => [
        { text: `✓ ${m.title.slice(0, 40)}`, callback_data: `done:${m.id}` },
      ]),
    },
  });
}

// ---- data helpers -----------------------------------------------------------

type OpenMatch = { id: string; title: string; similarity: number };

// Semantic search for the owner's OPEN items matching a natural-language target,
// returned sorted by similarity (desc). Thresholding is the caller's job.
async function resolveOpenMatches(
  admin: SupabaseClient,
  userId: string,
  target: string
): Promise<OpenMatch[]> {
  const q = target.trim();
  if (!q) return [];
  const embedding = await embed(q);
  const { data: neigh } = await admin.rpc("match_neighbors", {
    query_embedding: embedding,
    owner: userId,
    exclude_id: null,
    match_count: 10,
  });
  const cands = (neigh ?? []) as { id: string; similarity: number }[];
  if (cands.length === 0) return [];
  const ids = cands.map((n) => n.id);
  const { data: openRows } = await admin
    .from("items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .in("id", ids);
  const open = new Map((openRows ?? []).map((r) => [r.id, r.title as string]));
  return cands
    .filter((n) => open.has(n.id))
    .map((n) => ({ id: n.id, title: open.get(n.id)!, similarity: n.similarity }))
    .sort((a, b) => b.similarity - a.similarity);
}

// Flip a specific item open -> done (owner-scoped). Returns the title or null.
async function markDoneById(
  admin: SupabaseClient,
  userId: string,
  id: string
): Promise<string | null> {
  const { data: item } = await admin
    .from("items")
    .update({ status: "done" })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .select("id, title")
    .maybeSingle();
  if (!item) return null;
  await logAudit(admin, {
    user_id: userId,
    item_id: item.id,
    action: "mark_done",
    actor: "user",
    detail: { via: "telegram" },
  });
  return item.title;
}

// Reverse a completion (Undo on a "marked done"): done -> open.
async function reopenById(
  admin: SupabaseClient,
  userId: string,
  id: string
): Promise<string | null> {
  const { data: item } = await admin
    .from("items")
    .update({ status: "open" })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "done")
    .select("id, title")
    .maybeSingle();
  if (!item) return null;
  await logAudit(admin, {
    user_id: userId,
    item_id: item.id,
    action: "reopen",
    actor: "user",
    detail: { via: "telegram" },
  });
  return item.title;
}

// Undo a just-saved capture: remove the item + its vault note.
async function undoItem(
  admin: SupabaseClient,
  userId: string,
  id: string
): Promise<string | null> {
  const { data: item } = await admin
    .from("items")
    .select("id, title, vault_path")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!item) return null;
  if (item.vault_path) {
    try {
      await deleteVaultNote(item.vault_path);
    } catch {
      // vault cleanup is best-effort
    }
  }
  await admin.from("audit").delete().eq("item_id", id);
  await admin.from("items").delete().eq("id", id);
  return item.title;
}

// ---- bulk complete (the one big/risky action, gated by Yes/No) --------------

async function promptBulkDone(admin: SupabaseClient, userId: string): Promise<void> {
  const { data: tasks } = await admin
    .from("items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .eq("type", "task")
    .order("created_at", { ascending: false })
    .limit(50);

  const open = tasks ?? [];
  if (open.length === 0) {
    await sendMessage("No open tasks to complete.", { parse_mode: "plain" });
    return;
  }
  const shown = open.slice(0, 20).map((t) => `• ${t.title}`).join("\n");
  const more = open.length > 20 ? `\n…and ${open.length - 20} more` : "";
  await sendMessage(
    `Mark all ${open.length} open task${open.length === 1 ? "" : "s"} done?\n${shown}${more}`,
    {
      parse_mode: "plain",
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ Yes, complete ${open.length}`, callback_data: "doneall" },
            { text: "✖ No", callback_data: "cancel" },
          ],
        ],
      },
    }
  );
}

async function markAllTasksDone(admin: SupabaseClient, userId: string): Promise<number> {
  const { data: updated } = await admin
    .from("items")
    .update({ status: "done" })
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .eq("type", "task")
    .select("id");
  const rows = updated ?? [];
  for (const it of rows) {
    await logAudit(admin, {
      user_id: userId,
      item_id: it.id,
      action: "mark_done",
      actor: "user",
      detail: { via: "telegram", bulk: true },
    });
  }
  return rows.length;
}
