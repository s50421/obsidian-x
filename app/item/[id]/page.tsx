import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { connectionsFor } from "@/lib/edges";
import AppNav from "../../components/AppNav";
import { CARD, CARD_INSET, PageHeader, PageMain, SectionLabel, TypeChip } from "../../components/ui";
import ItemEditor, { type EditableItem } from "./ItemEditor";

export const dynamic = "force-dynamic";

// One memory, in full.
//
// This is what "open a node" should land on. Before it existed, clicking a node
// in the graph offered "Open in the deck", which the owner rightly called
// nonsense — the deck is a daily review sweep, not a place to look something up.
//
// Next 16: `params` is a Promise and must be awaited.
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const { data: item } = await admin
    .from("items")
    .select("id,title,body,raw,type,tags,priority,status,source,due_at,created_at,updated_at,entities,external,confidence,needs_review,review_reason,junk_score")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!item) notFound();

  const [connections, { data: audit }] = await Promise.all([
    connectionsFor(admin, user.id, id),
    admin
      .from("audit")
      .select("action,actor,created_at")
      .eq("user_id", user.id)
      .eq("item_id", id)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const editable: EditableItem = {
    id: item.id as string,
    title: (item.title as string) ?? "",
    body: (item.body as string) ?? "",
    type: (item.type as string) ?? "note",
    tags: (item.tags as string[]) ?? [],
    priority: (item.priority as string) ?? null,
    status: (item.status as string) ?? "open",
    due_at: (item.due_at as string) ?? null,
  };

  const clickup = (item.external as { clickup?: { url?: string } } | null)?.clickup?.url ?? null;
  const rawDiffers = !!item.raw && (item.raw as string).trim() !== (item.body as string).trim();
  const linked = connections.filter((c) => c.status !== "suggested");
  const suggested = connections.filter((c) => c.status === "suggested");

  return (
    <>
      <AppNav />
      <PageMain>
        <PageHeader
          title={(item.title as string) ?? "(untitled)"}
          subtitle={
            <>
              <TypeChip type={editable.type} /> · captured {new Date(item.created_at as string).toLocaleDateString()} from{" "}
              {item.source as string} ·{" "}
              <Link href="/library" className="font-semibold text-accent-text">
                all memories
              </Link>
            </>
          }
        />

        <div className="flex flex-col gap-7">
          <section className={`p-5 ${CARD}`}>
            <SectionLabel className="mb-3">Edit</SectionLabel>
            <ItemEditor item={editable} />
          </section>

          {rawDiffers && (
            <section className={`p-5 ${CARD}`}>
              <SectionLabel className="mb-2">Exactly as it arrived</SectionLabel>
              <p className={`${CARD_INSET} whitespace-pre-wrap p-3 text-[13px] leading-relaxed text-ink-2`}>
                {item.raw as string}
              </p>
            </section>
          )}

          <section className={`p-5 ${CARD}`}>
            <SectionLabel className="mb-2">Connections</SectionLabel>
            {linked.length === 0 && suggested.length === 0 ? (
              <p className="text-[13px] text-ink-3">
                Nothing connected yet.{" "}
                <Link href="/connections" className="font-semibold text-accent-text">
                  Connect it to something
                </Link>
                .
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {linked.map((c) => (
                  <Link
                    key={c.edgeId}
                    href={`/item/${c.otherId}`}
                    className={`${CARD_INSET} flex items-start gap-2 px-3 py-2.5 hover:bg-white/[0.05]`}
                  >
                    <TypeChip type={c.otherType} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{c.otherTitle}</span>
                      <span className="mt-0.5 block text-xs text-ink-3">{c.reason}</span>
                    </span>
                  </Link>
                ))}
                {suggested.length > 0 && (
                  <p className="pt-1 text-xs text-ink-3">
                    {suggested.length} suggested —{" "}
                    <Link href="/connections" className="font-semibold text-accent-text">
                      review in Connections
                    </Link>
                  </p>
                )}
              </div>
            )}
          </section>

          <section className={`p-5 ${CARD}`}>
            <SectionLabel className="mb-2">Provenance</SectionLabel>
            <div className={`${CARD_INSET} px-3.5 py-2 text-[13px]`}>
              <Row label="Source">{item.source as string}</Row>
              <Row label="Captured">{new Date(item.created_at as string).toLocaleString()}</Row>
              {item.confidence != null && <Row label="Confidence">{String(item.confidence)}</Row>}
              {item.junk_score != null && <Row label="Junk score">{String(item.junk_score)}/10</Row>}
              {clickup && (
                <Row label="ClickUp">
                  <a href={clickup} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
                    open task ↗
                  </a>
                </Row>
              )}
              {((item.entities as { name: string }[]) ?? []).length > 0 && (
                <Row label="Mentions">
                  {((item.entities as { name: string }[]) ?? []).map((e) => e.name).join(", ")}
                </Row>
              )}
            </div>
            {(audit ?? []).length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {(audit ?? []).map((a, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3 text-xs text-ink-3">
                    <span>{(a.action as string).replace(/_/g, " ")}</span>
                    <span>
                      {a.actor as string} · {new Date(a.created_at as string).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </PageMain>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-hairline py-1.5 last:border-0">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 text-right text-ink-2">{children}</span>
    </div>
  );
}
