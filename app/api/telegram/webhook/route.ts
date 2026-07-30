import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";
import { answerQuestion } from "@/lib/ask-core";
import { interpretIntent } from "@/lib/intent";
import { embedText } from "@/lib/embed";
import { deleteVaultNote } from "@/lib/vault";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { applyProposal, rejectProposalById } from "@/lib/proposals";
import { logAudit } from "@/lib/audit";
import { reportSourceStatus } from "@/lib/source-status";
import { JUNK_ARCHIVE_SCORE } from "@/lib/title-standard.mjs";
import { senderName, type InflowRow as LetterInflowRow } from "@/lib/letter";
import { generateDraft, loadDrafts } from "@/lib/letter-drafts";
import { logLlmUsage } from "@/lib/usage";
import { sendMessage, answerCallbackQuery, editMessageText } from "@/lib/telegram";
import {
  resolveOwnerTz,
  isValidIanaTimeZone,
  getSettingValue,
  setSettingValue,
  describeSixThirty,
  SETTINGS_KEY_TZ_OVERRIDE,
} from "@/lib/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Two-way Telegram bot (v1.5 T1). The owner texts naturally — no commands. Every
// message runs through an intent layer (lib/intent.ts). Saving a note/task and
// completing everything both ask a Yes/No first; single complete/reopen act with
// an Undo; questions are answered directly.
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
  "• Save — “pick up milk tomorrow”, “idea: …” (I confirm before saving)",
  "• Done — “finished the report”, “dentist is booked”, “all done”",
  "• Reopen — “reopen the rent task”, “I didn't finish X”",
  "• Ask — “what do I owe?”, “when's my meeting?”",
  "",
  "One real command: /tz — check or change the timezone your 6:30am letter uses.",
].join("\n");

// Text that suggests the owner is asking about timezone but the intent model
// didn't recognize a /tz-shaped command (e.g. "what timezone are you using").
const TIMEZONE_HINT_RE = /\btime\s?zone\b/i;

// The "would be junk" bar (8/10). Junk is surfaced, never auto-archived.
const JUNK_FLAG_SCORE = JUNK_ARCHIVE_SCORE;

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

  // v4.1 — a live update IS proof the channel works; keep the coverage panel
  // fresh between morning briefs.
  void reportSourceStatus(admin, owner.id, {
    source: "telegram",
    label: "Telegram",
    connected: true,
    error: null,
  });

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
  // Timezone command — handled BEFORE the LLM intent step (v4.0 W4). Every
  // other behavior below is unchanged.
  if (/^\/tz(\s|$)/i.test(text)) {
    await handleTzCommand(admin, userId, text);
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
    case "reopen":
      await handleReopen(admin, userId, intent.target || text);
      break;
    case "ask":
      await runAsk(userId, intent.query || text);
      break;
    case "unknown":
      // Didn't parse as a clear intent — if it reads like a timezone question,
      // point at /tz instead of quietly filing it away as a note.
      if (TIMEZONE_HINT_RE.test(text)) {
        await sendTzHelp(admin, userId);
        break;
      }
      await promptSave(admin, userId, text, intent.summary); // confirm before saving
      break;
    case "save":
    default:
      await promptSave(admin, userId, text, intent.summary); // confirm before saving
      break;
  }
}

// ---- /tz command (v4.0 W4) ---------------------------------------------------

async function sendTzHelp(admin: SupabaseClient, userId: string): Promise<void> {
  const tz = await resolveOwnerTz(admin, userId);
  const override = await getSettingValue<string>(admin, userId, SETTINGS_KEY_TZ_OVERRIDE);
  const mode = override && override !== "auto" ? "manual override" : "auto, from your calendar";
  await sendMessage(
    [
      `🕐 Current timezone: ${tz} (${mode}).`,
      "",
      "To change it: /tz <IANA name>, e.g. /tz Europe/Berlin",
      "Back to automatic: /tz auto",
    ].join("\n"),
    { parse_mode: "plain" }
  );
}

