import type { SupabaseClient } from "@supabase/supabase-js";
import { chat, extractJson, type Usage } from "@/lib/openrouter";
import { getSettingValue, setSettingValue } from "@/lib/tz";
import { parseAddresses, type GmailMessageMeta } from "@/lib/gmail";

// Obsidian-X v4.1 — importance ranking for inbound mail.
//
// The owner's never-miss rules (confirmed 2026-07-29):
//   1. explicit deadline or date in the message
//   2. a thread awaiting my reply / where I owe a reply
//   3. money, legal, or contract language
//   4. direct-to-me, never CC'd or bulk
//
// …plus the owner's own definition of VIP, which is TWO rules, not one list:
//   "VIP is any mail that contains an action item or requires a response that
//    is not an advertisement or sale. Canvas/class emails, Beate Manhart,
//    V-Bank and similar should always surface."
//
// So there are two independent routes to importance:
//   (a) CONTENT — an action item or a request for a response, in mail that
//       isn't marketing. This is the LLM pass plus the bulk/demote caps, and
//       it's what gates auto-create; a named sender is NOT required.
//   (b) SENDER — an explicitly named VIP always surfaces, and is deliberately
//       exempt from the bulk cap. Canvas notifications and bank alerts all
//       carry List-Unsubscribe; capping them would mean "always surface"
//       silently never happened.
// Surfacing and auto-creating stay separate decisions: a VIP's automated
// notification appears in the brief but never becomes a memory on its own.
//
// Two layers on purpose. Deterministic signals (headers, VIP list, bulk
// detection) run on EVERY message and cost nothing. The LLM pass is cheap but
// not free, so it only runs on messages the deterministic layer couldn't
// already dismiss — a newsletter never reaches the model.

export const VIP_KEY = "mail_vip";
export const DEMOTE_KEY = "mail_demote";
export const IDENTITY_KEY = "mail_identities";

/**
 * Every address that IS the owner.
 *
 * This has to be a set, not one string. A Google Workspace "Internal" OAuth app
 * can only be authorized by accounts inside that Workspace, so the personal
 * Gmail can't be granted directly — it forwards into the Workspace mailbox
 * instead. Forwarded mail keeps its ORIGINAL `To:`, so matching only against
 * the mailbox we authenticated as would read every forwarded message as
 * "not direct to me" and quietly sink it below the surface threshold.
 */
export async function loadIdentities(
  admin: SupabaseClient,
  userId: string,
  mailbox: string
): Promise<string[]> {
  const v = await getSettingValue<string[] | { addresses?: string[] }>(admin, userId, IDENTITY_KEY);
  const extra = Array.isArray(v) ? v : (v?.addresses ?? []);
  const all = [mailbox, process.env.OWNER_EMAIL ?? "", ...extra]
    .map((s) => (s ?? "").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(all)];
}

export const STREAMS_KEY = "mail_streams";

/**
 * Gmail label name → the logical inflow stream that label represents.
 *
 * Google refuses to let an unverified External app hold `gmail.readonly` (it's
 * a restricted scope), and a Workspace Internal app can't be granted to a
 * consumer account — so the personal mailbox reaches the brain by forwarding
 * into the Workspace one. A filter there tags the forwarded mail, and this map
 * turns that tag back into "this is the personal stream", which is what keeps
 * the two streams reporting separately in the coverage panel instead of
 * collapsing into one undifferentiated Gmail blob.
 */
export const DEFAULT_STREAM_LABEL = "via-personal";

export async function loadStreamMap(
  admin: SupabaseClient,
  userId: string
): Promise<Record<string, string>> {
  const v = await getSettingValue<Record<string, string>>(admin, userId, STREAMS_KEY);
  const out: Record<string, string> = {};
  for (const [label, addr] of Object.entries(v ?? {})) {
    if (label && typeof addr === "string" && addr) out[label.toLowerCase()] = addr.toLowerCase();
  }
  return out;
}

