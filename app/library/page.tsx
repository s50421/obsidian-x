import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import { CARD, CARD_LIST, EmptyState, PageHeader, PageMain, SectionLabel, TypeChip } from "../components/ui";

export const dynamic = "force-dynamic";

// Every memory, browsable — and the answer to "I want to look at my shopping
// list". A type is a list: /library?type=shopping IS the shopping list.
//
// The deck shows you today's arrivals once; this is the place you come back to.
export default async function LibraryPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise, like params.
  searchParams: Promise<{ type?: string; q?: string; status?: string }>;
}) {
  const { type, q, status } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  let query = admin
    .from("items")
    .select("id,title,type,tags,status,priority,due_at,created_at")
    .eq("user_id", user.id)
    .is("valid_to", null)
    .order("created_at", { ascending: false })
    .limit(500);

  // Archived is opt-in: the default view is the brain you actually use.
  if (status === "archived") query = query.eq("status", "archived");
  else if (status === "done") query = query.eq("status", "done");
  else query = query.neq("status", "archived");

  if (type) query = query.eq("type", type);
  if (q?.trim()) query = query.ilike("title", `%${q.trim()}%`);

  const { data } = await query;
  const items = data ?? [];

  const { data: allForCounts } = await admin
    .from("items")
    .select("type")
    .eq("user_id", user.id)
    .neq("status", "archived")
    .is("valid_to", null)
    .limit(5000);
  const counts: Record<string, number> = {};
  for (const i of allForCounts ?? []) counts[i.type as string] = (counts[i.type as string] ?? 0) + 1;
  const types = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  const chip = (label: string, href: string, on: boolean, n?: number) => (
    <Link
      key={href}
      href={href}
      className="inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-[12px] transition-colors"
      style={{
        borderColor: on ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)",
        color: on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.45)",
        background: on ? "rgba(255,255,255,0.06)" : "transparent",
      }}
    >
      {label}
      {n != null && <span className="tabular-nums opacity-60">{n}</span>}
    </Link>
  );

  const base = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { type, q, status, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/library?${s}` : "/library";
  };

  return (
    <>
      <AppNav />
      <PageMain>
        <PageHeader
          title={type ? `${type[0].toUpperCase()}${type.slice(1)}` : "Library"}
          subtitle={`${items.length} ${items.length === 1 ? "memory" : "memories"}${type ? "" : " across every type"}`}
        />

        <div className="mb-5 flex flex-col gap-2.5">
          <form action="/library" className="flex gap-2">
            {type && <input type="hidden" name="type" value={type} />}
            {status && <input type="hidden" name="status" value={status} />}
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search titles…"
              className="min-w-0 flex-1 rounded-control border border-hairline bg-surface-1 px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </form>
          <div className="flex flex-wrap gap-1.5">
            {chip("all", base({ type: undefined }), !type)}
            {types.map(([t, n]) => chip(t, base({ type: t }), type === t, n))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {chip("active", base({ status: undefined }), !status)}
            {chip("done", base({ status: "done" }), status === "done")}
            {chip("archived", base({ status: "archived" }), status === "archived")}
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState glyph="◎" title="Nothing here" body="Try a different type, or clear the search." />
        ) : (
          <div className={CARD_LIST}>
            {items.map((i, idx) => (
              <Link
                key={i.id as string}
                href={`/item/${i.id}`}
                className={`flex min-h-12 items-center gap-2.5 px-4 py-3 hover:bg-white/[0.04] ${idx > 0 ? "border-t border-hairline" : ""}`}
              >
                <TypeChip type={i.type as string} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{(i.title as string) ?? "(untitled)"}</span>
                  {((i.tags as string[]) ?? []).length > 0 && (
                    <span className="mt-0.5 block truncate text-xs text-ink-3">
                      {((i.tags as string[]) ?? []).map((t) => `#${t}`).join(" ")}
                    </span>
                  )}
                </span>
                {i.due_at && (
                  <span className="shrink-0 text-xs text-ink-3">
                    {new Date(i.due_at as string).toLocaleDateString()}
                  </span>
                )}
                {i.status === "done" && <span className="shrink-0 text-xs text-ink-3">done</span>}
              </Link>
            ))}
          </div>
        )}

        <p className={`mt-5 p-4 text-[13px] leading-relaxed text-ink-3 ${CARD}`}>
          A type is a list — <Link href="/library?type=shopping" className="font-semibold text-accent-text">your shopping list</Link>{" "}
          is just the shopping memories. Tap any row to see it in full and edit it.
        </p>
      </PageMain>
    </>
  );
}