async function handleTzCommand(admin: SupabaseClient, userId: string, text: string): Promise<void> {
  const arg = text.replace(/^\/tz\s*/i, "").trim();

  if (!arg) {
    await sendTzHelp(admin, userId);
    return;
  }

  if (arg.toLowerCase() === "auto") {
    await setSettingValue(admin, userId, SETTINGS_KEY_TZ_OVERRIDE, "auto");
    await logAudit(admin, {
      user_id: userId,
      action: "tz_override_cleared",
      actor: "user",
      detail: { via: "telegram" },
    });
    const tz = await resolveOwnerTz(admin, userId);
    await sendMessage(
      `🕐 Back to automatic — inferred from your calendar: ${tz}.\n${describeSixThirty(tz)}`,
      { parse_mode: "plain" }
    );
    return;
  }

  if (!isValidIanaTimeZone(arg)) {
    await sendMessage(
      `⚠️ "${arg}" doesn't look like a valid timezone. Use an IANA name, e.g. Europe/Berlin, America/New_York, Asia/Kolkata.`,
      { parse_mode: "plain" }
    );
    return;
  }

  await setSettingValue(admin, userId, SETTINGS_KEY_TZ_OVERRIDE, arg);
  await logAudit(admin, {
    user_id: userId,
    action: "tz_override_set",
    actor: "user",
    detail: { via: "telegram", tz: arg },
  });
  await sendMessage(
    `🕐 Timezone set to ${arg}. Your morning letter will now target 6:30am there.\n${describeSixThirty(arg)}`,
    { parse_mode: "plain" }
  );
}

// ---- callbacks: button taps -------------------------------------------------

async function handleCallback(
  admin: SupabaseClient,
  userId: string,
  cb: TgCallback
): Promise<void> {
  const [action, id, extra] = (cb.data ?? "").split(":");

  // v4.2 — the daily letter's buttons.
  if (action === "mdraft" && id) {
    await showMailDraft(admin, userId, id, cb);
    return;
  }
  if (action === "mdone" && id) {
    await markInflowHandled(admin, userId, id, cb);
    return;
  }
  if (action === "lrate" && id) {
    await rateLetter(admin, userId, id, extra ?? "", cb);
    return;
  }

  if (action === "save" && id) {
    await approveCaptureProposal(admin, userId, id, cb);
    return;
  }
  if (action === "drop" && id) {
    await rejectCaptureProposal(admin, userId, id, cb);
    return;
  }
  if (action === "approve" && id) {
    await approveProposal(admin, userId, id, cb);
    return;
  }
  if (action === "reject" && id) {
    await rejectProposal(admin, userId, id, cb);
    return;
  }
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

// Confirm before saving (owner asked to approve added notes/tasks). The pending
// text is parked as a proposal so the Yes/No callback can act on it later.
async function promptSave(
  admin: SupabaseClient,
  userId: string,
  text: string,
  summary: string
): Promise<void> {
  const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  const { data: p, error } = await admin
    .from("proposals")
    .insert({
      user_id: userId,
      kind: "capture",
      status: "pending",
      title: (summary || preview).slice(0, 120),
      payload: { text },
      source: "telegram",
    })
    .select("id")
    .single();

  if (error || !p) {
    // Proposal store unavailable — fall back to saving directly.
    const { summary: s } = await captureAndSummarize(userId, text);
    await sendMessage(s, { parse_mode: "plain" });
    return;
  }

  await sendMessage(`${summary ? `📝 ${summary}?` : "📝 Save this?"}\n\n“${preview}”`, {
    parse_mode: "plain",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Save", callback_data: `save:${p.id}` },
          { text: "✖ Discard", callback_data: `drop:${p.id}` },
        ],
      ],
    },
  });
}

