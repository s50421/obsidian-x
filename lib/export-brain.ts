import { createAdminClient } from "@/lib/supabase/admin";

// v3.4 — export the brain as portable JSON (no lock-in). Embeddings are omitted
// (large + regenerable); everything else that defines an item is included.
type Admin = ReturnType<typeof createAdminClient>;

const FIELDS =
  "id,type,title,body,raw,status,priority,tags,source,due_at,created_at,updated_at," +
  "valid_from,valid_to,confidence,needs_review,review_reason,entities,links,external," +
  "vault_path,sensitive,superseded_by";

export type BrainExport = {
  app: "obsidian-x";
  exported_at: string;
  item_count: number;
  items: Record<string, unknown>[];
};

export async function exportBrain(admin: Admin, userId: string): Promise<BrainExport> {
  const items: Record<string, unknown>[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await admin
      .from("items")
      .select(FIELDS)
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`export failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    items.push(...rows);
    if (rows.length < page) break;
  }
  return {
    app: "obsidian-x",
    exported_at: new Date().toISOString(),
    item_count: items.length,
    items,
  };
}
