import { createAdminClient } from "@/lib/supabase/admin";
import { enrich } from "@/lib/enrich";
import { embed } from "@/lib/embed";
import { writeVaultNote, vaultUrl } from "@/lib/vault";

// Similarity thresholds (cosine, 0..1) for normalized gte-small vectors.
const LINK_THRESHOLD = 0.4; // loosely related -> auto-link
const DUP_THRESHOLD = 0.85; // near-identical -> flag as a merge candidate
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

// The shared capture pipeline: enrich -> (per item) embed -> neighbor search
// (auto-link + duplicate flag) -> store -> vault. Used by the typed capture
// route and the inbound-email webhook.
export async function captureText(
  userId: string,
  text: string,
  source: string
): Promise<CaptureOutcome> {
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const { items: enriched, confidence } = await enrich(text, today);

  const created: CreatedItem[] = [];

  for (const it of enriched) {
    const embedding = await embed(`${it.title}\n\n${it.body}`);

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
        raw: text,
        status: "open",
        priority: it.priority,
        tags: it.tags,
        source,
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
      });
      vault_url = vaultUrl(vault_path);
      await admin.from("items").update({ vault_path }).eq("id", item.id);
    } catch (e) {
      vaultError = e instanceof Error ? e.message : String(e);
    }

    created.push({
      item,
      due_at: item.due_at,
      needs_review: item.needs_review,
      review_reason: item.review_reason,
      entities: it.entities,
      links: links.map((l) => ({ id: l.id, title: l.title })),
      vault_path,
      vault_url,
      vaultError,
    });
  }

  return { created, confidence, split: created.length > 1 };
}
