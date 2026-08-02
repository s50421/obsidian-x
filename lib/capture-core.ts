import { createAdminClient } from "@/lib/supabase/admin";
import { enrich, type EnrichedItem } from "@/lib/enrich";
import { embedText } from "@/lib/embed";
import { writeVaultNote, vaultUrl } from "@/lib/vault";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";
import { detectSensitive } from "@/lib/sensitivity";
import { redactCodes } from "@/lib/redact";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { cleanTitle, CONFIDENCE_BAR, scoreJunk } from "@/lib/title-standard.mjs";

// Similarity thresholds (cosine, 0..1) against `items.embedding_v2`
// (text-embedding-3-large @ 1024 dims via match_neighbors_v2).
//
// The old values (LINK 0.80 / DUP 0.93) were tuned for gte-small, whose
// similarity FLOOR was ~0.76 — distinct items scored 0.83–0.89, so every
// threshold had to be crammed into the top ~0.2 of the range. text-embedding-3
// has a far lower floor and spreads scores across most of 0..1, so the old
// numbers would now essentially never fire.
//
// MEASURED 2026-07-28 on the live corpus (scripts/measure-similarity.mjs over the
// retrieval set — not archived, valid_to null, N=29, the population that
// match_neighbors_v2 actually searches). Unrelated floor (all-pairs mean) 0.232;
// NN p75 -> LINK candidate 0.662; NN p99 -> DUP candidate 0.804 (top real pair was
// 0.754, so 0/29 false dup-flags on the current live set). DUP stays deliberately
// conservative — a false duplicate flag is the exact failure v4.0 W1 exists to
// remove. Re-run and re-tune after the corpus reprocess promotes archived notes
// into the live retrieval set.
const LINK_THRESHOLD = 0.662; // clearly related -> auto-link (NN p75)
const DUP_THRESHOLD = 0.804; // near-identical -> flag as a merge candidate (NN p99)
// LLM confidence, not similarity — value unchanged (0.55), now shared with the
// enrich/re-process paths via lib/title-standard.mjs so the no-half-baked bar is
// one number across the whole system.
const LOW_CONFIDENCE = CONFIDENCE_BAR;

// A split capture cross-links its parts. Cap the array so a 12-topic braindump
// cannot write a pathological links[] row.
const MAX_LINKS = 12;

type Neighbor = {
  id: string;
  title: string;
  type: string;
  vault_path: string | null;
  similarity: number;
};

export type CreatedItem = {
  item: {
    id: string;
    type: string;
    title: string;
    tags: string[] | null;
    priority: string;
  };
  due_at: string | null;
  needs_review: boolean;
  review_reason: string | null;
  /** 0..10 junk pass. Surfaced, never acted on — the caller decides whether to
   *  mention it (the Telegram bot names it so a flagged capture isn't a
   *  surprise in the evening deck). */
  junk_score: number | null;
  entities: { name: string; kind: string }[];
  links: { id: string; title: string }[];
  vault_path: string | null;
  vault_url: string | null;
  vaultError: string | null;
};

export type CaptureOutcome = {
  created: CreatedItem[];
  confidence: number;
  split: boolean;
};

type Admin = ReturnType<typeof createAdminClient>;

type StoreOpts = {
  source: string;
  rawText: string;
  sensitive: boolean;
  confidence: number;
  split: boolean;
  // Override the text used for the embedding (defaults to title + body). Document
  // ingest embeds on a concise summary rather than a long, truncated body.
  embedText?: string;
  // v4.0 W2 — sibling parts of the SAME split capture. They are excluded from
  // the duplicate check (a braindump's own topics must never duplicate-flag each
  // other) and force-linked afterwards. Does not touch the W1 thresholds.
  siblingIds?: string[];
};

