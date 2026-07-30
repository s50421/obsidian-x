import type { SupabaseClient } from "@supabase/supabase-js";
import { draftForTask } from "@/lib/draft";
import { logAudit } from "@/lib/audit";
import { senderName, wantsReply, type InflowRow } from "@/lib/letter";

// Obsidian-X v4.2 — reply drafts attached to the letter.
//
// The vision's scene is "approve and execute", not "compose from scratch at
// 6:30am". So for mail that actually wants a reply, the draft is waiting before
// the owner asks. It is ALWAYS a proposal and NEVER sent — the propose-approve
// law has no exception for something this convenient.
//
// Cost/latency discipline: the letter cron has a hard time budget, and a draft
// nobody reads is wasted spend. Only the top few needs-reply items are
// pre-generated; the rest generate on demand when the button is tapped, which
// costs one extra beat but only for mail the owner actually cares about.

export const DRAFT_KIND = "draft";
/** Pre-generate at most this many, newest/highest-ranked first. */
export const MAX_PREGENERATED_DRAFTS = 3;

export type DraftProposalPayload = {
  inflowId: string;
  subject: string | null;
  sender: string | null;
  draft: string;
  generatedAt: string;
};

/** The prompt handed to the drafting model for one message. */
export function draftTaskFor(r: InflowRow): string {
  const who = senderName(r.sender);
  const subject = (r.subject ?? "(no subject)").trim();
  const snippet = (r.snippet ?? "").trim();
  return (
    `Write a reply to this email. Keep it brief and direct, in the owner's voice. ` +
    `Do not invent facts — if something is unknown, leave a [bracketed placeholder].\n\n` +
    `From: ${who}\nSubject: ${subject}\n\n${snippet}`
  );
}

/** Any existing draft proposals for these inflow ids, by inflow id. */
export async function loadDrafts(
  admin: SupabaseClient,
  userId: string,
  inflowIds: string[]
): Promise<Map<string, { proposalId: string; draft: string }>> {
  const out = new Map<string, { proposalId: string; draft: string }>();
  const ids = [...new Set(inflowIds)].filter(Boolean);
  if (!ids.length) return out;
  const { data } = await admin
    .from("proposals")
    .select("id,payload,status")
    .eq("user_id", userId)
    .eq("kind", DRAFT_KIND)
    .in("status", ["pending", "approved"])
    .order("created_at", { ascending: false })
    .limit(100);
  for (const p of data ?? []) {
    const payload = (p.payload ?? {}) as DraftProposalPayload;
    if (!payload.inflowId || !ids.includes(payload.inflowId)) continue;
    if (out.has(payload.inflowId)) continue; // newest wins
    out.set(payload.inflowId, { proposalId: p.id as string, draft: payload.draft ?? "" });
  }
  return out;
}

/**
 * Generate and store one draft. Returns the text, or null if drafting failed —
 * a failed draft must never break the letter, it just means the button
 * generates on demand instead.
 */
export async function generateDraft(
  admin: SupabaseClient,
  userId: string,
  r: InflowRow
): Promise<string | null> {
  try {
    const { draft } = await draftForTask(userId, draftTaskFor(r));
    if (!draft || !draft.trim()) return null;
    const payload: DraftProposalPayload = {
      inflowId: r.id,
      subject: r.subject,
      sender: r.sender,
      draft: draft.trim(),
      generatedAt: new Date().toISOString(),
    };
    const { data } = await admin
      .from("proposals")
      .insert({
        user_id: userId,
        kind: DRAFT_KIND,
        status: "pending",
        title: `Reply to ${senderName(r.sender)} — ${r.subject ?? "(no subject)"}`.slice(0, 200),
        payload,
        source: "brief",
        source_item_id: r.item_id,
      })
      .select("id")
      .maybeSingle();
    await logAudit(admin, {
      user_id: userId,
      item_id: r.item_id,
      action: "draft_generated",
      actor: "system",
      detail: { inflow_id: r.id, proposal_id: data?.id ?? null },
    });
    return payload.draft;
  } catch {
    return null;
  }
}

/**
 * Pre-generate drafts for the needs-reply subset, bounded by count AND by a
 * wall-clock budget so a slow model can't push the letter past the cron's
 * timeout. Whatever is ready by the deadline gets attached; the rest fall back
 * to on-demand.
 */
export async function pregenerateDrafts(
  admin: SupabaseClient,
  userId: string,
  candidates: InflowRow[],
  opts: { max?: number; budgetMs?: number } = {}
): Promise<Set<string>> {
  const max = opts.max ?? MAX_PREGENERATED_DRAFTS;
  const budgetMs = opts.budgetMs ?? 25_000;
  const deadline = Date.now() + budgetMs;

  const existing = await loadDrafts(admin, userId, candidates.map((c) => c.id));
  const done = new Set<string>(existing.keys());

  for (const r of candidates.filter(wantsReply)) {
    if (done.size >= max) break;
    if (done.has(r.id)) continue;
    if (Date.now() > deadline) break;
    const draft = await generateDraft(admin, userId, r);
    if (draft) done.add(r.id);
  }
  return done;
}
