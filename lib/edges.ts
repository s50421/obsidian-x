import type { SupabaseClient } from "@supabase/supabase-js";

// Obsidian-X — typed, explainable connections (brain-quality brief, Phase 2).
//
// THE PROBLEM THIS REPLACES, measured on the live brain 2026-08-02:
//   13 links total. 12 were "these four items came from the same braindump".
//   1 was a leftover gte-small similarity link. 0 were real current-space
//   similarity. A "connection" had no type and no reason, so the owner read it
//   as noise — correctly.
//
// Every edge here must be able to say WHY in plain words, because that is the
// brief's exit test: "the owner can tap any connection anywhere and see WHY it
// exists". `reason` is NOT NULL in the schema for that reason.
//
// Owner's ranking of what a connection should mean (workshop, 2026-08-02):
//   shared person/org/place · shared topic tag · embedding similarity.
// He explicitly did NOT choose thread/braindump provenance, so those edges are
// purged rather than relabelled — "we arrived together" is not "we are related".

export type EdgeKind =
  | "shared_person"
  | "shared_org"
  | "shared_place"
  | "shared_topic"
  | "reference"
  | "thread"
  | "similar";

export type Edge = {
  src: string;
  dst: string;
  kind: EdgeKind;
  reason: string;
  weight: number;
  entity_id: string | null;
  discovery: boolean;
};

/**
 * Similarity floor for a `similar` edge.
 *
 * The same MEASURED value the capture path uses for auto-linking (NN p75 on the
 * live corpus, embedding_v2 @1024d). Reusing it rather than picking a new
 * number keeps one definition of "clearly related" in the system.
 */
export const SIMILAR_THRESHOLD = 0.662;

/** A discovery edge is a guess, so a node may only make a few. */
export const MAX_SIMILAR_PER_ITEM = 3;

/**
 * Tags too broad to mean two items are related.
 *
 * `food` sits on five unrelated shopping items; `people` on four items whose
 * only commonality is that a human is mentioned. A topic edge built on these
 * would recreate exactly the noise this file exists to remove.
 */
export const BROAD_TAGS = new Set(["people", "food", "admin", "media", "learning"]);

/**
 * Tags the SYSTEM sets, which describe how an item was produced rather than
 * what it is about. `digest` sits on every auto-generated daily summary and
 * `private` on anything the sensitivity path withheld — neither says two items
 * are related.
 */
export const SYSTEM_TAGS = new Set(["digest", "private"]);

/**
 * Sources whose items are machine output, not memories.
 *
 * The first real derivation run produced 13 edges, SIX of which merely joined
 * the three auto-generated daily digests to each other. That grows as n² with
 * one new digest a day, and none of it is a connection the owner would ever
 * want to see. Machine-written summaries are excluded from the graph entirely.
 */
export const NON_MEMORY_SOURCES = new Set(["system"]);

/** Undirected edges are stored with the smaller id first so (a,b) == (b,a). */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

const KIND_BY_ENTITY: Record<string, EdgeKind> = {
  person: "shared_person",
  org: "shared_org",
  place: "shared_place",
};

export type EntityRow = { id: string; name: string; kind: string; edge_eligible: boolean };
export type LinkRow = { item_id: string; entity_id: string; raw_name: string | null };
export type ItemRow = { id: string; title: string; tags: string[] | null; source?: string | null };

/** Items that may take part in the graph at all. */
export function edgeEligibleItems<T extends { source?: string | null }>(items: T[]): T[] {
  return items.filter((i) => !NON_MEMORY_SOURCES.has((i.source ?? "").toLowerCase()));
}

/**
 * Entity edges: two items that mention the same person, org or place.
 *
 * The reason quotes the ORIGINAL wording when the two items wrote the entity
 * differently — "both mention Beate Manhart (as 'mum' and 'Beate Manhart')" —
 * because after a merge the canonical name may be words neither item contains,
 * and an explanation the owner can't find in the text is not an explanation.
 */
