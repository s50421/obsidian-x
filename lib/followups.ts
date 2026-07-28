import { createAdminClient } from "@/lib/supabase/admin";
import { chat, extractJson, type Usage } from "@/lib/openrouter";

// v3.2 rung 1 — "you said you'd…" detection. Scans the owner's recent OPEN notes
// for genuine, still-unfulfilled commitments so the daily cron can nudge them.

type Admin = ReturnType<typeof createAdminClient>;

export type Followup = { itemId: string; itemTitle: string; commitment: string; action: string };

type RawFollowup = { index?: unknown; commitment?: unknown; action?: unknown };

export async function detectFollowups(
  admin: Admin,
  userId: string,
  sinceDays = 21,
  limit = 40
): Promise<{ followups: Followup[]; usage: Usage | null }> {
  // Items already surfaced once — don't re-nag.
  const { data: surfacedRows } = await admin
    .from("audit")
    .select("item_id")
    .eq("user_id", userId)
    .eq("action", "followup_surfaced");
  const surfaced = new Set((surfacedRows ?? []).map((r) => r.item_id).filter(Boolean) as string[]);

  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const { data: rows } = await admin
    .from("items")
    .select("id,title,body,type,created_at")
    .eq("user_id", userId)
    .eq("status", "open")
    .is("valid_to", null)
    .neq("source", "apple-notes")
    .neq("source", "system") // exclude our own digests/consolidations (they echo captures)
    .in("type", ["note", "task", "idea", "event", "person"]) // not shopping/reference
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(120);

  const candidates = (rows ?? []).filter((r) => !surfaced.has(r.id)).slice(0, limit);
  if (candidates.length === 0) return { followups: [], usage: null };

  const numbered = candidates
    .map((r, i) => `${i + 1}. [${r.type}] ${r.title}\n${(r.body ?? "").replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n\n");

  const system =
    `You are a proactive assistant reviewing the owner's recent notes for their personal ` +
    `second brain. Identify genuine, meaningful COMMITMENTS / FOLLOW-UPS the owner made that are ` +
    `probably NOT done yet — specifically ones with another person, a deliverable, or a deadline ` +
    `(e.g. "email Dani the contract", "follow up with the adjuster", "send the quote by Friday", ` +
    `"call the accountant"). Be strict: SKIP routine to-dos, shopping/errands, one-line reminders, ` +
    `vague musings, anything already done, reference notes, and system-generated digests. If in ` +
    `doubt, leave it out — a quiet day is better than a noisy nudge. Return ONLY JSON:\n` +
    `{ "followups": [ { "index": <the item number above>, "commitment": "<short, in the owner's ` +
    `voice>", "action": "<one concrete next step>" } ] }. Empty array if nothing qualifies.`;

  const { content, usage } = await chat(
    process.env.OPENROUTER_CLASSIFY_MODEL!,
    [
      { role: "system", content: system },
      { role: "user", content: numbered },
    ],
    { json: true, temperature: 0 }
  );

  let parsed: { followups?: unknown };
  try {
    parsed = extractJson<{ followups?: unknown }>(content);
  } catch {
    parsed = {};
  }
  const raw: RawFollowup[] = Array.isArray(parsed.followups) ? (parsed.followups as RawFollowup[]) : [];

  const followups: Followup[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const idx = Number(f?.index);
    if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) continue;
    const item = candidates[idx - 1];
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const commitment = String(f?.commitment ?? "").trim() || item.title;
    const action = String(f?.action ?? "").trim();
    followups.push({ itemId: item.id, itemTitle: item.title, commitment, action });
  }

  return { followups: followups.slice(0, 8), usage };
}
