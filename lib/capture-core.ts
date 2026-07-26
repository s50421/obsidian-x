import { createAdminClient } from "@/lib/supabase/admin";
import { enrich, type EnrichedItem } from "@/lib/enrich";
import { embed } from "@/lib/embed";
import { writeVaultNote, vaultUrl } from "@/lib/vault";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";
import { detectSensitive } from "@/lib/sensitivity";

// Similarity thresholds (cosine, 0..1). gte-small has a HIGH floor — even
// distinct items score ~0.76–0.89 (measured: "Meeting with Dani" ~ "Meeting with
// V-Bank" = 0.865), so low thresholds match everything. These are tuned above
// that floor: auto-link only genuinely-related items, and flag a duplicate only
// when it's near-identical (a true re-capture is ~0.95+).
const LINK_THRESHOLD = 0.8; // clearly related -> auto-link
const DUP_THRESHOLD = 0.93; // near-identical -> flag as a merge candidate
const LOW_CONFIDENCE = 0.55;

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

  const embedding = await embed(opts.embedText ?? `${it.title}\n\n${it.body}`);

  const { data: neigh } = await admin.rpc("match_neighbors", {
    query_embedding: embedding,
    owner: userId,
    exclude_id: null,
    match_count: 6,
  });
  const neighbors = (neigh ?? []) as Neighbor[];
  const dup = neighbors.find((n) => n.similarity >= DUP_THRESHOLD) ?? null;
  const links = neighbors
    .filter((n) => n.similarity >= LINK_THRESHOLD && (!dup || n.id !== dup.id))
    .slice(0, 5);

  const lowConfidence = confidence < LOW_CONFIDENCE;
  const needsReview = lowConfidence || !!dup;
  const reviewReason = dup
    ? `possible duplicate of "${dup.title}"`
    : lowConfidence
      ? "low confidence — please confirm"
      : null;

  const createdAt = new Date().toISOString();
  const dueAt = it.due_date ? new Date(`${it.due_date}T09:00:00Z`).toISOString() : null;

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
      embedding,
      created_at: createdAt,
      valid_from: createdAt,
      due_at: dueAt,
      confidence,
      needs_review: needsReview,
      review_reason: reviewReason,
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
      status: "open",
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
    detail: { type: item.type, source, sensitive, needs_review: needsReview, split },
  });

  return {
    item,
    due_at: item.due_at,
    needs_review: item.needs_review,
    review_reason: item.review_reason,
    entities: it.entities,
    links: links.map((l) => ({ id: l.id, title: l.title })),
    vault_path,
    vault_url,
    vaultError,
  };
}

// The shared capture pipeline: enrich -> (per item) storeEnrichedItem. Used by the
// typed capture route, the inbound-email webhook, and the token/shortcut route.
export async function captureText(
  userId: string,
  text: string,
  source: string
): Promise<CaptureOutcome> {
  const admin = createAdminClient();
  const { sensitive, text: cleanText } = detectSensitive(text);
  const today = new Date().toISOString().slice(0, 10);

  let enriched: EnrichedItem[];
  let confidence: number;
  if (sensitive) {
    // Sensitive: no third-party LLM. Minimal local classification only.
    const title = cleanText.split("\n")[0].slice(0, 60).trim() || "Private note";
    enriched = [
      { title, type: "note", body: cleanText, tags: ["private"], priority: "medium", due_date: null, entities: [] },
    ];
    confidence = 1;
  } else {
    const r = await enrich(cleanText, today);
    enriched = r.items;
    confidence = r.confidence;
    await logLlmUsage(admin, userId, "enrich", r.usage);
  }

  const split = enriched.length > 1;
  const created: CreatedItem[] = [];
  for (const it of enriched) {
    created.push(
      await storeEnrichedItem(admin, userId, it, { source, rawText: text, sensitive, confidence, split })
    );
  }

  return { created, confidence, split: created.length > 1 };
}