export function deriveEntityEdges(
  entities: EntityRow[],
  links: LinkRow[]
): Edge[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const byEntity = new Map<string, LinkRow[]>();
  for (const l of links) {
    const e = byId.get(l.entity_id);
    // Self/system entities are recorded but never derive edges — the owner
    // appears in nearly everything, so this is what stops one hub node joining
    // his entire brain to itself.
    if (!e || !e.edge_eligible) continue;
    const kind = KIND_BY_ENTITY[e.kind];
    if (!kind) continue; // 'other' is not a relationship worth asserting
    const arr = byEntity.get(l.entity_id) ?? [];
    arr.push(l);
    byEntity.set(l.entity_id, arr);
  }

  const out: Edge[] = [];
  for (const [entityId, rows] of byEntity) {
    if (rows.length < 2) continue;
    const e = byId.get(entityId)!;
    const kind = KIND_BY_ENTITY[e.kind];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [src, dst] = orderPair(rows[i].item_id, rows[j].item_id);
        if (src === dst) continue;
        const a = (rows[i].raw_name ?? "").trim();
        const b = (rows[j].raw_name ?? "").trim();
        const differs = a && b && a.toLowerCase() !== b.toLowerCase();
        out.push({
          src,
          dst,
          kind,
          reason: differs
            ? `both mention ${e.name} — as "${a}" and "${b}"`
            : `both mention ${e.name}`,
          weight: 1,
          entity_id: entityId,
          discovery: false,
        });
      }
    }
  }
  return out;
}

/**
 * Topic edges: two items carrying the same specific taxonomy tag.
 *
 * Broad tags are excluded (see BROAD_TAGS) and so is any tag shared by a large
 * slice of the corpus — a tag that describes a third of the brain describes
 * nothing about a pair within it.
 */
export function deriveTopicEdges(items: ItemRow[], maxShare = 0.2): Edge[] {
  const byTag = new Map<string, ItemRow[]>();
  for (const it of items) {
    for (const t of it.tags ?? []) {
      if (BROAD_TAGS.has(t) || SYSTEM_TAGS.has(t)) continue;
      const arr = byTag.get(t) ?? [];
      arr.push(it);
      byTag.set(t, arr);
    }
  }

  const out: Edge[] = [];
  const limit = Math.max(2, Math.floor(items.length * maxShare));
  for (const [tag, rows] of byTag) {
    if (rows.length < 2 || rows.length > limit) continue;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [src, dst] = orderPair(rows[i].id, rows[j].id);
        if (src === dst) continue;
        out.push({
          src,
          dst,
          kind: "shared_topic",
          reason: `both tagged ${tag}`,
          weight: 0.6,
          entity_id: null,
          discovery: false,
        });
      }
    }
  }
  return out;
}

/**
 * Similarity edges from embedding_v2, capped per item and marked as guesses.
 *
 * These are the only edges that cannot really explain themselves — "these read
 * similarly" is the honest limit of what an embedding knows — so they carry
 * `discovery: true` and the UI is expected to present them differently. That
 * honesty is the point: the single legacy link that survived into 2026-08 was a
 * similarity edge presented as though it were a fact.
 */
export async function deriveSimilarEdges(
  admin: SupabaseClient,
  userId: string,
  items: { id: string; title: string }[]
): Promise<Edge[]> {
  const titleById = new Map(items.map((i) => [i.id, i.title]));
  const out: Edge[] = [];

  for (const it of items) {
    const { data: emb } = await admin
      .from("items")
      .select("embedding_v2")
      .eq("id", it.id)
      .maybeSingle();
    const vec = emb?.embedding_v2;
    if (!vec) continue;

    const { data: neigh } = await admin.rpc("match_neighbors_v2", {
      query_embedding: typeof vec === "string" ? JSON.parse(vec) : vec,
      owner: userId,
      exclude_id: it.id,
      match_count: MAX_SIMILAR_PER_ITEM + 2,
    });

    const hits = ((neigh ?? []) as { id: string; similarity: number }[])
      .filter((n) => n.similarity >= SIMILAR_THRESHOLD && titleById.has(n.id))
      .slice(0, MAX_SIMILAR_PER_ITEM);

    for (const n of hits) {
      const [src, dst] = orderPair(it.id, n.id);
      if (src === dst) continue;
      out.push({
        src,
        dst,
        kind: "similar",
        reason: `reads similarly to "${titleById.get(n.id)}" (${Math.round(n.similarity * 100)}% match)`,
        weight: n.similarity,
        entity_id: null,
        discovery: true,
      });
    }
  }
  return out;
}

