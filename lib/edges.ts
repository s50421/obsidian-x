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
  | "similar"
  // Owner ask 2026-08-02: "more ways to show connections e.g. same task".
  // These are all FACTS about the items rather than guesses, so they are
  // confirmed on sight like a shared entity — no approval step.
  /** Both items are projected onto the same ClickUp task. */
  | "same_task"
  /** Both fall due on the same day. */
  | "same_due_date"
  /** The owner drew this connection by hand. */
  | "manual";

export type EdgeStatus = "confirmed" | "suggested" | "dismissed";

export type Edge = {
  src: string;
  dst: string;
  kind: EdgeKind;
  reason: string;
  weight: number;
  entity_id: string | null;
  discovery: boolean;
  /**
   * The Obsidian model (see migration 0013). A `confirmed` edge is drawn; a
   * `suggested` one is only offered. Similarity is a suggestion, never a fact.
   */
  status: EdgeStatus;
};

/**
 * A sanity floor, NOT a similarity threshold.
 *
 * The old design used an absolute cutoff of 0.662, borrowed from the
 * capture-time auto-link job (measured 2026-07-28 on a 29-item corpus that
 * still contained the Apple Notes). Re-measured on the live brain 2026-08-02:
 * the highest similarity between ANY two items is 0.503, p95 is 0.372, median
 * 0.174. So the cutoff was unreachable and every similarity edge was silently
 * impossible — which is why shared-tag edges were left doing all the work.
 *
 * An absolute cutoff cannot survive a corpus that changes: it was right in
 * July, wrong in August, and would be wrong again by October. Ranking asks a
 * question that needs no recalibration — "is this item among your nearest
 * neighbours, and are you among mine?" This floor only stops two items with
 * nothing in common being paired in a nearly-empty brain.
 */
export const SIMILARITY_FLOOR = 0.3;

/**
 * How many nearest neighbours count, and mutually.
 *
 * MEASURED on the live corpus: at top-2 the suggestions are exactly the four
 * clusters the owner said were missing (the three shopping-list items, the
 * family-legal pair, the money/admin group, the weekend group). At top-3 the
 * noise returns — "RBC checks" pairs with a Crypto.com passkey alert. Two is
 * the knee.
 */
export const NEIGHBOURS_PER_ITEM = 2;

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
          // The [[wikilink]] equivalent: a shared canonical entity is a stated
          // fact about both items, not an inference. Drawn.
          status: "confirmed",
        });
      }
    }
  }
  return out;
}

/**
 * Topic edges — RETIRED as a connection kind (2026-08-02).
 *
 * Kept as a function so the decision is visible rather than silently absent.
 * A shared tag was the source of every bad link the owner named, twice:
 * "both tagged tech" joined a Crypto.com passkey alert to chip-AI research;
 * "both tagged finance" joined a reimbursement chase to the same passkey alert.
 * The reason is structural, not a tuning problem — a tag says what an item is
 * ABOUT, not that two items have anything to do with each other, and with 25
 * tags over a small corpus collisions are inevitable.
 *
 * Obsidian does not use tags as edges either; it can show them as NODES. That
 * is the right home for this if the owner wants tags in the graph, and it
 * belongs to the parked renderer work.
 *
 * This reverses one workshop pick ("shared topic tag" as an edge kind), which
 * is why it is documented here instead of deleted.
 */
export function deriveTopicEdges(): Edge[] {
  return [];
}

export type TaskItem = {
  id: string;
  title: string;
  due_at: string | null;
  external: { clickup?: { id?: string; url?: string } } | null;
};

/**
 * Two items pinned to the SAME ClickUp task.
 *
 * The strongest connection the system can assert without a model: the owner (or
 * the projection) put both of these against one piece of work. Confirmed on
 * sight — there is no judgement to make.
 */
