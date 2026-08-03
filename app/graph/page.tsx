import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { loadGraph } from "@/lib/graph-data";
import AppNav from "../components/AppNav";
import { EmptyState, PageHeader } from "../components/ui";
import GraphView from "./GraphView";

export const dynamic = "force-dynamic";

// The vault graph (graph-redesign-brief).
//
// Server component: it only loads data. Everything that touches a canvas or a
// physics simulation lives behind GraphView, which imports the renderer with
// `ssr: false` — the Next 16 docs are explicit that the option only works from
// inside a Client Component, and the v2.5 hydration bug is what happens if the
// layout runs on the server.
//
// Nodes are items AND canonical entities; edges are the TYPED edges, never raw
// `items.links` (purged 2026-08-02). Only CONFIRMED connections are drawn —
// suggestions are offered in the item inspector, because drawing a guess is
// most of why the old graph read as random.
export default async function GraphPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const data = await loadGraph(admin, user.id);

  const { items, entities, links, suggested } = data.counts;
  const subtitle =
    `${items.toLocaleString()} ${items === 1 ? "memory" : "memories"}` +
    (entities ? ` · ${entities} ${entities === 1 ? "person/place" : "people & places"}` : "") +
    ` · ${links.toLocaleString()} connection${links === 1 ? "" : "s"}` +
    (data.largestComponentSize > 1 ? ` · largest cluster ${data.largestComponentSize}` : "");

  return (
    <>
      <AppNav />
      <main className="obx-safe-x obx-pb-bar mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-4 md:px-8 md:pt-8">
        <PageHeader title="Graph" subtitle={subtitle} />
        {data.nodes.length === 0 ? (
          <EmptyState
            glyph="◎"
            title="No active notes yet"
            body={
              <>
                Capture something, or activate items in{" "}
                <Link href="/imports" className="font-semibold text-accent-text">
                  Imports
                </Link>
                , and the connections draw themselves.
              </>
            }
          />
        ) : links === 0 ? (
          <EmptyState
            glyph="◎"
            title="Nothing is connected yet"
            body={
              suggested > 0 ? (
                <>
                  There {suggested === 1 ? "is" : "are"} {suggested} suggested connection
                  {suggested === 1 ? "" : "s"} waiting in the{" "}
                  <Link href="/deck" className="font-semibold text-accent-text">
                    deck
                  </Link>
                  . Confirm one and it appears here — nothing is drawn that you haven&apos;t stood behind.
                </>
              ) : (
                <>Connections appear once two memories share a person, place or organisation.</>
              )
            }
          />
        ) : (
          <GraphView data={data} />
        )}
      </main>
    </>
  );
}