// Store a single enriched item: embed -> neighbor search (auto-link + duplicate
// flag) -> insert -> vault projection -> audit. Shared by typed capture and the
// document-upload ingest so they behave identically.
export async function storeEnrichedItem(
  admin: Admin,
  userId: string,
  it: EnrichedItem,
  opts: StoreOpts
): Promise<CreatedItem> {
  const { source, rawText, sensitive, confidence, split } = opts;

  const embedding = await embedText(opts.embedText ?? `${it.title}\n\n${it.body}`, userId);

  const { data: neigh } = await admin.rpc("match_neighbors_v2", {
    query_embedding: embedding,
    owner: userId,
    exclude_id: null,
    match_count: 6,
  });
  const siblingIds = new Set(opts.siblingIds ?? []);
  const neighbors = ((neigh ?? []) as Neighbor[]).filter((n) => !siblingIds.has(n.id));
  const dup = neighbors.find((n) => n.similarity >= DUP_THRESHOLD) ?? null;
  const links = neighbors
    .filter((n) => n.similarity >= LINK_THRESHOLD && (!dup || n.id !== dup.id))
    .slice(0, 5);

  // Per-item verdict from enrich (title quality / this part's own confidence)
  // takes precedence over the capture-wide number; fall back to the old
  // behaviour when the item carries none.
  const itemConfidence = typeof it.confidence === "number" ? it.confidence : confidence;
  const lowConfidence = itemConfidence < LOW_CONFIDENCE;
  const needsReview = lowConfidence || !!dup || it.needs_review === true;
  const reviewReason = dup
    ? `possible duplicate of "${dup.title}"`
    : (it.review_reason ??
      (lowConfidence ? "low confidence — please confirm" : null));

  const createdAt = new Date().toISOString();
  const dueAt = it.due_date ? new Date(`${it.due_date}T09:00:00Z`).toISOString() : null;

  // v4.0.1 — junk pass at ruthlessness 8/10 is SURFACED, never acted on. A live
  // capture is always kept OPEN; a would-be-junk item (junk_score >= 8) is simply
  // flagged (sanitizeEnrichItem sets review_reason "would be junk — your call")
  // and stored with its junk_score, so it lands in the daily deck with a "would
  // be junk" badge and the full note. The owner archives/retitles/reclassifies it
  // by hand — the pipeline decides nothing.
  const { data: item, error } = await admin
    .from("items")
    .insert({
      user_id: userId,
      type: it.type,
      title: it.title,
      body: it.body,
      raw: rawText,
      status: "open",
      priority: it.priority,
      tags: it.tags,
      source,
      sensitive,
      embedding_v2: embedding,
      created_at: createdAt,
      valid_from: createdAt,
      due_at: dueAt,
      confidence: itemConfidence,
      needs_review: needsReview,
      review_reason: reviewReason,
      junk_score: it.junk_score ?? null,
      entities: it.entities,
      links: links.map((l) => l.id),
      dup_candidate: dup?.id ?? null,
    })
    .select("id, type, title, tags, priority, due_at, needs_review, review_reason")
    .single();

  if (error || !item) {
    throw new Error(`db insert failed: ${error?.message ?? "unknown"}`);
  }

  let vault_path: string | null = null;
  let vault_url: string | null = null;
  let vaultError: string | null = null;
  try {
    vault_path = await writeVaultNote({
      id: item.id,
      type: item.type,
      title: item.title,
      body: it.body,
      tags: item.tags ?? [],
      priority: item.priority,
      source,
      createdAt,
      dueAt,
      entities: it.entities,
      links: links.map((l) => ({ id: l.id, title: l.title })),
      status,
    });
    vault_url = vaultUrl(vault_path);
    await admin.from("items").update({ vault_path }).eq("id", item.id);
  } catch (e) {
    vaultError = e instanceof Error ? e.message : String(e);
  }

  const action =
    source === "email"
      ? "email_capture"
      : source === "upload"
        ? "document_upload"
        : source === "screenshot"
          ? "screenshot_upload"
          : "capture";
  await logAudit(admin, {
    user_id: userId,
    item_id: item.id,
    action,
    actor: source === "email" ? "email" : "user",
    detail: {
      type: item.type,
      source,
      sensitive,
      needs_review: needsReview,
      split,
      junk_score: it.junk_score ?? null,
    },
  });

  return {
    item,
    due_at: item.due_at,
    needs_review: item.needs_review,
    review_reason: item.review_reason,
    junk_score: it.junk_score ?? null,
    entities: it.entities,
    links: links.map((l) => ({ id: l.id, title: l.title })),
    vault_path,
    vault_url,
    vaultError,
  };
}

