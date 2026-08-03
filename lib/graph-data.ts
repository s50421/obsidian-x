import type { SupabaseClient } from "@supabase/supabase-js";

// Obsidian-X — what the graph draws (graph-redesign-brief, scope item 2).
//
// Two node kinds, per the brief:
//   ITEM   — a memory, hued by type, sized by degree.
//   ENTITY — a canonical person/org/place, drawn with a dashed ring.
//
// Entity nodes are the structural change. Before this, two items that both
// mention Dani were joined by a line and nothing said who Dani was; the graph
// could show a relationship but never its subject. With entity nodes the items
// hang off "Dani" and the cluster has a name you can read — which is the whole
// reason the brief calls for them.
//
// Only CONFIRMED edges reach the graph. Suggestions live in the item inspector
// where they can be accepted; drawing a guess is what made the old graph read
// as random (see migration 0013).

export type GraphNodeKind = "item" | "entity";

export type GraphNodeData = {
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** Item type (note/task/…) for items; entity kind (person/org/place) for entities. */
  sub: string;
  /** Number of edges touching this node — drives node size. */
  degree: number;
  /** Index of the connected component this node belongs to, largest first. */
  component: number;
};

export type GraphLinkData = {
  source: string;
  target: string;
  kind: string;
  /** Human-readable, shown on tap. Never empty (NOT NULL in the schema). */
  reason: string;
};

export type GraphPayload = {
  nodes: GraphNodeData[];
  links: GraphLinkData[];
  /** How many nodes sit in the largest connected component — the default frame. */
  largestComponentSize: number;
  counts: { items: number; entities: number; links: number; suggested: number };
  /**
   * Set when a query FAILED, as opposed to legitimately returning nothing.
   *
   * These are two completely different states and they were rendering
   * identically: a transient error made the page announce "No active notes
   * yet" to an owner with 23 memories. Silence that reads as emptiness is the
   * exact failure the coverage panel exists to prevent, and it does not get a
   * pass here.
   */
  error: string | null;
};

/**
 * Label a node with the connected component it belongs to, components ordered
 * largest first (so component 0 is always the biggest).
 *
 * The brief's legibility bar asks the default view to frame "the largest
 * connected component, not the whole sparse cloud" — with 20-odd mostly
 * unconnected items, fitting everything is what made the old graph render
 * every node sub-pixel.
 */
export function labelComponents(
  nodeIds: string[],
  links: { source: string; target: string }[]
): { component: Map<string, number>; largest: number } {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const l of links) {
    adj.get(l.source)?.push(l.target);
    adj.get(l.target)?.push(l.source);
  }

  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of nodeIds) {
    if (seen.has(id)) continue;
    const stack = [id];
    const group: string[] = [];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const n of adj.get(cur) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    groups.push(group);
  }

  groups.sort((a, b) => b.length - a.length);
  const component = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => component.set(id, i)));
  return { component, largest: groups[0]?.length ?? 0 };
}

export async function loadGraph(
  admin: SupabaseClient,
  userId: string
): Promise<GraphPayload> {
  const [itemsRes, edgesRes, entitiesRes, entLinksRes] = await Promise.all([
      admin
        .from("items")
        .select("id,title,type,source")
        .eq("user_id", userId)
        .neq("status", "archived")
        .is("valid_to", null)
        .limit(5000),
      admin
        .from("edges")
        .select("src,dst,kind,reason,status,entity_id")
        .eq("user_id", userId)
        .eq("status", "confirmed")
        .limit(20000),
      admin
        .from("entities")
        .select("id,name,kind,edge_eligible")
        .eq("user_id", userId)
        .eq("edge_eligible", true)
        .limit(5000),
    admin.from("item_entities").select("item_id,entity_id,raw_name").eq("user_id", userId).limit(20000),
  ]);

  const failure =
    itemsRes.error ?? edgesRes.error ?? entitiesRes.error ?? entLinksRes.error ?? null;
  const items = itemsRes.data;
  const edges = edgesRes.data;
  const entities = entitiesRes.data;
  const entLinks = entLinksRes.data;

  // Machine-written summaries are not memories and are excluded from the graph
  // for the same reason they are excluded from edge derivation.
  const liveItems = (items ?? []).filter((i) => (i.source as string) !== "system");
  const itemIds = new Set(liveItems.map((i) => i.id as string));

  const nodes: GraphNodeData[] = liveItems.map((i) => ({
    id: i.id as string,
    label: (i.title as string) ?? "(untitled)",
    kind: "item",
    sub: (i.type as string) ?? "note",
    degree: 0,
    component: 0,
  }));

  const links: GraphLinkData[] = [];

  // An entity becomes a NODE when it is actually shared — an entity mentioned by
  // a single item adds a pendant node and no information, which is noise at the
  // exact scale where the graph is already sparse.
  const byEntity = new Map<string, string[]>();
  for (const l of entLinks ?? []) {
    const itemId = l.item_id as string;
    if (!itemIds.has(itemId)) continue;
    const arr = byEntity.get(l.entity_id as string) ?? [];
    arr.push(itemId);
    byEntity.set(l.entity_id as string, arr);
  }

  const entityById = new Map((entities ?? []).map((e) => [e.id as string, e]));
  const drawnEntities = new Set<string>();
  for (const [entityId, members] of byEntity) {
    const e = entityById.get(entityId);
    if (!e || members.length < 2) continue;
    drawnEntities.add(entityId);
    nodes.push({
      id: `entity:${entityId}`,
      label: e.name as string,
      kind: "entity",
      sub: (e.kind as string) ?? "other",
      degree: 0,
      component: 0,
    });
    for (const m of members) {
      links.push({
        source: `entity:${entityId}`,
        target: m,
        kind: `shared_${(e.kind as string) === "person" ? "person" : (e.kind as string) === "place" ? "place" : "org"}`,
        reason: `mentions ${e.name}`,
      });
    }
  }

  // Item↔item edges. An entity-derived edge is SKIPPED when its entity is drawn
  // as a node: the pair is already connected through that node, and drawing
  // both makes a triangle that says the same thing twice.
  for (const e of edges ?? []) {
    const src = e.src as string;
    const dst = e.dst as string;
    if (!itemIds.has(src) || !itemIds.has(dst)) continue;
    const via = e.entity_id as string | null;
    if (via && drawnEntities.has(via)) continue;
    links.push({
      source: src,
      target: dst,
      kind: (e.kind as string) ?? "similar",
      reason: (e.reason as string) ?? "",
    });
  }

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;

  const { component, largest } = labelComponents(
    nodes.map((n) => n.id),
    links
  );
  for (const n of nodes) n.component = component.get(n.id) ?? 0;

  const { count: suggested } = await admin
    .from("edges")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "suggested");

  return {
    nodes,
    links,
    largestComponentSize: largest,
    counts: {
      items: liveItems.length,
      entities: drawnEntities.size,
      links: links.length,
      suggested: suggested ?? 0,
    },
    error: failure ? failure.message : null,
  };
}
