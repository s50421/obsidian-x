import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";
import { answerQuestion } from "@/lib/ask-core";
import { logAudit } from "@/lib/audit";
import {
  sendMessage,
  answerCallbackQuery,
  type InlineKeyboard,
} from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Two-way Telegram bot (v1.5 T1). Inbound updates from Telegram land here.
// Security: (1) the webhook is registered with a secret_token, which Telegram
// echoes in the X-Telegram-Bot-Api-Secret-Token header — we require it; (2) we
// hard-lock to the owner's Telegram user id (TELEGRAM_CHAT_ID). This route is
// public (excluded from proxy.ts) and self-authenticates like inbound-email.

// Always ack Telegram with 200 so it doesn't retry an update we've handled.
const OK = NextResponse.json({ ok: true });

type TgUser = { id: number };
type TgChat = { id: number };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  reply_to_message?: TgMessage;
};
type TgCallback = {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
};
type TgUpdate = { message?: TgMessage; callback_query?: TgCallback };

const HELP = [
  "🧠 Obsidian-X — reply to me to:",
  "• Capture — just send any message.",
  '• Ask — end with "?" or use /ask <question>.',
  "• Done — /done <keyword>, reply “done” to an item, or tap ✓ Done.",
].join("\n");

const ITEM_TYPES = "task|note|idea|shopping|reference|person|event";

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
    return OK; // silently ignore non-owner updates
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
    // Best-effort: surface the error to the owner but still ack (no retry storm).
    await sendMessage(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`, {
      parse_mode: "plain",
    });
  }
  return OK;
}

async function handleMessage(
  admin: SupabaseClient,
  userId: string,
  msg: TgMessage
): Promise<void> {
  const text = (msg.text ?? "").trim();
  const lower = text.toLowerCase();

  if (lower === "/start" || lower === "/help") {
    await sendMessage(HELP, { parse_mode: "plain" });
    return;
  }

  // Mark done: "/done <keyword>", or a reply whose text is a done-intent.
  const doneCmd = text.match(/^\/done\b\s*(.*)$/i);
  const replyDone =
    !!msg.reply_to_message && /^(done|✓|✅|\/done)\b/i.test(text) && !doneCmd;
  if (doneCmd || replyDone) {
    let keyword = doneCmd
      ? doneCmd[1].trim()
      : text.replace(/^(done|✓|✅|\/done)\b/i, "").trim();
    if (!keyword && msg.reply_to_message?.text) {
      keyword = extractItemKeyword(msg.reply_to_message.text);
    }
    await markDoneByKeyword(admin, userId, keyword);
    return;
  }

  // Ask: "/ask <q>" or any message ending in "?".
  const askCmd = text.match(/^\/ask\b\s*(.*)$/i);
  if (askCmd || text.endsWith("?")) {
    const q = askCmd ? askCmd[1].trim() : text;
    if (!q) {
      await sendMessage("Ask me a question and I'll check your notes.", {
        parse_mode: "plain",
      });
      return;
    }
    await runAsk(userId, q);
    return;
  }

  // Default: capture.
  await runCapture(admin, userId, text);
}

async function handleCallback(
  admin: SupabaseClient,
  userId: string,
  cb: TgCallback
): Promise<void> {
  const [action, id] = (cb.data ?? "").split(":");
  if (action === "done" && id) {
    const title = await markDoneById(admin, userId, id);
    await answerCallbackQuery(
      cb.id,
      title ? `✓ Done: ${title}` : "Already done or not found"
    );
    return;
  }
  // Unknown / future callbacks (approve/reject arrive in T2) — just ack.
  await answerCallbackQuery(cb.id);
}

async function runCapture(
  admin: SupabaseClient,
  userId: string,
  text: string
): Promise<void> {
  const outcome = await captureText(userId, text, "telegram");
  const lines = outcome.created.map((c) => {
    const flag = c.needs_review ? " — needs review" : "";
    return `• ${c.item.title} (${c.item.type})${flag}`;
  });
  const header =
    outcome.created.length > 1
      ? `🧠 Captured ${outcome.created.length} items:`
      : "🧠 Captured:";

  // Offer a ✓ Done button for any captured task, so the owner can complete it
  // straight from the confirmation.
  const taskRows = outcome.created
    .filter((c) => c.item.type === "task")
    .map((c) => [
      { text: `✓ Done: ${c.item.title.slice(0, 40)}`, callback_data: `done:${c.item.id}` },
    ]);
  const reply_markup: InlineKeyboard | undefined = taskRows.length
    ? { inline_keyboard: taskRows }
    : undefined;

  await sendMessage([header, ...lines].join("\n"), {
    parse_mode: "plain",
    reply_markup,
  });
}

async function runAsk(userId: string, question: string): Promise<void> {
  const { answer, sources } = await answerQuestion(userId, question);
  let reply = answer;
  if (sources.length) {
    const list = sources
      .slice(0, 5)
      .map((s) => `[${s.n}] ${s.title}`)
      .join("\n");
    reply += `\n\n📎 Sources:\n${list}`;
  }
  await sendMessage(reply, { parse_mode: "plain" });
}

// Flip a specific item open -> done (owner-scoped). Returns the title, or null
// if it wasn't open / didn't belong to the owner.
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

// Mark done by fuzzy title. 0 matches -> report; 1 -> done; many -> disambiguate
// with ✓ Done buttons.
async function markDoneByKeyword(
  admin: SupabaseClient,
  userId: string,
  keyword: string
): Promise<void> {
  if (!keyword) {
    await sendMessage("Which item? Use /done <keyword>, or tap ✓ Done.", {
      parse_mode: "plain",
    });
    return;
  }
  const { data: rows } = await admin
    .from("items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .ilike("title", `%${keyword}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  const matches = rows ?? [];
  if (matches.length === 0) {
    await sendMessage(`No open item matches “${keyword}”.`, { parse_mode: "plain" });
    return;
  }
  if (matches.length === 1) {
    const title = await markDoneById(admin, userId, matches[0].id);
    await sendMessage(title ? `✓ Done: ${title}` : "Couldn't mark that done.", {
      parse_mode: "plain",
    });
    return;
  }
  await sendMessage(`Multiple matches for “${keyword}” — tap one:`, {
    parse_mode: "plain",
    reply_markup: {
      inline_keyboard: matches.map((m) => [
        { text: `✓ ${m.title.slice(0, 40)}`, callback_data: `done:${m.id}` },
      ]),
    },
  });
}

// Recover a searchable keyword from the text of a message the owner replied to
// (e.g. a capture confirmation "• Buy milk (task)" or a brief due-item line).
function extractItemKeyword(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bullet = lines.find((l) => l.startsWith("•"));
  let base = bullet ?? lines[0] ?? "";
  base = base.replace(/^[•\-*\s]+/, ""); // strip leading bullet
  base = base.replace(new RegExp(`\\s*\\((${ITEM_TYPES})\\)\\s*$`, "i"), ""); // strip "(task)"
  base = base.replace(/\s*_?\(due[^)]*\)_?\s*$/i, ""); // strip "(due …)"
  return base.trim();
}
