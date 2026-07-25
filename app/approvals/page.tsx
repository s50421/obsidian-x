import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import { SectionLabel, TypeChip } from "../components/ui";
import ApprovalButtons from "./ApprovalButtons";

export const dynamic = "force-dynamic";

type Proposal = {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  source: string | null;
  result: { url?: string } | null;
  created_at: string;
  decided_at: string | null;
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function ApprovalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const { data } = await admin
    .from("proposals")
    .select("id,kind,status,title,source,result,created_at,decided_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const proposals = (data ?? []) as Proposal[];
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-28 pt-3 md:px-8 md:pb-12 md:pt-8">
        <div className="mb-5 md:hidden">
          <h1 className="text-[28px] font-bold tracking-[-0.022em]">Approvals</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">{pending.length} proposed tasks waiting</p>
        </div>

        <div className="grid grid-cols-1 gap-7 md:grid-cols-[1fr_340px] md:items-start">
          <section className="flex flex-col gap-3">
            <SectionLabel className="px-1">Pending</SectionLabel>
            {pending.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline-2 p-7 text-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-control bg-white/[0.06] text-ink-3">✓</div>
                <div className="text-[15px] font-semibold">Nothing waiting on you</div>
                <div className="text-[13px] text-ink-2">Proposed tasks will land here.</div>
              </div>
            ) : (
              pending.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col gap-3 rounded-card border border-hairline bg-surface-1 p-4 md:flex-row md:items-center md:gap-5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <TypeChip type="task" />
                    <div className="text-[16px] font-semibold leading-snug">{p.title ?? "(untitled)"}</div>
                    <div className="text-[13px] text-ink-2">
                      {p.kind} · from {p.source ?? "?"} · {ago(p.created_at)}
                    </div>
                  </div>
                  <ApprovalButtons id={p.id} />
                </div>
              ))
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionLabel className="px-1">History</SectionLabel>
            {decided.length === 0 ? (
              <p className="px-1 text-sm text-ink-2">No decisions yet.</p>
            ) : (
              <div className="overflow-hidden rounded-card border border-hairline bg-surface-1">
                {decided.map((p, idx) => (
                  <div
                    key={p.id}
                    className={`flex items-center gap-2.5 p-4 ${idx > 0 ? "border-t border-hairline" : ""}`}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: p.status === "approved" ? "#93d8a8" : "rgba(255,255,255,0.3)" }}
                    />
                    <div className="min-w-0 flex-1 truncate text-sm">
                      {p.result?.url ? (
                        <a href={p.result.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:text-accent-text">
                          {p.title ?? "(untitled)"}
                        </a>
                      ) : (
                        <span className="font-medium">{p.title ?? "(untitled)"}</span>
                      )}{" "}
                      <span className="text-xs text-ink-3">
                        · {p.status}
                        {p.decided_at ? ` ${ago(p.decided_at)}` : ""}
                      </span>
                    </div>
                    {p.result?.url && (
                      <a href={p.result.url} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-accent-text">
                        ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