export function deriveSameTaskEdges(items: TaskItem[]): Edge[] {
  const byTask = new Map<string, TaskItem[]>();
  for (const i of items) {
    const id = i.external?.clickup?.id;
    if (!id) continue;
    const arr = byTask.get(id) ?? [];
    arr.push(i);
    byTask.set(id, arr);
  }

  const out: Edge[] = [];
  for (const [, group] of byTask) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [src, dst] = orderPair(group[i].id, group[j].id);
        if (src === dst) continue;
        out.push({
          src,
          dst,
          kind: "same_task",
          reason: "both on the same ClickUp task",
          weight: 1,
          entity_id: null,
          discovery: false,
          status: "confirmed",
        });
      }
    }
  }
  return out;
}

/**
 * Two items due on the same DAY.
 *
 * Weak on its own, but it is the connection the owner actually acts on — "what
 * else is landing on Sunday?" is a real question, and nothing else in the graph
 * could answer it. Capped: a date shared by a large slice of the corpus is a
 * busy week, not a relationship.
 */
export function deriveSameDueDateEdges(items: TaskItem[], maxPerDay = 4): Edge[] {
  const byDay = new Map<string, TaskItem[]>();
  for (const i of items) {
    if (!i.due_at) continue;
    const day = i.due_at.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(i);
    byDay.set(day, arr);
  }

  const out: Edge[] = [];
  for (const [day, group] of byDay) {
    if (group.length < 2 || group.length > maxPerDay) continue;
    const pretty = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [src, dst] = orderPair(group[i].id, group[j].id);
        if (src === dst) continue;
        out.push({
          src,
          dst,
          kind: "same_due_date",
          reason: `both due ${pretty}`,
          weight: 0.7,
          entity_id: null,
          discovery: false,
          status: "confirmed",
        });
      }
    }
  }
  return out;
}

/**
 * One item's text names another item's TITLE.
 *
 * Obsidian's unlinked-mention idea applied to notes rather than entities: if a
 * memory literally refers to another memory, that is a stated connection, not
 * an inference. Titles under 12 characters are skipped — "RBC checks" would
 * match half the corpus.
 */
