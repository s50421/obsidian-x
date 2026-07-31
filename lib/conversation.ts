import type { SupabaseClient } from "@supabase/supabase-js";

// Obsidian-X v4.2.1 — short-term conversational memory for the Telegram bot.
//
// The bot used to treat every message as an isolated event, which broke the
// most ordinary thing a person does: a follow-up.
//
//   owner: "Canvas to-dos: - instage phone call - resume"
//   bot:   "Save this?"  [Save] [Discard]
//   owner: "Save them as two separate things"
//   bot:   "I need more context to understand what you'd like me to save."
//
// "them" was one message earlier.
//
// Scope is deliberately narrow. This is DIALOGUE, not memory: it never enters
// the brain, it's pruned aggressively, and it exists only so the next message
// can be understood in light of the last few. Anything worth remembering still
// has to be captured explicitly.

export type Role = "user" | "assistant";

export type Turn = {
  role: Role;
  text: string;
  meta: Record<string, unknown>;
  created_at: string;
};

/** How many turns to feed the intent model. */
export const CONTEXT_TURNS = 10;
/**
 * How long a turn stays relevant. A follow-up arrives within a few minutes; a
 * message hours later is a new topic, and treating it as a continuation would
 * be worse than having no memory at all — the bot would confidently attach it
 * to something the owner has long forgotten.
 */
export const CONTEXT_WINDOW_MIN = 45;
/** Rows kept before pruning. Generous — they're tiny. */
const KEEP_ROWS = 200;

export async function recordTurn(
  admin: SupabaseClient,
  userId: string,
  role: Role,
  text: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  try {
    await admin.from("conversation").insert({
      user_id: userId,
      role,
      // Long replies (a full Ask answer) are truncated: the point is enough to
      // resolve a pronoun, not a transcript.
      text: trimmed.slice(0, 4000),
      meta,
    });
  } catch {
    // Memory is an enhancement — never let it break the reply.
  }
}

/** Recent turns, oldest first, within the relevance window. */
export async function loadRecentTurns(
  admin: SupabaseClient,
  userId: string,
  limit = CONTEXT_TURNS
): Promise<Turn[]> {
  try {
    const since = new Date(Date.now() - CONTEXT_WINDOW_MIN * 60_000).toISOString();
    const { data } = await admin
      .from("conversation")
      .select("role,text,meta,created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);
    return ((data ?? []) as Turn[]).reverse();
  } catch {
    return [];
  }
}

/** Render turns for the intent prompt. Empty string when there's no history. */
export function renderContext(turns: Turn[]): string {
  if (!turns.length) return "";
  return turns
    .map((t) => `${t.role === "user" ? "OWNER" : "YOU"}: ${t.text.slice(0, 500)}`)
    .join("\n");
}

/**
 * The most recent thing the bot offered to save and the owner hasn't decided
 * on. This is what a follow-up like "save them separately" refers to.
 */
export async function lastPendingCapture(
  admin: SupabaseClient,
  userId: string
): Promise<{ id: string; text: string } | null> {
  try {
    const since = new Date(Date.now() - CONTEXT_WINDOW_MIN * 60_000).toISOString();
    const { data } = await admin
      .from("proposals")
      .select("id,payload,created_at")
      .eq("user_id", userId)
      .eq("kind", "capture")
      .eq("status", "pending")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const text = ((data.payload ?? {}) as { text?: string }).text ?? "";
    if (!text.trim()) return null;
    return { id: data.id as string, text };
  } catch {
    return null;
  }
}

/** Trim history so it can't grow unbounded. Best-effort. */
export async function pruneConversation(admin: SupabaseClient, userId: string): Promise<void> {
  try {
    const { data } = await admin
      .from("conversation")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(KEEP_ROWS, KEEP_ROWS)
      .maybeSingle();
    if (!data) return;
    await admin.from("conversation").delete().eq("user_id", userId).lt("id", data.id as number);
  } catch {
    // best-effort
  }
}
