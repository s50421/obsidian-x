import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
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
    <>
      <AppNav />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-28 pt-3 md:px-8 md:pb-12 md:pt-8">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[28px] font-bold tracking-[-0.022em] md:text-[22px]">Graph</h1>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {nodes.length} nodes · {edges.length} links
            </p>
          </div>
        </div>
        {nodes.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline-2 p-12 text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-control bg-white/[0.06] text-ink-3">◎</div>
            <div className="text-[15px] font-semibold">No active notes yet</div>
            <div className="text-[13px] text-ink-2">
              Activate some in{" "}
              <Link href="/imports" className="text-accent-text">
                Imports
              </Link>{" "}
              to see your graph fill in.
            </div>
          </div>
        ) : (
          <Graph nodes={nodes} edges={edges} />
        )}
      </main>
    </>
  );
}