async function approveCaptureProposal(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  cb: TgCallback
): Promise<void> {
  const { data: p } = await admin
    .from("proposals")
    .select("id, status, payload")
    .eq("id", proposalId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!p || p.status !== "pending") {
    await answerCallbackQuery(cb.id, "Already handled");
    return;
  }
  const text = ((p.payload as { text?: string } | null)?.text ?? "").toString();
  const { outcome, summary } = await captureAndSummarize(userId, text);
  await admin
    .from("proposals")
    .update({
      status: "approved",
      decided_at: new Date().toISOString(),
      result: { item_ids: outcome.created.map((c) => c.item.id) },
    })
    .eq("id", proposalId);
  await answerCallbackQuery(cb.id, "Saved");
  if (cb.message) {
    await editMessageText(cb.message.chat.id, cb.message.message_id, summary);
  }
}

async function rejectCaptureProposal(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  cb: TgCallback
): Promise<void> {
  await admin
    .from("proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("user_id", userId)
    .eq("status", "pending");
  await answerCallbackQuery(cb.id, "Discarded");
  if (cb.message) {
    await editMessageText(cb.message.chat.id, cb.message.message_id, "🗑 Discarded — not saved.");
  }
}

// ---- proposals: approve/reject an outward action (T3/T4) --------------------

// Approve → run the action (create the ClickUp task) via the shared lib, then
// reflect the outcome in Telegram.
async function approveProposal(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  cb: TgCallback
): Promise<void> {
  const r = await applyProposal(admin, userId, proposalId);
  await answerCallbackQuery(
    cb.id,
    r.alreadyHandled ? r.message : r.ok ? "Created in ClickUp ✓" : "ClickUp failed"
  );
  if (r.ok && cb.message) {
    await editMessageText(
      cb.message.chat.id,
      cb.message.message_id,
      `✅ ${r.message}\n${r.url ?? ""}`.trim()
    );
  } else if (!r.ok && !r.alreadyHandled) {
    await sendMessage(`⚠️ Couldn't create the ClickUp task: ${r.message}`, { parse_mode: "plain" });
  }
}

async function rejectProposal(
  admin: SupabaseClient,
  userId: string,
  proposalId: string,
  cb: TgCallback
): Promise<void> {
  await rejectProposalById(admin, userId, proposalId);
  await answerCallbackQuery(cb.id, "Rejected");
  if (cb.message) {
    await editMessageText(cb.message.chat.id, cb.message.message_id, "✖ Rejected — not added to ClickUp.");
  }
}

// Run the capture pipeline and format a clean confirmation line per created item.
async function captureAndSummarize(
  userId: string,
  text: string
): Promise<{ outcome: Awaited<ReturnType<typeof captureText>>; summary: string }> {
  const outcome = await captureText(userId, text, "telegram");
  const summary =
    outcome.created
      .map((c) => {
        const due = c.due_at ? ` (due ${c.due_at.slice(0, 10)})` : "";
        // v4.0.1 item 5 — name the junk verdict instead of a bare "Saved".
        // Junk is never auto-archived any more (owner directive), so nothing is
        // hidden; but a capture the pass scored as junk will show up in the
        // evening deck wearing a badge, and finding that out then is a small
        // unpleasant surprise. Saying it here costs one clause.
        const junk =
          typeof c.junk_score === "number" && c.junk_score >= JUNK_FLAG_SCORE
            ? " · flagged as likely junk — kept, review it in tonight's deck"
            : "";
        const rev = c.needs_review && !junk ? " · needs review" : "";
        return `🧠 Saved ${c.item.type}: ${c.item.title}${due}${junk}${rev}`;
      })
      .join("\n") || "🧠 Saved.";
  return { outcome, summary };
}

// ---- v4.2 letter buttons ------------------------------------------------------

// Show the reply draft for a piece of overnight mail. Pre-generated at letter
// time where possible; generated on demand otherwise, so the button always
// works even when the morning budget ran out. Never sends — the draft comes
// back as text to copy (propose-approve law).
async function showMailDraft(
  admin: SupabaseClient,
  userId: string,
  inflowId: string,
  cb: TgCallback
): Promise<void> {
  const { data: row } = await admin
    .from("inflow_events")
    .select("id,subject,sender,snippet,ranked_score,ranked_reason,item_id,account")
    .eq("id", inflowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) {
    await answerCallbackQuery(cb.id, "That message is gone");
    return;
  }

  const existing = await loadDrafts(admin, userId, [inflowId]);
  let draft = existing.get(inflowId)?.draft ?? null;

  if (!draft) {
    await answerCallbackQuery(cb.id, "Drafting…");
    draft = await generateDraft(admin, userId, row as LetterInflowRow);
  } else {
    await answerCallbackQuery(cb.id, "Draft ready");
  }

  if (!draft) {
    await sendMessage("Couldn't draft that one — open the thread instead.", { parse_mode: "plain" });
    return;
  }

  await sendMessage(
    `📝 Draft reply to ${senderName(row.sender as string | null)}\n` +
      `Re: ${row.subject ?? "(no subject)"}\n\n` +
      `${stripMarkdown(draft)}\n\n` +
      `(nothing sent — copy and edit as you like)`,
    { parse_mode: "plain" }
  );
}

// "✓ Handled" on a letter line: the owner has dealt with it, so it must not
// come back tomorrow.
async function markInflowHandled(
  admin: SupabaseClient,
  userId: string,
  inflowId: string,
  cb: TgCallback
): Promise<void> {
  const { data } = await admin
    .from("inflow_events")
    .update({ state: "actioned" })
    .eq("id", inflowId)
    .eq("user_id", userId)
    .select("subject")
    .maybeSingle();
  await answerCallbackQuery(cb.id, data ? "✓ Handled" : "Already handled");
  if (data) {
    await logAudit(admin, {
      user_id: userId,
      action: "letter_item_handled",
      actor: "user",
      detail: { inflow_id: inflowId },
    });
  }
}

// 👍/👎 on the letter — the only non-guesswork signal behind KPI #1 (brief
// accuracy, target >= 9 of 10 mornings). Keyed on the owner's LOCAL date so one
// rating per letter, and re-rating overwrites rather than double-counting.
async function rateLetter(
  admin: SupabaseClient,
  userId: string,
  direction: string,
  localDate: string,
  cb: TgCallback
): Promise<void> {
  const up = direction === "up";
  await admin
    .from("audit")
    .delete()
    .eq("user_id", userId)
    .eq("action", "letter_rated")
    .eq("detail->>localDate", localDate);
  await logAudit(admin, {
    user_id: userId,
    action: "letter_rated",
    actor: "user",
    detail: { localDate, rating: up ? "up" : "down" },
  });
  await answerCallbackQuery(cb.id, up ? "Noted — thanks" : "Noted — what was off?");
  if (!up) {
    await sendMessage(
      "What did I get wrong? Reply and I'll save it as a note for tuning.",
      { parse_mode: "plain" }
    );
  }
}

async function runAsk(userId: string, question: string): Promise<void> {
  const { answer, sources } = await answerQuestion(userId, question);
  let reply = stripMarkdown(answer);
  if (sources.length) {
    reply += `\n\n📎 Sources:\n${sources.slice(0, 5).map((s) => `[${s.n}] ${s.title}`).join("\n")}`;
  }
  await sendMessage(reply, { parse_mode: "plain" });
}

// Telegram messages are sent as plain text (dynamic/LLM content can't be trusted
// to be valid Markdown), so strip the markdown the model emits for a clean look.
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/__(.+?)__/g, "$1") // __bold__
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/^#{1,6}\s+/gm, "") // # headers
    .replace(/^[ \t]*[-*+]\s+/gm, "• ") // bullets -> •
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// We look for a candidate that clearly STANDS OUT: a strong absolute score AND a
// margin over the pack — not a fixed low threshold (which, with the old high-floor
// gte-small embeddings, matched everything).
// MEASURED 2026-07-28 for text-embedding-3-large @1024d (scripts/measure-similarity.mjs
// over the retrieval set, N=29): STRONG = NN p50 = 0.478; MARGIN = 0.15 * (1 -
// all-pairs mean 0.232) = 0.115.
const COMPLETE_STRONG = 0.478;
const COMPLETE_MARGIN = 0.115;

