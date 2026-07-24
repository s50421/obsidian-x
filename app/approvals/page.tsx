import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
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

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "bg-black/10 opacity-60 dark:bg-white/10",
};

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
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
        <Link
          href="/"
          className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
        >
          ← Home
        </Link>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
          Pending ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm opacity-60">Nothing waiting on you.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.title ?? "(untitled)"}</div>
                  <div className="text-xs opacity-60">
                    {p.kind} · from {p.source ?? "?"} · {ago(p.created_at)}
                  </div>
                </div>
                <ApprovalButtons id={p.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
          History
        </h2>
        {decided.length === 0 ? (
          <p className="text-sm opacity-60">No decisions yet.</p>
        ) : (
          <ul className="divide-y divide-black/10 text-sm dark:divide-white/10">
            {decided.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">
                  {p.result?.url ? (
                    <a
                      href={p.result.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline decoration-dotted underline-offset-2"
                    >
                      {p.title ?? "(untitled)"}
                    </a>
                  ) : (
                    <span className="font-medium">{p.title ?? "(untitled)"}</span>
                  )}{" "}
                  <span className="opacity-50">· {p.kind}</span>
                </span>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_STYLE[p.status] ?? ""}`}
                >
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
