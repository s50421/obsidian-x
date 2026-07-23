import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

type Item = { source: string; status: string; needs_review: boolean; sensitive: boolean };
type UsageRow = {
  operation: string;
  cost_usd: number | null;
  total_tokens: number | null;
  created_at: string;
};
type AuditRow = {
  action: string;
  actor: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

function money(n: number): string {
  return "$" + n.toFixed(4);
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function OpsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const uid = user.id;

  const [itemsRes, usageRes, auditRes] = await Promise.all([
    admin.from("items").select("source,status,needs_review,sensitive").eq("user_id", uid),
    admin
      .from("llm_usage")
      .select("operation,cost_usd,total_tokens,created_at")
      .eq("user_id", uid),
    admin
      .from("audit")
      .select("action,actor,detail,created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const items = (itemsRes.data ?? []) as Item[];
  const usage = (usageRes.data ?? []) as UsageRow[];
  const audit = (auditRes.data ?? []) as AuditRow[];

  const active = items.filter((i) => i.status !== "archived");
  const bySource = (s: string) => active.filter((i) => i.source === s).length;
  const needsReview = active.filter((i) => i.needs_review).length;
  const sensitive = active.filter((i) => i.sensitive).length;

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const sum = (rows: UsageRow[], f: (r: UsageRow) => number) =>
    rows.reduce((a, r) => a + f(r), 0);
  const cost = (r: UsageRow) => Number(r.cost_usd) || 0;
  const toks = (r: UsageRow) => Number(r.total_tokens) || 0;
  const today = usage.filter((r) => new Date(r.created_at) >= startToday);
  const byOp: Record<string, number> = {};
  for (const r of usage) byOp[r.operation] = (byOp[r.operation] ?? 0) + cost(r);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Ops</h1>
        <Link
          href="/"
          className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
        >
          ← Home
        </Link>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
          Notes
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="active" value={active.length} />
          <Stat label="typed" value={bySource("typed")} />
          <Stat label="email" value={bySource("email")} />
          <Stat label="review" value={needsReview} />
          <Stat label="private" value={sensitive} />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
          LLM spend
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="today" value={money(sum(today, cost))} />
          <Stat label="all-time" value={money(sum(usage, cost))} />
          <Stat label="today tokens" value={sum(today, toks).toLocaleString()} />
          <Stat label="calls" value={usage.length} />
        </div>
        {Object.keys(byOp).length > 0 && (
          <div className="mt-2 text-xs opacity-70">
            by operation:{" "}
            {Object.entries(byOp)
              .map(([op, c]) => `${op} ${money(c)}`)
              .join(" · ")}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
          Recent activity
        </h2>
        {audit.length === 0 ? (
          <p className="text-sm opacity-60">No activity logged yet.</p>
        ) : (
          <ul className="divide-y divide-black/10 text-sm dark:divide-white/10">
            {audit.map((a, i) => (
              <li key={i} className="flex items-center justify-between py-2">
                <span>
                  <span className="font-medium">{a.action}</span>{" "}
                  <span className="opacity-50">· {a.actor}</span>
                </span>
                <span className="text-xs opacity-50">{ago(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-black/10 p-3 dark:border-white/15">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs opacity-60">{label}</div>
    </div>
  );
}
