import { CARD, SectionLabel } from "../components/ui";
import { healthOf, type SourceHealth, type SourceStatusRow } from "@/lib/source-status";
import GmailConnect from "./GmailConnect";

// v4.1 workstream B — the inflow monitor. This is the trust surface: it answers
// "what can this thing actually see?" at a glance.
//
// The completeness law is what makes the layout what it is. Declared-but-broken
// sources are NOT hidden or sorted to the bottom — they sit in the same list
// wearing a ⚠, because a source that quietly disappears is the exact failure
// this panel exists to prevent. Declared-out sources (iMessage, WhatsApp,
// Drive) get their own muted row rather than being omitted.

const HEALTH_STYLE: Record<SourceHealth, { dot: string; text: string; word: string }> = {
  ok: { dot: "#93d8a8", text: "#93d8a8", word: "synced" },
  stale: { dot: "#f0c26a", text: "#f0c26a", word: "stale" },
  error: { dot: "#f49a91", text: "#f49a91", word: "error" },
  disconnected: { dot: "rgba(255,255,255,0.3)", text: "rgba(255,255,255,0.45)", word: "not connected" },
  out: { dot: "rgba(255,255,255,0.2)", text: "rgba(255,255,255,0.38)", word: "out of scope" },
};

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Row({
  row,
  now,
  child = false,
  connectedMailboxes,
}: {
  row: SourceStatusRow;
  now: number;
  child?: boolean;
  connectedMailboxes?: string[];
}) {
  const health = healthOf(row, now);
  const style = HEALTH_STYLE[health];
  const note = typeof row.detail?.note === "string" ? row.detail.note : null;

  // Calendars report as a fraction — "18/20 synced" is the honest headline.
  const total = Number(row.detail?.total ?? 0);
  const okCount = Number(row.detail?.ok ?? 0);
  const fraction = row.source === "calendar" && !child && total ? `${okCount}/${total}` : null;

  return (
    <div className={`flex items-start gap-3 py-2.5 ${child ? "pl-6" : ""}`}>
      <span
        className="mt-[7px] h-2 w-2 shrink-0 rounded-full"
        style={{ background: style.dot }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`truncate text-[14px] ${child ? "text-ink-2" : "font-medium text-ink"}`}>
            {row.label ?? row.source}
          </span>
          {fraction && <span className="shrink-0 text-[13px] tabular-nums text-ink-2">{fraction}</span>}
        </div>
        <div className="mt-0.5 truncate text-xs" style={{ color: style.text }}>
          {style.word}
          {health !== "out" && health !== "disconnected" && (
            <span className="text-ink-3"> · {ago(row.last_ok ?? row.last_sync, now)}</span>
          )}
          {note && <span className="text-ink-3"> · {note}</span>}
        </div>
        {row.last_error && (
          <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-danger/80">{row.last_error}</div>
        )}
        {row.source === "gmail" && !child && (
          <GmailConnect connected={connectedMailboxes ?? []} />
        )}
      </div>
      {row.events_24h > 0 && (
        <span className="shrink-0 text-[13px] tabular-nums text-ink-2">
          {row.events_24h.toLocaleString()}
          <span className="ml-1 text-xs text-ink-3">/24h</span>
        </span>
      )}
    </div>
  );
}

export default function Coverage({
  rows,
  now,
  connectedMailboxes,
  googleReady,
}: {
  rows: SourceStatusRow[];
  now: number;
  connectedMailboxes: string[];
  googleReady: boolean;
}) {
  const parents = rows.filter((r) => r.channel === "");
  const childrenOf = (source: string) => rows.filter((r) => r.channel !== "" && r.source === source);

  const declared = parents.filter((r) => r.scope === "declared");
  const out = parents.filter((r) => r.scope === "out");
  const green = declared.filter((r) => healthOf(r, now) === "ok").length;

  return (
    <div className={`flex flex-col gap-1 p-5 md:col-span-2 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>Coverage</SectionLabel>
        <span className="text-xs tabular-nums text-ink-3">
          {green}/{declared.length} declared sources healthy
        </span>
      </div>

      {!googleReady && (
        <p className="mb-2 rounded-control bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          Google OAuth isn&apos;t configured yet — set <code>GOOGLE_CLIENT_ID</code> and{" "}
          <code>GOOGLE_CLIENT_SECRET</code> in the environment to enable the Gmail connection.
        </p>
      )}

      <div className="divide-y divide-hairline">
        {declared.map((r) => (
          <div key={`${r.source}:${r.channel}`}>
            <Row row={r} now={now} connectedMailboxes={connectedMailboxes} />
            {childrenOf(r.source).map((c) => (
              <Row key={`${c.source}:${c.channel}`} row={c} now={now} child />
            ))}
          </div>
        ))}
      </div>

      {out.length > 0 && (
        <>
          <div className="mt-3 border-t border-hairline pt-3">
            <SectionLabel className="mb-1">Explicitly out (phase 2)</SectionLabel>
          </div>
          <div className="divide-y divide-hairline">
            {out.map((r) => (
              <Row key={`${r.source}:${r.channel}`} row={r} now={now} />
            ))}
          </div>
        </>
      )}

      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        A source is fully in or explicitly out. Anything declared but not synced in the last 24 hours shows ⚠
        here and in the morning brief&apos;s coverage footer — the brief never silently omits a broken source.
      </p>
    </div>
  );
}
