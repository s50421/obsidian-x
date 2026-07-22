import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { enrich } from "@/lib/enrich";
import { embed } from "@/lib/embed";
import { writeVaultNote, vaultUrl } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let text = "";
  try {
    ({ text } = await req.json());
  } catch {
    // handled below
  }
  text = (text ?? "").toString().trim();
  if (!text) {
    return NextResponse.json({ error: "empty note" }, { status: 400 });
  }

  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const { items: enriched, confidence } = await enrich(text, today);

  const created = [];

  for (const it of enriched) {
    const embedding = await embed(`${it.title}\n\n${it.body}`);

    // Neighbor search drives both auto-link and duplicate detection.
    const { data: neigh } = await admin.rpc("match_neighbors", {
      query_embedding: embedding,
      owner: user.id,
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
        user_id: user.id,
        type: it.type,
        title: it.title,
        body: it.body,
        raw: text,
        status: "open",
        priority: it.priority,
        tags: it.tags,
        source: "typed",
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
      return NextResponse.json(
        { error: `db insert failed: ${error?.message ?? "unknown"}` },
        { status: 500 }
      );
    }

    // Project to the vault (best effort — a failed write must not lose the note).
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
        source: "typed",
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

  return NextResponse.json({ created, confidence, split: created.length > 1 });
}