// The shared capture pipeline: enrich -> (per item) storeEnrichedItem. Used by the
// typed capture route, the inbound-email webhook, and the token/shortcut route.
//
// v4.0 W2 — LIVE captures (typed / telegram / voice / email) SPLIT DIRECTLY: if
// the enrich pass reports 2+ distinct topics, each becomes its own item right
// away, with its own clean title, type, tags and embedding, cross-linked to its
// siblings. There is deliberately no approval step at capture time — the evening
// swipe deck is the approval gate, so capture stays zero-decision.
export async function captureText(
  userId: string,
  text: string,
  source: string,
  /** Owner instruction about how to file this one (see enrich). */
  directive = ""
): Promise<CaptureOutcome> {
  const admin = createAdminClient();
  // One-time codes are stripped BEFORE anything else touches the text, so no
  // downstream stage — model, embedding, vault file, `raw` column — ever holds
  // a live credential (owner decision 2026-08-02). Redaction at the Telegram
  // send path already stopped codes being echoed; this is the other half, and
  // it is what makes "Ask can quote a code back at you" impossible rather than
  // merely unlikely. The redactor is keyword-anchored, so control numbers,
  // invoice references and amounts pass through untouched.
  const { text: safeText } = redactCodes(text);
  const { sensitive, text: cleanText } = detectSensitive(safeText);
  const today = new Date().toISOString().slice(0, 10);

  let enriched: EnrichedItem[];
  let confidence: number;
  if (sensitive) {
    // Sensitive: no third-party LLM, so no AI title is possible. Clean the
    // note's own opening line mechanically and FLAG it — an un-AI-titled item
    // must not pass as one that met the standard (no-half-baked law).
    const derived = cleanTitle(cleanText.split("\n")[0]);
    // The junk pass still runs, but only its deterministic half — a private
    // note is never shown to a model, so only "there is no language in here"
    // structural junk can be decided.
    const junk = scoreJunk({ modelScore: null, title: derived, body: cleanText });
    enriched = [
      {
        title: derived || "Private note",
        type: "note",
        body: cleanText,
        tags: ["private"],
        priority: "medium",
        due_date: null,
        entities: [],
        confidence: 1,
        needs_review: true,
        review_reason: "private note — titled locally, not by the model",
        junk_score: junk.score,
        junk_verdict: junk.verdict,
        junk_reason: junk.structuralReason,
      },
    ];
    confidence = 1;
  } else {
    const r = await enrich(cleanText, today, directive);
    enriched = r.items;
    confidence = r.confidence;
    await logLlmUsage(admin, userId, "enrich", r.usage);
  }

  const split = enriched.length > 1;
  const created: CreatedItem[] = [];
  for (const it of enriched) {
    created.push(
      await storeEnrichedItem(admin, userId, it, {
        source,
        // The redacted text, not the original — `raw` is stored verbatim on the
        // item, so passing `text` here would have re-introduced the code the
        // line above just removed.
        rawText: safeText,
        sensitive,
        confidence,
        split,
        // Parts already stored from THIS capture: never duplicate-flag a sibling.
        siblingIds: created.map((c) => c.item.id),
      })
    );
  }

  if (created.length > 1) await crossLinkSplitParts(admin, userId, created, source, confidence);

  return { created, confidence, split: created.length > 1 };
}

// Wire the parts of one split capture to each other (links[] both ways) and
// record a single `split_capture` audit entry naming every part, so the split is
// inspectable and reversible from the audit trail alone.
async function crossLinkSplitParts(
  admin: Admin,
  userId: string,
  created: CreatedItem[],
  source: string,
  confidence: number
): Promise<void> {
  const ids = created.map((c) => c.item.id);

  for (const c of created) {
    const siblings = created.filter((o) => o.item.id !== c.item.id);
    const merged = [...new Set([...c.links.map((l) => l.id), ...siblings.map((s) => s.item.id)])].slice(
      0,
      MAX_LINKS
    );
    const { error } = await admin.from("items").update({ links: merged }).eq("id", c.item.id);
    if (error) continue; // a failed cross-link must not fail the capture
    c.links = [
      ...c.links,
      ...siblings.map((s) => ({ id: s.item.id, title: s.item.title })),
    ].slice(0, MAX_LINKS);
    // Keep the vault projection consistent with the new links (best-effort).
    if (c.vault_path) await reprojectItemToVault(admin, c.item.id);
  }

  await logAudit(admin, {
    user_id: userId,
    item_id: ids[0],
    action: "split_capture",
    actor: "system",
    detail: {
      source,
      confidence,
      parts: ids,
      titles: created.map((c) => c.item.title),
    },
  });
}