// Complete a specific item the owner reported as done. Resolves their phrasing to
// open items semantically. Clear winner -> do it (with Undo); a close cluster ->
// let them pick; nothing convincing -> offer recent open items to tap.
async function handleComplete(admin: SupabaseClient, userId: string, target: string): Promise<void> {
  const matches = await resolveMatches(admin, userId, target, "open");
  const top = matches[0]?.similarity ?? 0;

  if (matches.length && top >= COMPLETE_STRONG) {
    const cluster = matches.filter((m) => m.similarity >= top - COMPLETE_MARGIN);
    if (cluster.length === 1) {
      const title = await markDoneById(admin, userId, cluster[0].id);
      await sendMessage(title ? `✓ Done: ${title}` : "Couldn't mark that done.", {
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

// Put a completed item back to open. Same standout-match logic as complete.
async function handleReopen(admin: SupabaseClient, userId: string, target: string): Promise<void> {
  const matches = await resolveMatches(admin, userId, target, "done");
  const top = matches[0]?.similarity ?? 0;

  if (matches.length && top >= COMPLETE_STRONG) {
    const cluster = matches.filter((m) => m.similarity >= top - COMPLETE_MARGIN);
    if (cluster.length === 1) {
      const title = await reopenById(admin, userId, cluster[0].id);
      await sendMessage(title ? `↩ Reopened: ${title}` : "Couldn't reopen that.", {
        parse_mode: "plain",
      });
      return;
    }
    await sendMessage("Which one should I reopen?", {
      parse_mode: "plain",
      reply_markup: {
        inline_keyboard: cluster.slice(0, 5).map((m) => [
          { text: `↩ ${m.title.slice(0, 40)}`, callback_data: `reopen:${m.id}` },
        ]),
      },
    });
    return;
  }

  const { data: recent } = await admin
    .from("items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", "done")
    .is("valid_to", null)
    .order("created_at", { ascending: false })
    .limit(6);
  const done = recent ?? [];
  if (done.length === 0) {
    await sendMessage("You have no completed items to reopen.", { parse_mode: "plain" });
    return;
  }
  await sendMessage(`I wasn't sure which you meant by “${target}”. Tap the one to reopen:`, {
    parse_mode: "plain",
    reply_markup: {
      inline_keyboard: done.map((m) => [
        { text: `↩ ${m.title.slice(0, 40)}`, callback_data: `reopen:${m.id}` },
      ]),
    },
  });
}

// ---- data helpers -----------------------------------------------------------

type Match = { id: string; title: string; similarity: number };

// Semantic search for the owner's items in a given status ('open' | 'done')
// matching a natural-language target, sorted by similarity (desc). Thresholding
// is the caller's job.
async function resolveMatches(
  admin: SupabaseClient,
  userId: string,
  target: string,
  status: "open" | "done"
): Promise<Match[]> {
  const q = target.trim();
  if (!q) return [];
  const embedding = await embedText(q);
  const { data: neigh } = await admin.rpc("match_neighbors_v2", {
    query_embedding: embedding,
    owner: userId,
    exclude_id: null,
    match_count: 10,
  });
  const cands = (neigh ?? []) as { id: string; similarity: number }[];
  if (cands.length === 0) return [];
  const ids = cands.map((n) => n.id);
  const { data: rows } = await admin
    .from("items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", status)
    .is("valid_to", null)
    .in("id", ids);
  const byId = new Map((rows ?? []).map((r) => [r.id, r.title as string]));
  return cands
    .filter((n) => byId.has(n.id))
    .map((n) => ({ id: n.id, title: byId.get(n.id)!, similarity: n.similarity }))
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
  await reprojectItemToVault(admin, item.id); // keep the vault in sync
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
  await reprojectItemToVault(admin, item.id); // keep the vault in sync
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
    .neq("source", "apple-notes") // never sweep up imported historical archive
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
    .neq("source", "apple-notes") // never sweep up imported historical archive
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
    await reprojectItemToVault(admin, it.id); // keep the vault in sync
  }
  return rows.length;
}
