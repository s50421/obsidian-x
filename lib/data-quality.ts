import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataQualityStats } from "@/app/ops/DataQuality";
import { CONFIDENCE_BAR } from "@/lib/title-standard.mjs";

// Brain-quality Phase 2 — straight counts, no derived cleverness.
//
// Same rule as the scorecard: no fake numbers. Every figure is a count from a
// live table, so a zero here means zero, not "not measured".

export async function buildDataQuality(
  admin: SupabaseClient,
  userId: string
): Promise<DataQualityStats> {
  const [items, entities, edges, merges] = await Promise.all([
    admin
      .from("items")
      .select("id,links,confidence")
      .eq("user_id", userId)
      .neq("status", "archived")
      .is("valid_to", null)
      .limit(5000),
    admin.from("entities").select("id,needs_review").eq("user_id", userId).limit(5000),
    admin.from("edges").select("kind").eq("user_id", userId).limit(20000),
    admin
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("kind", "entity_merge")
      .eq("status", "pending"),
  ]);

  const itemRows = items.data ?? [];
  const ids = itemRows.map((i) => i.id as string);

  // Distinct items that resolved to at least one canonical entity.
  let itemsWithEntities = 0;
  if (ids.length) {
    const { data: links } = await admin
      .from("item_entities")
      .select("item_id")
      .eq("user_id", userId)
      .in("item_id", ids);
    itemsWithEntities = new Set((links ?? []).map((l) => l.item_id as string)).size;
  }

  const edgesByKind: Record<string, number> = {};
  for (const e of edges.data ?? []) {
    const k = e.kind as string;
    edgesByKind[k] = (edgesByKind[k] ?? 0) + 1;
  }

  return {
    items: itemRows.length,
    itemsWithEntities,
    entities: (entities.data ?? []).length,
    entitiesNeedingReview: (entities.data ?? []).filter((e) => e.needs_review).length,
    edgesByKind,
    legacyLinks: itemRows.reduce((n, i) => n + ((i.links as string[] | null)?.length ?? 0), 0),
    lowConfidence: itemRows.filter(
      (i) => i.confidence != null && Number(i.confidence) < CONFIDENCE_BAR
    ).length,
    pendingMerges: merges.count ?? 0,
  };
}