export async function saveStreamMap(
  admin: SupabaseClient,
  userId: string,
  map: Record<string, string>
): Promise<void> {
  await setSettingValue(admin, userId, STREAMS_KEY, map);
}

/**
 * Which stream did this message arrive on?
 *
 * Label first — it's explicit, set by the owner's own filter, and survives odd
 * header shapes (CC, BCC, mailing lists) that header-sniffing gets wrong.
 * Falls back to the mailbox we actually fetched from.
 */
export function resolveStream(
  labelIds: string[],
  labelNames: Map<string, string>,
  streamMap: Record<string, string>,
  mailbox: string
): string {
  for (const id of labelIds) {
    const name = (labelNames.get(id) ?? id).toLowerCase();
    const stream = streamMap[name];
    if (stream) return stream;
  }
  return mailbox.toLowerCase();
}

export async function saveIdentities(
  admin: SupabaseClient,
  userId: string,
  addresses: string[]
): Promise<void> {
  await setSettingValue(admin, userId, IDENTITY_KEY, {
    addresses: addresses.map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
}

export type VipRules = {
  /** Exact addresses, e.g. "jane@acme.com". */
  addresses: string[];
  /** Whole domains, e.g. "acme.com" — matches any sender at that domain. */
  domains: string[];
  /** Free-text name fragments matched against the From display name. */
  names: string[];
};

export type DemoteRules = {
  /** Senders that are never important even if they'd otherwise score. */
  addresses: string[];
  domains: string[];
  /** Subject substrings (case-insensitive) that force a low score. */
  subjects: string[];
};

export const EMPTY_VIP: VipRules = { addresses: [], domains: [], names: [] };
export const EMPTY_DEMOTE: DemoteRules = { addresses: [], domains: [], subjects: [] };

export async function loadVip(admin: SupabaseClient, userId: string): Promise<VipRules> {
  const v = await getSettingValue<Partial<VipRules>>(admin, userId, VIP_KEY);
  return {
    addresses: (v?.addresses ?? []).map((s) => s.toLowerCase()),
    domains: (v?.domains ?? []).map((s) => s.toLowerCase().replace(/^@/, "")),
    names: (v?.names ?? []).map((s) => s.toLowerCase()),
  };
}

export async function loadDemote(admin: SupabaseClient, userId: string): Promise<DemoteRules> {
  const v = await getSettingValue<Partial<DemoteRules>>(admin, userId, DEMOTE_KEY);
  return {
    addresses: (v?.addresses ?? []).map((s) => s.toLowerCase()),
    domains: (v?.domains ?? []).map((s) => s.toLowerCase().replace(/^@/, "")),
    subjects: (v?.subjects ?? []).map((s) => s.toLowerCase()),
  };
}

export async function saveVip(admin: SupabaseClient, userId: string, v: VipRules): Promise<void> {
  await setSettingValue(admin, userId, VIP_KEY, v);
}

export async function saveDemote(
  admin: SupabaseClient,
  userId: string,
  v: DemoteRules
): Promise<void> {
  await setSettingValue(admin, userId, DEMOTE_KEY, v);
}

// ---- deterministic signals ---------------------------------------------------

export type Signals = {
  vip: boolean;
  direct: boolean; // in To:, and the recipient list is small
  ccOnly: boolean;
  bulk: boolean; // List-Unsubscribe / List-Id / Precedence: bulk / no-reply
  automated: boolean; // Auto-Submitted (calendar invites, autoresponders)
  demoted: boolean;
  threadReply: boolean; // part of an existing conversation
  awaitingMyReply: boolean; // someone else spoke last in a thread I'm in
  promotionsLabel: boolean;
};

const NOREPLY = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer|bounce|postmaster)([._-]|@)/i;

function domainOf(email: string): string {
  const i = email.lastIndexOf("@");
  return i < 0 ? "" : email.slice(i + 1).toLowerCase();
}

export function isVipSender(from: { name: string; email: string } | null, vip: VipRules): boolean {
  if (!from) return false;
  const email = from.email.toLowerCase();
  if (vip.addresses.includes(email)) return true;
  if (vip.domains.includes(domainOf(email))) return true;
  const name = (from.name ?? "").toLowerCase();
  return !!name && vip.names.some((n) => n && name.includes(n));
}

export function deterministicSignals(
  msg: GmailMessageMeta,
  /** Every address that is the owner (see loadIdentities). A bare string is
   *  accepted so callers with a single mailbox stay simple. */
  identities: string | string[],
  vip: VipRules,
  demote: DemoteRules,
  threadOthersLast?: boolean
): Signals {
  const h = msg.headers;
  const me = new Set(
    (Array.isArray(identities) ? identities : [identities]).map((s) => s.toLowerCase())
  );
  const from = parseAddresses(h.from)[0] ?? null;
  const to = parseAddresses(h.to);
  const cc = parseAddresses(h.cc);

  // Forwarding target counts as delivery to me, but never as evidence that the
  // sender addressed me personally — that must come from To:/Cc:.
  const forwardedToMe = [
    ...parseAddresses(h["delivered-to"]),
    ...parseAddresses(h["x-forwarded-to"]),
  ].some((a) => me.has(a.email));

  const inTo = to.some((a) => me.has(a.email));
  const inCc = cc.some((a) => me.has(a.email));
  const recipients = to.length + cc.length;

  const bulk =
    !!h["list-unsubscribe"] ||
    !!h["list-id"] ||
    /bulk|list|junk/i.test(h.precedence ?? "") ||
    (!!from && NOREPLY.test(from.email));

  const subject = (h.subject ?? "").toLowerCase();
  const fromEmail = from?.email ?? "";
  const demoted =
    demote.addresses.includes(fromEmail) ||
    demote.domains.includes(domainOf(fromEmail)) ||
    demote.subjects.some((s) => s && subject.includes(s));

  return {
    vip: isVipSender(from, vip),
    // A forwarded message whose To:/Cc: we can't match is still plausibly for
    // me — treat a small recipient list as direct rather than penalising the
    // whole forwarded stream.
    direct: (inTo || (forwardedToMe && !inCc)) && recipients <= 5,
    ccOnly: inCc && !inTo,
    bulk,
    automated: !!h["auto-submitted"] && h["auto-submitted"] !== "no",
    demoted,
    threadReply: !!h["in-reply-to"] || !!h.references,
    awaitingMyReply: threadOthersLast === true,
    promotionsLabel:
      msg.labelIds.includes("CATEGORY_PROMOTIONS") || msg.labelIds.includes("CATEGORY_SOCIAL"),
  };
}

/**
 * Does this thread end with someone else's message? Cheap version: derive it
 * from the thread's messages without another fetch when the caller already has
 * them. `msgs` must be the whole thread, oldest first.
 */
export function othersSpokeLast(
  msgs: GmailMessageMeta[],
  identities: string | string[]
): boolean {
  if (!msgs.length) return false;
  const me = new Set(
    (Array.isArray(identities) ? identities : [identities]).map((s) => s.toLowerCase())
  );
  const last = msgs[msgs.length - 1];
  const from = parseAddresses(last.headers.from)[0];
  if (!from) return false;
  const iEverSpoke = msgs.some((m) => me.has(parseAddresses(m.headers.from)[0]?.email ?? ""));
  return iEverSpoke && !me.has(from.email);
}

// ---- LLM content pass --------------------------------------------------------

export type ContentRead = {
  /** 0..1 — how much this message demands the owner's attention. */
  importance: number;
  deadline: boolean; // never-miss rule 1
  question: boolean; // a direct question addressed to the owner
  money: boolean; // never-miss rule 3
  reason: string; // one short clause for the /ops tuning view
  confidence: number;
  usage: Usage | null;
};

const NEUTRAL_READ: ContentRead = {
  importance: 0.3,
  deadline: false,
  question: false,
  money: false,
  reason: "not assessed",
  confidence: 0,
  usage: null,
};

/**
 * One cheap classify pass over subject + snippet ONLY. Bodies are not sent —
 * that keeps cost down and keeps the "mail is inflow, not memory" line honest.
 */
export async function readMailContent(
  msg: GmailMessageMeta,
  todayISO: string
): Promise<ContentRead> {
  const model = process.env.OPENROUTER_CLASSIFY_MODEL!;
  const h = msg.headers;
  const system =
    `You triage one inbound email for a busy executive's assistant. Today is ${todayISO}. ` +
    `You see ONLY the headers and a short snippet — judge from that, do not speculate ` +
    `about unseen content.\n` +
    `Return ONLY a JSON object:\n` +
    `{\n` +
    `  "importance": 0..1 — how much this demands the owner's personal attention today,\n` +
    `  "deadline": true if it states a date, deadline, expiry, or RSVP the owner must meet,\n` +
    `  "question": true if it asks the owner a direct question or requests an action from them,\n` +
    `  "money": true if it concerns invoices, payments, contracts, legal matters, tax, or banking,\n` +
    `  "reason": one short clause (max 12 words) explaining the score,\n` +
    `  "confidence": 0..1 in your own read\n` +
    `}\n` +
    `Calibration: marketing, newsletters, receipts for routine purchases, social ` +
    `notifications and automated digests are LOW (< 0.3) even when they shout urgency. ` +
    `A named human asking the owner for something, or a real deadline, is HIGH (> 0.7). ` +
    `Manufactured urgency ("ACT NOW", "FINAL HOURS") is a marketing signal, not an ` +
    `importance signal. When the snippet is too thin to judge, say so and return a LOW ` +
    `confidence — a half-read is worse than no read.`;

  const user =
    `From: ${h.from ?? "(unknown)"}\n` +
    `To: ${h.to ?? ""}\n` +
    `Cc: ${h.cc ?? ""}\n` +
    `Date: ${h.date ?? ""}\n` +
    `Subject: ${h.subject ?? "(none)"}\n\n` +
    `Snippet: ${msg.snippet || "(empty)"}`;

  try {
    const { content, usage } = await chat(
      model,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { json: true, temperature: 0 }
    );
    const p = extractJson<Record<string, unknown>>(content);
    return {
      importance: clamp01(Number(p.importance)),
      deadline: p.deadline === true,
      question: p.question === true,
      money: p.money === true,
      reason: typeof p.reason === "string" ? p.reason.slice(0, 120) : "",
      confidence: clamp01(Number(p.confidence)),
      usage,
    };
  } catch {
    // A model failure must not silently drop the message to zero — it stays
    // mid-scored with confidence 0, which routes it to /ops for tuning rather
    // than into the brief (no-half-baked law).
    return { ...NEUTRAL_READ, reason: "classify failed" };
  }
}

// ---- scoring -----------------------------------------------------------------

export type Ranked = {
  score: number; // 0..100
  signals: string[]; // human-readable, shown in /ops
  vip: boolean;
  bulk: boolean;
  confidence: number;
  reason: string;
  autoCreate: boolean;
  usage: Usage | null;
};

/** Above this, mail is worth showing the owner in the brief. */
export const SURFACE_THRESHOLD = 55;
/** Below this, ranking confidence is too low to surface — goes to /ops instead. */
export const MIN_CONFIDENCE = 0.5;

/**
 * The auto-create bar, deliberately strict (owner decision 2026-07-29):
 * VIP sender AND direct-to-me AND a real deadline-or-question signal, with the
 * model confident. Auto-created items are routed into the evening swipe deck,
 * so a mis-fire costs one swipe rather than polluting the brain — that is what
 * keeps "auto-create" compatible with propose-then-approve.
 */
export function meetsAutoCreateBar(s: Signals, c: ContentRead): boolean {
  // Automated, bulk, promotional or explicitly demoted mail never becomes an
  // item — not even from a VIP. A VIP's Canvas notification should SURFACE in
  // the brief (see the floor in scoreMail), but surfacing and becoming a
  // memory are different decisions, and the second one is irreversible-ish.
  if (s.bulk || s.demoted || s.automated || s.promotionsLabel) return false;
  if (!s.direct) return false;
  // Owner's definition (2026-07-29): "VIP is any mail that contains an action
  // item or requires a response that is not an advertisement or sale." So the
  // gate is the ACTION, not the sender — a named VIP is no longer required.
  if (!(c.deadline || c.question || c.money)) return false;
  return c.importance >= 0.7 && c.confidence >= 0.7;
}

export function scoreMail(s: Signals, c: ContentRead): Ranked {
  const signals: string[] = [];
  let score = 0;

  // Bulk/promotional mail is capped hard. The brief's exit test is explicit:
  // a newsletter must never rank above a direct question from a VIP.
  if (s.bulk) signals.push("bulk");
  if (s.promotionsLabel) signals.push("promotions");
  if (s.automated) signals.push("automated");
  if (s.demoted) signals.push("demoted");

  if (s.vip) {
    score += 35;
    signals.push("VIP sender");
  }
  if (s.direct) {
    score += 15;
    signals.push("direct to me");
  } else if (s.ccOnly) {
    score -= 5;
    signals.push("cc only");
  }
  if (s.awaitingMyReply) {
    score += 20;
    signals.push("awaiting my reply");
  } else if (s.threadReply) {
    score += 5;
    signals.push("thread reply");
  }
  if (c.deadline) {
    score += 20;
    signals.push("deadline");
  }
  if (c.question) {
    score += 15;
    signals.push("direct question");
  }
  if (c.money) {
    score += 15;
    signals.push("money/legal");
  }
  score += Math.round(c.importance * 25);

  // Caps, applied last so no combination of positives can lift a newsletter
  // above a real message.
  //
  // An explicit demotion always wins — the owner said "never", and that beats
  // every other signal including VIP.
  if (s.demoted) {
    score = Math.min(score, 10);
  } else {
    // Bulk/automated caps apply only to senders the owner has NOT named. Naming
    // a sender VIP is a deliberate statement that their mail matters even when
    // it's machine-generated: Canvas/class notifications and bank alerts all
    // carry List-Unsubscribe, and capping them would mean the owner's explicit
    // "always surface these" silently never happened.
    if (!s.vip) {
      if (s.bulk || s.promotionsLabel) score = Math.min(score, 25);
      if (s.automated) score = Math.min(score, 35);
    }
    // "Should always surface" taken literally: a named VIP that hasn't been
    // demoted is guaranteed to clear the threshold, whatever the model thought.
    if (s.vip) score = Math.max(score, SURFACE_THRESHOLD);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    signals,
    vip: s.vip,
    bulk: s.bulk || s.promotionsLabel,
    confidence: c.confidence,
    reason: c.reason,
    autoCreate: meetsAutoCreateBar(s, c),
    usage: c.usage,
  };
}

/**
 * Cheap pre-filter: can we dismiss this message without paying for the model?
 * Bulk, promotional, automated and demoted mail can never clear the surface
 * threshold given the caps above, so there is nothing to learn by classifying it.
 */
export function canSkipContentPass(s: Signals): boolean {
  // Never skip a named VIP, even a bulk one. Their mail is guaranteed to
  // surface, so the brief needs a real reason line for it — "bulk/automated,
  // not classified" would be a useless thing to read at 6:30am. A demotion
  // still short-circuits, since that mail is capped at 10 and never shown.
  if (s.vip && !s.demoted) return false;
  return s.bulk || s.promotionsLabel || s.automated || s.demoted;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
