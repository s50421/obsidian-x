import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import {
  BTN_SECONDARY,
  CARD,
  CARD_LIST,
  EmptyState,
  PageHeader,
  PageMain,
  SectionLabel,
  TYPE_HUE,
  TYPE_SOLID,
} from "../components/ui";
import Coverage from "./Coverage";
import MailTuning, { type InflowRow } from "./MailTuning";
import Scorecard from "./Scorecard";
import DataQuality from "./DataQuality";
import { buildDataQuality } from "@/lib/data-quality";
import Corrections from "./Corrections";
import { buildCorrectionReport } from "@/lib/corrections";
import LinkLearning from "./LinkLearning";
import { loadModel } from "@/lib/link-model";
import AgentCost, { type AgentTurnStat } from "./AgentCost";
import { buildScorecard } from "@/lib/scorecard";
import {
  ensureDeclaredSources,
  loadSourceStatus,
  type SourceStatusRow,
} from "@/lib/source-status";
import { appConfigured, googleConfigured, loadAccounts } from "@/lib/google-auth";
import { MIN_CONFIDENCE, SURFACE_THRESHOLD } from "@/lib/rank-mail";

export const dynamic = "force-dynamic";

// v4.0 W6 — Ops is the coverage/insight surface: what the brain holds, where it
// came from, what it cost, what just happened. Read-only and one round of
// queries, so it stays fast enough to open casually.
//
// The Sources card is the seed of the v4.1 inflow monitor: every capture source
// with its all-time count and how much of it arrived in the last 24h. Today it
// reports what *did* arrive; v4.1 turns that into what *should* have arrived.

type Item = {
  source: string;
  status: string;
  needs_review: boolean;
  sensitive: boolean;
  type: string;
  created_at: string;
};
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

