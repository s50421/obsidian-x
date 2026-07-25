import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import { SectionLabel, TYPE_HUE, TYPE_SOLID } from "../components/ui";

export const dynamic = "force-dynamic";

type Item = { source: string; status: string; needs_review: boolean; sensitive: boolean; type: string };
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
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const TYPE_ORDER = ["note", "task", "idea", "shopping", "reference", "person", "event"];

export default async function OpsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const uid = user.id;

  const [itemsRes, usageRes, auditRes] = await Promise.all([
    admin.from("items").select("source,status,needs_review,sensitive,type").eq("user_id", uid),
    admin.from("llm_usage").select("operation,cost_usd,total_tokens,created_at").eq("user_id", uid),
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
  const openTasks = active.filter((i) => i.type === "task" && i.status === "open").length;

  const byType = TYPE_ORDER.map((t) => ({ type: t, n: active.filter((i) => i.type === t).length })).filter(
    (r) => r.n > 0
  );
  const maxType = Math.max(1, ...byType.map((r) => r.n));

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const sum = (rows: UsageRow[], f: (r: UsageRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const cost = (r: UsageRow) => Number(r.cost_usd) || 0;
  const toks = (r: UsageRow) => Number(r.total_tokens) || 0;
  const today = usage.filter((r) => new Date(r.created_at) >= startToday);
  const byOp: Record<string, number> = {};
  for (const r of usage) byOp[r.operation] = (byOp[r.operation] ?? 0) + cost(r);

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-28 pt-3 md:px-8 md:pb-12 md:pt-8">
        <div className="mb-5 md:mb-6">
          <h1 className="text-[28px] font-bold tracking-[-0.022em] md:text-[22px]">Ops</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">Read-only</p>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <Stat value={active.length.toLocaleString()} label="items active" />
          <Stat value={openTasks.toLocaleString()} label="open tasks" />
          <Stat value={money(sum(usage, cost))} label="LLM spend · all-time" />
          <Stat value={usage.length.toLocaleString()} label="LLM calls" />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface-1 p-5">
            <SectionLabel>By type</SectionLabel>
            {byType.length === 0 ? (
              <p className="text-sm text-ink-2">No active items yet.</p>
            ) : (
              byType.map((r) => (
                <div key={r.type} className="flex items-center gap-2.5">
                  <span className="w-16 text-[13px]" style={{ color: TYPE_HUE[r.type] }}>
                    {r.type}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(r.n / maxType) * 100}%`, background: TYPE_SOLID[r.type] }}
                    />
                  </div>
                  <span className="w-10 text-right text-[13px] text-ink-2">{r.n}</span>
                </div>
              ))
            )}
          </div>

          <div className="overflow-hidden rounded-card border border-hairline bg-surface-1">
            <div className="px-5 pb-2.5 pt-5">
              <SectionLabel>Recent activity</SectionLabel>
            </div>
            {audit.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-ink-2">No activity logged yet.</p>
            ) : (
              audit.map((a, i) => (
                <div key={i} className={`flex items-center gap-2.5 px-5 py-3 ${i > 0 ? "border-t border-hairline" : ""}`}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "#96b2ff" }} />
                  <div className="flex-1 truncate text-[13px]">
                    <span className="font-medium">{a.action}</span>{" "}
                    <span className="text-ink-3">· {a.actor}</span>
                  </div>
                  <span className="text-xs text-ink-3">{ago(a.created_at)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-4 rounded-card border border-hairline bg-surface-1 p-5">
          <SectionLabel className="mb-2.5">Spend detail</SectionLabel>
          <div className="grid grid-cols-2 gap-2.5 text-[13px] md:grid-cols-4">
            <MiniStat value={money(sum(today, cost))} label="today" />
            <MiniStat value={sum(today, toks).toLocaleString()} label="today tokens" />
            <MiniStat value={active.filter((i) => i.needs_review).length.toString()} label="needs review" />
            <MiniStat value={active.filter((i) => i.sensitive).length.toString()} label="private" />
          </div>
          {Object.keys(byOp).length > 0 && (
            <p className="mt-3 text-xs text-ink-3">
              by operation:{" "}
              {Object.entries(byOp)
                .map(([op, c]) => `${op} ${money(c)}`)
                .join(" · ")}
            </p>
          )}
        </div>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-card border border-hairline bg-surface-1 p-4">
      <div className="text-[26px] font-bold tracking-[-0.02em] tabular-nums">{value}</div>
      <div className="mt-0.5 text-[13px] text-ink-2">{label}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[17px] font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}
