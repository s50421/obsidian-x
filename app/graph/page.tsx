import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import { EmptyState, PageHeader } from "../components/ui";
import Graph from "./Graph";

export const dynamic = "force-dynamic";

// v2.3 — vault graph. The PWA computes + draws the note graph itself.
//
// Nodes are active items coloured by type. Edges come from the TYPED `edges`
// table (brain-quality Phase 2), not from `items.links` — that column was
// purged on 2026-08-02 along with the braindump-provenance links it held, and
// this page kept reading it, so the graph rendered "23 nodes · 0 links".
// Reading `edges` also means the graph shows the same connections, with the
// same reasons, as the item inspector.
export default async function GraphPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const [{ data }, { data: edgeRows }] = await Promise.all([
    admin
      .from("items")
      .select("id,title,type")
      .eq("user_id", user.id)
      .neq("status", "archived")
      .is("valid_to", null),
    admin
      .from("edges")
      .select("src,dst,kind,reason,discovery")
      .eq("user_id", user.id)
      .limit(5000),
  ]);

  const items = (data ?? []) as { id: string; title: string; type: string }[];
  const ids = new Set(items.map((i) => i.id));
  const nodes = items.map((i) => ({ id: i.id, title: i.title, type: i.type }));

  // One line per pair even when two kinds connect the same items — the strongest
  // wins the label, so hovering never shows "both tagged legal" on a line that
  // is really there because they share a person.
  const RANK: Record<string, number> = {
    shared_person: 4,
    shared_org: 3,
    shared_place: 3,
    shared_topic: 2,
    reference: 2,
    thread: 1,
    similar: 0,
  };
  const best = new Map<string, { source: string; target: string; kind: string; reason: string; discovery: boolean }>();
  for (const e of edgeRows ?? []) {
    const src = e.src as string;
    const dst = e.dst as string;
    if (!ids.has(src) || !ids.has(dst)) continue;
    const key = [src, dst].sort().join("|");
    const prev = best.get(key);
    const rank = RANK[e.kind as string] ?? 0;
    if (prev && (RANK[prev.kind] ?? 0) >= rank) continue;
    best.set(key, {
      source: src,
      target: dst,
      kind: e.kind as string,
      reason: (e.reason as string) ?? "",
      discovery: !!e.discovery,
    });
  }
  const edges = [...best.values()];

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
