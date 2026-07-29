import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import { EmptyState, PageHeader } from "../components/ui";
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
      <main className="obx-safe-x obx-pb-bar mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-4 md:px-8 md:pt-8">
        <PageHeader
          title="Graph"
          subtitle={`${nodes.length.toLocaleString()} nodes · ${edges.length.toLocaleString()} links between them`}
        />
        {nodes.length === 0 ? (
          <EmptyState
            glyph="◎"
            title="No active notes yet"
            body={
              <>
                Capture something, or activate items in{" "}
                <Link href="/imports" className="font-semibold text-accent-text">
                  Imports
                </Link>
                , and the links between them draw themselves.
              </>
            }
          />
        ) : (
          <Graph nodes={nodes} edges={edges} />
        )}
      </main>
    </>
  );
}
