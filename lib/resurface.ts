import { createAdminClient } from "@/lib/supabase/admin";

// v3.3 — spaced resurfacing. Periodically bring an older note back to the
// owner's attention so insights don't rot. Picks reflective items (note / idea /
// reference / person) older than a cutoff that haven't been resurfaced before.
type Admin = ReturnType<typeof createAdminClient>;

export type Resurfaced = { id: string; title: string; type: string; snippet: string; createdAt: string };

const TYPES = ["note", "idea", "reference", "person"];

export async function pickResurface(admin: Admin, userId: string, count = 3, minAgeDays = 10): Promise<Resurfaced[]> {
  const { data: seenRows } = await admin
    .from("audit")
    .select("item_id")
    .eq("user_id", userId)
    .eq("action", "resurfaced");
  const seen = new Set((seenRows ?? []).map((r) => r.item_id).filter(Boolean) as string[]);

  const cutoff = new Date(Date.now() - minAgeDays * 86400 * 1000).toISOString();
  const { data: rows } = await admin
    .from("items")
    .select("id,title,body,type,created_at")
    .eq("user_id", userId)
    .neq("status", "archived")
    .is("valid_to", null)
    .neq("source", "apple-notes")
    .in("type", TYPES)
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(80);

  const pool = (rows ?? []).filter((r) => !seen.has(r.id));
  // Shuffle for variety (server runtime — Math.random is fine here).
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count).map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    snippet: (r.body ?? "").replace(/\s+/g, " ").slice(0, 140),
    createdAt: r.created_at,
  }));
}