/** Collapse duplicates produced by two passes proposing the same pair+kind. */
export function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>();
  for (const e of edges) {
    const key = `${e.src}|${e.dst}|${e.kind}|${e.entity_id ?? ""}`;
    const prev = seen.get(key);
    if (!prev || e.weight > prev.weight) seen.set(key, e);
  }
  return [...seen.values()];
}

/**
 * Rebuild every derived edge for this owner.
 *
 * Full rebuild rather than incremental: the corpus is small, the derivation is
 * pure, and an incremental edge table drifts out of sync with the entities it
 * was derived from the first time a merge happens. Cheap correctness beats
 * clever bookkeeping here.
 */
export async function rebuildEdges(
  admin: SupabaseClient,
  userId: string,
  opts: { includeSimilar?: boolean } = {}
): Promise<{ written: number; byKind: Record<string, number> }> {
  const { data: allItems } = await admin
    .from("items")
    .select("id,title,tags,source")
    .eq("user_id", userId)
    .neq("status", "archived")
    .is("valid_to", null)
    .limit(2000);
  const items = edgeEligibleItems((allItems ?? []) as ItemRow[]);

  const { data: entities } = await admin
    .from("entities")
    .select("id,name,kind,edge_eligible")
    .eq("user_id", userId);

  const live = new Set(items.map((i) => i.id));
  const { data: links } = await admin
    .from("item_entities")
    .select("item_id,entity_id,raw_name")
    .eq("user_id", userId);

  const edges = [
    ...deriveEntityEdges(
      (entities ?? []) as EntityRow[],
      ((links ?? []) as LinkRow[]).filter((l) => live.has(l.item_id))
    ),
    ...deriveTopicEdges(items),
    ...(opts.includeSimilar ? await deriveSimilarEdges(admin, userId, items) : []),
  ];

  const final = dedupeEdges(edges);

  await admin.from("edges").delete().eq("user_id", userId);
  const byKind: Record<string, number> = {};
  for (let i = 0; i < final.length; i += 200) {
    const chunk = final.slice(i, i + 200).map((e) => ({ ...e, user_id: userId }));
    await admin.from("edges").insert(chunk);
  }
  for (const e of final) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { written: final.length, byKind };
}

export type ConnectionView = {
  otherId: string;
  otherTitle: string;
  otherType: string;
  kind: EdgeKind;
  reason: string;
  discovery: boolean;
};

/** Everything connected to one item, best first, for the inspector. */
export async function connectionsFor(
  admin: SupabaseClient,
  userId: string,
  itemId: string
): Promise<ConnectionView[]> {
  const { data } = await admin
    .from("edges")
    .select("src,dst,kind,reason,weight,discovery")
    .eq("user_id", userId)
    .or(`src.eq.${itemId},dst.eq.${itemId}`)
    .order("weight", { ascending: false })
    .limit(50);

  const rows = data ?? [];
  const otherIds = [...new Set(rows.map((r) => (r.src === itemId ? r.dst : r.src) as string))];
  if (!otherIds.length) return [];

  const { data: others } = await admin
    .from("items")
    .select("id,title,type")
    .in("id", otherIds);
  const byId = new Map((others ?? []).map((o) => [o.id as string, o]));

  return rows
    .map((r) => {
      const otherId = (r.src === itemId ? r.dst : r.src) as string;
      const other = byId.get(otherId);
      if (!other) return null;
      return {
        otherId,
        otherTitle: (other.title as string) ?? "(untitled)",
        otherType: (other.type as string) ?? "note",
        kind: r.kind as EdgeKind,
        reason: r.reason as string,
        discovery: r.discovery as boolean,
      };
    })
    .filter((x): x is ConnectionView => !!x);
}
