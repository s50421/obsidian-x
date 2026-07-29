import { CARD, EmptyState, SectionLabel } from "../components/ui";
import { MIN_CONFIDENCE, SURFACE_THRESHOLD } from "@/lib/rank-mail";

// v4.1 — the ranker's working-out, shown only here.
//
// The no-half-baked law says a low-confidence read must never reach the brief.
// But it must not vanish either, or the ranker can never be tuned — so it lands
// here: everything the ranker scored high enough to matter but wasn't sure
// enough about to surface, plus the recent top-scorers for spot-checking
// against the owner's own judgement (KPI #2, the no-surprises rule).

export type InflowRow = {
  id: string;
  subject: string | null;
  sender: string | null;
  ts: string;
  ranked_score: number | null;
  ranked_reason: {
    signals?: string[];
    confidence?: number;
    reason?: string;
    vip?: boolean;
    bulk?: boolean;
    autoCreate?: boolean;
  } | null;
  state: string;
  item_id: string | null;
};

function senderName(s: string | null): string {
  if (!s) return "unknown";
  return s.replace(/\s*<[^>]+>\s*/, "").replace(/^"|"$/g, "").trim() || s;
}

function Line({ r }: { r: InflowRow }) {
  const score = r.ranked_score ?? 0;
  const reason = r.ranked_reason ?? {};
  const conf = Number(reason.confidence ?? 0);
  const color = score >= SURFACE_THRESHOLD ? "#96b2ff" : "rgba(255,255,255,0.38)";
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span
        className="w-8 shrink-0 text-right text-[13px] font-semibold tabular-nums"
        style={{ color }}
      >
        {score}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink">
          <span className="font-medium">{senderName(r.sender)}</span>
          <span className="text-ink-3"> — </span>
          {r.subject ?? "(no subject)"}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-3">
          {(reason.signals ?? []).join(" · ") || "no signals"}
          {reason.reason ? ` · ${reason.reason}` : ""}
          {` · confidence ${conf.toFixed(2)}`}
          {r.item_id ? " · became an item" : ""}
        </div>
      </div>
    </div>
  );
}

export default function MailTuning({
  lowConfidence,
  recent,
}: {
  lowConfidence: InflowRow[];
  recent: InflowRow[];
}) {
  return (
    <div className={`flex flex-col gap-1 p-5 md:col-span-2 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>Mail ranking — tuning</SectionLabel>
        <span className="text-xs text-ink-3">
          surface ≥ {SURFACE_THRESHOLD} · confidence ≥ {MIN_CONFIDENCE}
        </span>
      </div>

      {lowConfidence.length > 0 && (
        <>
          <p className="mb-1 text-xs leading-relaxed text-warn">
            Scored high enough to matter, but the ranker wasn&apos;t confident enough to put it in your
            brief. Withheld on purpose — these are the ones to check.
          </p>
          <div className="divide-y divide-hairline">
            {lowConfidence.map((r) => (
              <Line key={r.id} r={r} />
            ))}
          </div>
          <div className="mt-3 border-t border-hairline pt-3" />
        </>
      )}

      <SectionLabel className="mb-1">Recent inflow</SectionLabel>
      {recent.length === 0 ? (
        <EmptyState
          bordered={false}
          glyph="✉"
          title="No mail has flowed in yet"
          body="Connect Gmail above. Every message becomes an inflow event; only the ones that clear the bar become items."
        />
      ) : (
        <div className="divide-y divide-hairline">
          {recent.map((r) => (
            <Line key={r.id} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}