// Wrapped rather than inlined into the component body: this page is a server
// component that re-runs per request, but the react-hooks purity rule (rightly)
// objects to Date.now() sitting in a render body.
function last24hCutoff(): number {
  return Date.now() - 24 * 3600 * 1000;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const TYPE_ORDER = ["note", "task", "idea", "shopping", "reference", "person", "event"];

// Friendly names for the sources the pipeline writes. Anything unknown falls
// through as its raw slug rather than being hidden — an unnamed source is still
// a source, and silently dropping one would break the coverage story.
const SOURCE_LABEL: Record<string, string> = {
  web: "Web capture",
  telegram: "Telegram",
  email: "Email",
  voice: "Voice note",
  upload: "File upload",
  share: "Share sheet",
  shortcut: "iOS Shortcut",
  "apple-notes": "Apple Notes import",
  "chatgpt-profile": "ChatGPT profile",
  system: "System",
};

// Humanises the audit action slugs (review_approve → Review approve).
function actionLabel(a: string): string {
  const s = a.replace(/[_.]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default async function OpsPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // The Google OAuth callback redirects back here with its outcome. Rendering
  // it matters: a failure that only lives in the query string reads to the
  // owner as "the button did nothing".
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const googleResult = one(sp.google) ?? null;
  const googleDetail = one(sp.detail) ?? null;
  const googleMailbox = one(sp.mailbox) ?? null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const uid = user.id;

  // v4.1 — make sure every declared source has a row before rendering, so the
  // panel shows the full declared set from the very first visit (a source that
  // has never synced reads as "not connected", never as absent).
  await ensureDeclaredSources(admin, uid);

  const [itemsRes, usageRes, auditRes] = await Promise.all([
    admin.from("items").select("source,status,needs_review,sensitive,type,created_at").eq("user_id", uid),
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

  // Sources — all-time inflow per capture source, plus the trailing 24h.
  const dayAgo = last24hCutoff();
  const sourceMap = new Map<string, { total: number; recent: number }>();
  for (const i of items) {
    const key = i.source || "unknown";
    const row = sourceMap.get(key) ?? { total: 0, recent: 0 };
    row.total += 1;
    if (new Date(i.created_at).getTime() >= dayAgo) row.recent += 1;
    sourceMap.set(key, row);
  }
  const sources = [...sourceMap.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.total - a.total);
  const maxSource = Math.max(1, ...sources.map((s) => s.total));
  const recent24h = sources.reduce((a, s) => a + s.recent, 0);

  // v4.1 coverage + mail-ranking data.
  const [statusRows, accounts, surfacedRes, recentInflowRes] = await Promise.all([
    loadSourceStatus(admin, uid) as Promise<SourceStatusRow[]>,
    loadAccounts(admin, uid),
    // Confidence lives inside a jsonb blob, and a PostgREST `->>` filter would
    // compare it as TEXT — lexicographic, not numeric. Fetch the high scorers
    // and split them on confidence here, where the comparison is a real number.
    admin
      .from("inflow_events")
      .select("id,subject,sender,ts,ranked_score,ranked_reason,state,item_id")
      .eq("user_id", uid)
      .gte("ranked_score", SURFACE_THRESHOLD)
      .order("ts", { ascending: false })
      .limit(60),
    admin
      .from("inflow_events")
      .select("id,subject,sender,ts,ranked_score,ranked_reason,state,item_id")
      .eq("user_id", uid)
      .order("ts", { ascending: false })
      .limit(15),
  ]);
  const lowConfidence = ((surfacedRes.data ?? []) as InflowRow[])
    .filter((r) => Number(r.ranked_reason?.confidence ?? 0) < MIN_CONFIDENCE)
    .slice(0, 10);
  const recentInflow = (recentInflowRes.data ?? []) as InflowRow[];
  const nowMs = Date.now();

  // v4.2 C — the vision's 8 KPIs, computed from real signals where they exist.
  const kpis = await buildScorecard(admin, uid);

  // Brain-quality Phase 2 — is the structure under the product sound?
  const dq = await buildDataQuality(admin, uid);
  // Brain-quality Phase 2 item 5 — tune the prompt against real mistakes.
  const corrections = await buildCorrectionReport(admin, uid);
  const linkModel = await loadModel(admin, uid);

  // v4.2.3 — agent turn cost. Read from the audit rows the loop writes, which
  // carry the step count and tool names the raw llm_usage row cannot.
  const { data: agentRows } = await admin
    .from("audit")
    .select("detail,created_at")
    .eq("user_id", uid)
    .eq("action", "agent_turn")
    .order("created_at", { ascending: false })
    .limit(30);
  const agentTurns: AgentTurnStat[] = (agentRows ?? []).map((r) => {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    return {
      cost_usd: typeof d.cost_usd === "number" ? d.cost_usd : 0,
      steps: typeof d.steps === "number" ? d.steps : 0,
      tools: Array.isArray(d.tools) ? (d.tools as string[]) : [],
      at: r.created_at as string,
      timedOut: d.timedOut === true,
    };
  });

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
      <PageMain>
        <PageHeader
          title="Ops"
          subtitle="Read-only. What the brain holds, and what it cost."
          action={
            <a href="/api/export" download className={`${BTN_SECONDARY} px-4 text-[13px]`}>
              ⭳ Export brain
            </a>
          }
        />

        <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <Stat value={active.length.toLocaleString()} label="items active" />
          <Stat value={openTasks.toLocaleString()} label="open tasks" />
          <Stat value={recent24h.toLocaleString()} label="new · last 24h" />
          <Stat value={money(sum(usage, cost))} label="LLM spend · all-time" />
        </div>

        {googleResult && (
          <div
            className={`mb-4 rounded-card border px-4 py-3 text-[13px] leading-relaxed ${
              googleResult === "connected"
                ? "border-hairline bg-white/[0.04] text-ink"
                : "border-danger/30 bg-danger/10 text-danger"
            }`}
            role="status"
          >
            {googleResult === "connected" ? (
              <>
                <span className="font-semibold">Gmail connected</span>
                {googleMailbox && <> — {googleMailbox}</>}. The first sync runs on the next cron tick.
              </>
            ) : (
              <>
                <span className="font-semibold">Gmail connection failed</span>
                {googleDetail && <> — {googleDetail}</>}. Nothing was saved; you can safely retry.
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* v4.1 — the inflow monitor: what this thing can actually see. */}
          <Coverage
            rows={statusRows}
            now={nowMs}
            connectedMailboxes={accounts.map((a) => ({ email: a.email, app: a.app ?? "workspace" }))}
            googleReady={googleConfigured()}
            personalReady={appConfigured("personal")}
          />

          <Scorecard kpis={kpis} />

          <DataQuality stats={dq} />

          <LinkLearning model={linkModel} />

          <AgentCost turns={agentTurns} />

          <MailTuning lowConfidence={lowConfidence} recent={recentInflow} />

          <Corrections report={corrections} />

          {/* Where the stored items came from (all-time capture mix). */}
          <div className={`flex flex-col gap-3 p-5 md:col-span-2 ${CARD}`}>
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>Captured by source</SectionLabel>
              <span className="text-xs text-ink-3">
                {sources.length} {sources.length === 1 ? "source" : "sources"} · {items.length.toLocaleString()} items
                all-time
              </span>
            </div>
            {sources.length === 0 ? (
              <EmptyState
                bordered={false}
                glyph="⇣"
                title="Nothing has flowed in yet"
                body="Every capture — web, Telegram, email, voice, imports — will be counted here."
              />
            ) : (
              <div className="grid grid-cols-1 gap-x-8 gap-y-2.5 md:grid-cols-2">
                {sources.map((s) => (
                  <div key={s.source} className="flex items-center gap-2.5">
                    <span className="w-24 shrink-0 truncate text-[13px] text-ink" title={s.source}>
                      {SOURCE_LABEL[s.source] ?? s.source}
                    </span>
                    <div className="h-2 min-w-8 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${(s.total / maxSource) * 100}%` }}
                      />
                    </div>
                    <span className="w-[72px] shrink-0 text-right text-[13px] tabular-nums text-ink-2">
                      {s.total.toLocaleString()}
                      {s.recent > 0 && <span className="ml-1 text-xs text-accent-text">+{s.recent}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs leading-relaxed text-ink-3">
              Stored items by the source that created them, all-time; the blue figure is the last 24 hours.
              Declared-vs-actual coverage is the panel above.
            </p>
          </div>

          <div className={`flex flex-col gap-3 p-5 ${CARD}`}>
            <SectionLabel>By type</SectionLabel>
            {byType.length === 0 ? (
              <EmptyState
                bordered={false}
                glyph="◇"
                title="No active items yet"
                body="Capture something, or activate an import, and the mix shows up here."
              />
            ) : (
              byType.map((r) => (
                <div key={r.type} className="flex items-center gap-2.5">
                  <span className="w-20 shrink-0 text-[13px]" style={{ color: TYPE_HUE[r.type] }}>
                    {r.type}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(r.n / maxType) * 100}%`, background: TYPE_SOLID[r.type] }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right text-[13px] tabular-nums text-ink-2">{r.n}</span>
                </div>
              ))
            )}
          </div>

          <div className={CARD_LIST}>
            <div className="px-5 pb-2.5 pt-5">
              <SectionLabel>Recent activity</SectionLabel>
            </div>
            {audit.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState
                  bordered={false}
                  glyph="◷"
                  title="Nothing logged yet"
                  body="Captures, merges, approvals and syncs all leave a trail here."
                />
              </div>
            ) : (
              audit.map((a, i) => (
                <div key={i} className={`flex items-center gap-2.5 px-5 py-3 ${i > 0 ? "border-t border-hairline" : ""}`}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "#96b2ff" }} />
                  <div className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-medium">{actionLabel(a.action)}</span>{" "}
                    <span className="text-ink-3">· {a.actor}</span>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-ink-3">{ago(a.created_at)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className={`mt-4 p-5 ${CARD}`}>
          <SectionLabel className="mb-3">Spend detail</SectionLabel>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <MiniStat value={money(sum(today, cost))} label="today" />
            <MiniStat value={sum(today, toks).toLocaleString()} label="today tokens" />
            <MiniStat value={usage.length.toLocaleString()} label="LLM calls" />
            <MiniStat value={active.filter((i) => i.needs_review).length.toString()} label="needs review" />
            <MiniStat value={active.filter((i) => i.sensitive).length.toString()} label="private" />
          </div>
          {Object.keys(byOp).length > 0 && (
            <p className="mt-4 border-t border-hairline pt-3 text-xs leading-relaxed text-ink-3">
              By operation:{" "}
              {Object.entries(byOp)
                .sort((a, b) => b[1] - a[1])
                .map(([op, c]) => `${op} ${money(c)}`)
                .join(" · ")}
            </p>
          )}
        </div>
      </PageMain>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={`p-4 ${CARD}`}>
      <div className="text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums">{value}</div>
      <div className="mt-1.5 text-[13px] text-ink-2">{label}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[17px] font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-ink-3">{label}</div>
    </div>
  );
}
