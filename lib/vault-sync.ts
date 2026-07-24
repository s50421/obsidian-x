import type { SupabaseClient } from "@supabase/supabase-js";
import { writeVaultNote } from "@/lib/vault";

// v1.5 T5 — cross-store consistency. The DB is the single source of truth; the
// vault is a projection of it. Whenever an item's DB state changes in a way the
// vault should reflect (status → done/open, a ClickUp task gets linked), re-write
// its markdown from the current row. Best-effort: never throws into the caller.

type ItemRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  tags: string[] | null;
  priority: string;
  source: string;
  created_at: string;
  due_at: string | null;
  entities: { name: string; kind: string }[] | null;
  links: string[] | null;
  status: string;
  external: { clickup?: { url?: string } } | null;
  vault_path: string | null;
};

export async function reprojectItemToVault(
  admin: SupabaseClient,
  itemId: string
): Promise<void> {
  try {
    const { data } = await admin
      .from("items")
      .select(
        "id,type,title,body,tags,priority,source,created_at,due_at,entities,links,status,external,vault_path"
      )
      .eq("id", itemId)
      .maybeSingle();
    const item = data as ItemRow | null;
    if (!item || !item.vault_path) return; // only reproject notes that have a vault file

    // Resolve related-link titles (stored as ids on the item).
    let links: { id: string; title: string }[] = [];
    if (Array.isArray(item.links) && item.links.length) {
      const { data: linked } = await admin
        .from("items")
        .select("id,title")
        .in("id", item.links);
      links = (linked ?? []).map((l) => ({ id: l.id as string, title: l.title as string }));
    }

    await writeVaultNote({
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body ?? "",
      tags: item.tags ?? [],
      priority: item.priority,
      source: item.source,
      createdAt: item.created_at,
      dueAt: item.due_at,
      entities: item.entities ?? [],
      links,
      status: item.status,
      clickupUrl: item.external?.clickup?.url ?? null,
    });
  } catch {
    // projection is best-effort; the DB remains the source of truth
  }
}