export function deriveReferenceEdges(
  items: { id: string; title: string; body: string | null }[]
): Edge[] {
  const out: Edge[] = [];
  const candidates = items.filter((i) => (i.title ?? "").trim().length >= 12);

  for (const target of candidates) {
    const title = target.title.trim();
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(title)}([^\\p{L}\\p{N}]|$)`, "iu");
    for (const source of items) {
      if (source.id === target.id) continue;
      if (!re.test(`${source.title ?? ""}\n${source.body ?? ""}`)) continue;
      const [src, dst] = orderPair(source.id, target.id);
      out.push({
        src,
        dst,
        kind: "reference",
        reason: `"${source.title}" mentions "${title}"`,
        weight: 0.9,
        entity_id: null,
        discovery: false,
        status: "confirmed",
      });
    }
  }
  return out;
}

/**
 * SUGGESTED links from embedding similarity, by mutual rank.
 *
 * Obsidian's model, adapted: it never infers an edge, it surfaces "unlinked
 * mentions" for a human to accept. Similarity is this system's equivalent of a
 * hunch, so it produces suggestions the owner confirms — never lines on the
 * canvas. That is the honest status for "these read similarly", and drawing it
 * as though it were a fact is most of why the graph read as random.
 *
 * Mutual rank rather than an absolute cutoff: A must be among B's nearest and B
 * among A's. That is self-calibrating as the corpus grows, and it is what makes
 * the three shopping-list items find each other while a passkey alert and some
 * chip research do not.
 */
export async function deriveSimilarSuggestions(
  admin: SupabaseClient,
  userId: string,
  items: { id: string; title: string }[]
): Promise<Edge[]> {
  const titleById = new Map(items.map((i) => [i.id, i.title]));

  // Each item's ranked neighbours, in one pass.
  const nearest = new Map<string, { id: string; similarity: number }[]>();
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
      match_count: NEIGHBOURS_PER_ITEM + 4,
    });
    nearest.set(
      it.id,
      ((neigh ?? []) as { id: string; similarity: number }[])
        .filter((n) => titleById.has(n.id) && n.similarity >= SIMILARITY_FLOOR)
        .slice(0, NEIGHBOURS_PER_ITEM)
    );
  }

  const out: Edge[] = [];
  for (const [id, hits] of nearest) {
    for (const n of hits) {
      // Mutual only. A one-way "you're my nearest" is usually an item with no
      // real relatives reaching for the closest thing in the room.
      if (!(nearest.get(n.id) ?? []).some((m) => m.id === id)) continue;
      const [src, dst] = orderPair(id, n.id);
      if (src === dst) continue;
      out.push({
        src,
        dst,
        kind: "similar",
        // The other item's title is already shown next to this line, so naming
        // it again read as stutter. Say what the system actually knows: how
        // close, and that closeness is all it knows.
        reason: `reads similarly (${Math.round(n.similarity * 100)}% match) — not a stated connection`,
        weight: n.similarity,
        entity_id: null,
        discovery: true,
        status: "suggested",
      });
    }
  }
  return out;
}

/**
 * SUGGESTED links from unlinked mentions — Obsidian's actual mechanism.
 *
 * An item's TEXT contains a canonical entity's name or one of its aliases, but
 * the classifier never extracted it, so no link exists. Obsidian solves this
 * exact problem the same way: match the note name or alias in raw text and
 * offer it. No model, no embedding, no threshold — it is either in the text or
 * it isn't, which makes it the most explainable suggestion the system can make.
 */
export function deriveUnlinkedMentions(
  items: { id: string; title: string; body: string | null }[],
  entities: EntityRow[],
  existing: LinkRow[]
): { itemId: string; entityId: string; entityName: string; matched: string }[] {
  const linked = new Set(existing.map((l) => `${l.item_id}|${l.entity_id}`));
  const out: { itemId: string; entityId: string; entityName: string; matched: string }[] = [];

  for (const e of entities) {
    if (!e.edge_eligible) continue;
    const forms = [e.name, ...((e as EntityRow & { aliases?: string[] }).aliases ?? [])]
      .map((f) => (f ?? "").trim())
      .filter((f) => f.length >= 3); // "V-B", "Jo" would match half the corpus
    if (!forms.length) continue;

    for (const it of items) {
      if (linked.has(`${it.id}|${e.id}`)) continue;
      const hay = `${it.title ?? ""}\n${it.body ?? ""}`;
      const hit = forms.find((f) => {
        // Whole-word match, so "Don" doesn't fire inside "don't" and "Anna"
        // doesn't fire inside "Annapolis".
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(f)}([^\\p{L}\\p{N}]|$)`, "iu");
        return re.test(hay);
      });
      if (hit) out.push({ itemId: it.id, entityId: e.id, entityName: e.name, matched: hit });
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
): Promise<{
  written: number;
  byKind: Record<string, number>;
  confirmed: number;
  suggested: number;
  mentions: number;
}> {
  const { data: allItems } = await admin
    .from("items")
    .select("id,title,body,tags,source,due_at,external")
    .eq("user_id", userId)
    .neq("status", "archived")
    .is("valid_to", null)
    .limit(2000);
  const items = edgeEligibleItems(
    (allItems ?? []) as (ItemRow & { body: string | null; due_at: string | null; external: TaskItem["external"] })[]
  );

  const { data: entities } = await admin
    .from("entities")
    .select("id,name,kind,aliases,edge_eligible")
    .eq("user_id", userId);

  const live = new Set(items.map((i) => i.id));
  const { data: links } = await admin
    .from("item_entities")
    .select("item_id,entity_id,raw_name")
    .eq("user_id", userId);
  const liveLinks = ((links ?? []) as LinkRow[]).filter((l) => live.has(l.item_id));

  // Everything the owner has already ruled on. Re-offering a dismissed pair on
  // every nightly rebuild would make the feature feel broken inside a week, and
  // a confirmed pair must keep its confirmed status through a rebuild.
  const { data: ruled } = await admin
    .from("edges")
    .select("src,dst,kind,status")
    .eq("user_id", userId)
    .in("status", ["dismissed", "confirmed"]);

  // Connections the owner drew by hand are not derived from anything, so a
  // rebuild would simply delete them. They are re-added verbatim.
  const { data: manual } = await admin
    .from("edges")
    .select("src,dst,kind,reason,weight,entity_id,discovery,status")
    .eq("user_id", userId)
    .eq("kind", "manual");
  const verdict = new Map<string, string>();
  for (const r of ruled ?? []) verdict.set(`${r.src}|${r.dst}|${r.kind}`, r.status as string);

  // Obsidian's "unlinked mentions": the entity's name or an alias appears in an
  // item's text but was never extracted, so no link exists. Attached directly as
  // an item↔entity link, which then produces normal confirmed entity edges —
  // exactly as if the classifier had caught it.
  const mentions = deriveUnlinkedMentions(
    items.map((i) => ({ id: i.id, title: i.title, body: i.body })),
    (entities ?? []) as EntityRow[],
    liveLinks
  );
  for (const m of mentions) {
    await admin.from("item_entities").upsert(
      { item_id: m.itemId, entity_id: m.entityId, user_id: userId, raw_name: m.matched },
      { onConflict: "item_id,entity_id" }
    );
    liveLinks.push({ item_id: m.itemId, entity_id: m.entityId, raw_name: m.matched });
  }

  const taskItems = items as unknown as TaskItem[];
  const derived = [
    ...deriveEntityEdges((entities ?? []) as EntityRow[], liveLinks),
    ...deriveTopicEdges(),
    // Facts about the items, not guesses — confirmed on sight.
    ...deriveSameTaskEdges(taskItems),
    ...deriveSameDueDateEdges(taskItems),
    ...deriveReferenceEdges(items.map((i) => ({ id: i.id, title: i.title, body: i.body }))),
    ...(opts.includeSimilar ? await deriveSimilarSuggestions(admin, userId, items) : []),
  ];

  const final = dedupeEdges([...derived, ...((manual ?? []) as unknown as Edge[])])
    .map((e) => {
      const v = verdict.get(`${e.src}|${e.dst}|${e.kind}`);
      if (v === "dismissed") return { ...e, status: "dismissed" as EdgeStatus };
      if (v === "confirmed") return { ...e, status: "confirmed" as EdgeStatus };
      return e;
    })
    // A dismissed pair is not stored again — the owner said no, and the verdict
    // map above is what remembers it for the next rebuild.
    .filter((e) => e.status !== "dismissed");

  await admin.from("edges").delete().eq("user_id", userId).neq("status", "dismissed");
  const byKind: Record<string, number> = {};
  for (let i = 0; i < final.length; i += 200) {
    const chunk = final.slice(i, i + 200).map((e) => ({ ...e, user_id: userId }));
    await admin.from("edges").insert(chunk);
  }
  for (const e of final) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return {
    written: final.length,
    byKind,
    confirmed: final.filter((e) => e.status === "confirmed").length,
    suggested: final.filter((e) => e.status === "suggested").length,
    mentions: mentions.length,
  };
}

export type ConnectionView = {
  edgeId: string;
  otherId: string;
  otherTitle: string;
  otherType: string;
  kind: EdgeKind;
  reason: string;
  discovery: boolean;
  status: EdgeStatus;
};

/** Everything connected to one item, best first, for the inspector. */
export async function connectionsFor(
  admin: SupabaseClient,
  userId: string,
  itemId: string
): Promise<ConnectionView[]> {
  const { data } = await admin
    .from("edges")
    .select("id,src,dst,kind,reason,weight,discovery,status")
    .eq("user_id", userId)
    .neq("status", "dismissed")
    .or(`src.eq.${itemId},dst.eq.${itemId}`)
    // Confirmed first, then by strength — a suggestion must never sit above a
    // stated fact in the list.
    .order("status", { ascending: true })
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
        edgeId: r.id as string,
        otherId,
        otherTitle: (other.title as string) ?? "(untitled)",
        otherType: (other.type as string) ?? "note",
        kind: r.kind as EdgeKind,
        reason: r.reason as string,
        discovery: r.discovery as boolean,
        status: (r.status as EdgeStatus) ?? "confirmed",
      };
    })
    .filter((x): x is ConnectionView => !!x);
}
