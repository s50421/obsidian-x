import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import Graph from "./Graph";

export const dynamic = "force-dynamic";

// v2.3 — vault graph. The PWA computes + draws the note graph itself (nodes =
// active items coloured by type, edges = the auto-links stored on each item).
export default async function GraphPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const { data } = await admin
    .from("items")
    .select("id,title,type,links")
    .eq("user_id", user.id)
    .neq("status", "archived")
    .is("valid_to", null);

  const items = (data ?? []) as { id: string; title: string; type: string; links: string[] | null }[];
  const ids = new Set(items.map((i) => i.id));
  const nodes = items.map((i) => ({ id: i.id, title: i.title, type: i.type }));

  const seen = new Set<string>();
  const edges: { source: string; target: string }[] = [];
  for (const it of items) {
    for (const l of it.links ?? []) {
      if (!ids.has(l)) continue;
      const key = [it.id, l].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: it.id, target: l });
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:py-10">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Graph</h1>
          <p className="text-xs opacity-60">
            {nodes.length} notes · {edges.length} links
          </p>
        </div>
        <Link
          href="/"
          className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
        >
          ← Home
        </Link>
      </header>
      {nodes.length === 0 ? (
        <p className="py-16 text-center text-sm opacity-60">
          No active notes yet — activate some in <Link href="/imports" className="underline">Imports</Link> to see your graph fill in.
        </p>
      ) : (
        <Graph nodes={nodes} edges={edges} />
      )}
    </main>
  );
}
