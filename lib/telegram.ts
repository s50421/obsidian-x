// Telegram Bot API helpers. Outbound push (v1.4) + the two-way channel (v1.5).
// Everything is a no-op until TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set.

// A button is either a callback (round-trips through our webhook) or a plain
// deep-link (opens the URL directly, e.g. the PWA's /deck route — v4.0 W3).
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

type SendOpts = {
  reply_markup?: InlineKeyboard;
  reply_to_message_id?: number;
  chat_id?: string | number; // defaults to the owner's TELEGRAM_CHAT_ID
  // "Markdown" (default) for our own composed messages; "plain" for anything
  // interpolating item titles or LLM output, which could break Markdown parsing.
  parse_mode?: "Markdown" | "plain";
};

function token(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

// Low-level Bot API call. Returns the parsed `result` on success, else null.
// Best-effort: network/API errors never throw into the caller.
async function api<T = unknown>(
  method: string,
  params: Record<string, unknown>
): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const json = (await res.json()) as { ok: boolean; result?: T };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

// v4.1 — a real liveness probe for the coverage panel. Telegram is a PUSH
// source, so "nothing arrived today" says nothing about health; what actually
// matters is whether the bot token still works and the webhook is registered
// and not backed up with failures.
export async function checkTelegramHealth(): Promise<{ ok: boolean; error: string | null }> {
  if (!token()) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  const info = await api<{
    url?: string;
    last_error_message?: string;
    pending_update_count?: number;
  }>("getWebhookInfo", {});
  if (!info) return { ok: false, error: "Bot API unreachable or token rejected" };
  if (!info.url) return { ok: false, error: "no webhook registered" };
  if (info.last_error_message) {
    return { ok: false, error: `webhook delivery error: ${info.last_error_message}` };
  }
  return { ok: true, error: null };
}

// Send a message to the owner's chat (or an explicit chat_id). Markdown-parsed.
export async function sendMessage(
  text: string,
  opts: SendOpts = {}
): Promise<{ message_id: number } | null> {
  const chatId = opts.chat_id ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return null;
  const markdown = (opts.parse_mode ?? "Markdown") === "Markdown";
  return api<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    ...(markdown ? { parse_mode: "Markdown" } : {}),
    disable_web_page_preview: true,
    ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    ...(opts.reply_to_message_id ? { reply_to_message_id: opts.reply_to_message_id } : {}),
  });
}

// Acknowledge an inline-button tap (stops the client's loading spinner; the
// optional text shows as a toast). Must be called for every callback_query.
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await api("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

// Edit a previously sent message's text (used to reflect an action, e.g.
// striking through a due item once it's marked done) and optionally its keyboard.
export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  reply_markup?: InlineKeyboard
): Promise<void> {
  await api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {}),
  });
}

// Backwards-compatible outbound push (v1.4 digest + morning brief).
export async function notifyTelegram(text: string): Promise<void> {
  await sendMessage(text);
}
