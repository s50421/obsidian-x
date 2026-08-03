import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import { PageHeader, PageMain } from "../components/ui";
import ConnectionsEditor, { type EditorEdge, type EditorItem } from "./ConnectionsEditor";

export const dynamic = "force-dynamic";

// Where connections are actually WORKED ON.
//
// The graph is a good way to look at connections and a poor way to edit them —
// hit-testing a small circle with a thumb is fiddly, and the owner reported not
// being able to click a node at all. This page is ordinary DOM, so it works
// regardless of what the canvas is doing, and it is the only place a connection
// can be made by hand.
export default async function ConnectionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const [{ data: items }, { data: edges }] = await Promise.all([
    admin
      .from("items")
      .select("id,title,type")
      .eq("user_id", user.id)
      .neq("status", "archived")
      .is("valid_to", null)
      .order("created_at", { ascending: false })
      .limit(2000),
    admin
      .from("edges")
      .select("id,src,dst,kind,reason,status,weight")
      .eq("user_id", user.id)
      .neq("status", "dismissed")
      .order("weight", { ascending: false })
      .limit(2000),
  ]);

  const list = (items ?? []) as EditorItem[];
  const known = new Set(list.map((i) => i.id));
  // An edge pointing at an archived or deleted item would render as
  // "(unknown)" — drop it rather than show a broken row.
  const all = ((edges ?? []) as EditorEdge[]).filter((e) => known.has(e.src) && known.has(e.dst));

  const confirmed = all.filter((e) => e.status === "confirmed");
  const suggested = all.filter((e) => e.status === "suggested");

  return (
    <>
      <AppNav />
      <PageMain>
        <PageHeader
          title="Connections"
          subtitle={
            <>
              {confirmed.length} drawn · {suggested.length} suggested · see them laid out in the{" "}
              <Link href="/graph" className="font-semibold text-accent-text">
                graph
              </Link>
            </>
          }
        />
        <ConnectionsEditor items={list} confirmed={confirmed} suggested={suggested} />
      </PageMain>
    </>
  );
}
