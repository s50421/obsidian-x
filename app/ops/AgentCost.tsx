import { CARD, SectionLabel } from "../components/ui";

// v4.2.3 — what a conversation with the bot costs.
//
// The agent loop makes one model call PER TOOL STEP, so a chatty turn is
// structurally more expensive than the old single-shot router. The brief sets
// the budget at ≤ $0.02 for a typical turn and asks for a visible alarm above
// ~$0.05 — this is that alarm. Same rule as the rest of Ops: real counts only.

export const TURN_BUDGET_USD = 0.02;
export const TURN_ALARM_USD = 0.05;

export type AgentTurnStat = {
  cost_usd: number;
  steps: number;
  tools: string[];
  at: string;
  timedOut: boolean;
};

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export default function AgentCost({ turns }: { turns: AgentTurnStat[] }) {
  if (!turns.length) {
    return (
      <div className={`flex flex-col gap-1 p-5 ${CARD}`}>
        <SectionLabel>Agent turns</SectionLabel>
        <p className="pt-1 text-xs leading-relaxed text-ink-3">
          No conversational turns yet. Captures use the fast path and cost nothing here — this
          fills up once you ask the bot something.
        </p>
      </div>
    );
  }

  const costs = [...turns.map((t) => t.cost_usd)].sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)] ?? 0;
  const worst = costs[costs.length - 1] ?? 0;
  const over = turns.filter((t) => t.cost_usd > TURN_ALARM_USD);
  const avgSteps = turns.reduce((n, t) => n + t.steps, 0) / turns.length;

  return (
    <div className={`flex flex-col gap-1 p-5 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>Agent turns</SectionLabel>
        <span className="text-xs text-ink-3">last {turns.length}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 py-1">
        <Metric
          label="typical turn"
          value={money(median)}
          tone={median <= TURN_BUDGET_USD ? "good" : "warn"}
          note={`budget ${money(TURN_BUDGET_USD)}`}
        />
        <Metric
          label="worst turn"
          value={money(worst)}
          tone={worst > TURN_ALARM_USD ? "warn" : "normal"}
          note={`alarm ${money(TURN_ALARM_USD)}`}
        />
        <Metric label="tool steps" value={avgSteps.toFixed(1)} tone="normal" note="average" />
      </div>

      {over.length > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-warn">
          {over.length} turn{over.length === 1 ? "" : "s"} over {money(TURN_ALARM_USD)} — the
          priciest used {over[0].steps} tool steps ({over[0].tools.slice(0, 4).join(", ")}).
        </p>
      )}
      {turns.some((t) => t.timedOut) && (
        <p className="mt-1 text-xs leading-relaxed text-warn">
          {turns.filter((t) => t.timedOut).length} turn(s) hit the time budget and answered with
          what they had.
        </p>
      )}

      <div className="mt-2 divide-y divide-hairline border-t border-hairline pt-1">
        {turns.slice(0, 6).map((t, i) => (
          <div key={i} className="flex items-center gap-3 py-1.5 text-xs">
            <span
              className="w-14 shrink-0 text-right font-semibold tabular-nums"
              style={{ color: t.cost_usd > TURN_ALARM_USD ? "#e6c07b" : "rgba(255,255,255,0.85)" }}
            >
              {money(t.cost_usd)}
            </span>
            <span className="w-8 shrink-0 tabular-nums text-ink-3">{t.steps}⚙</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">
              {t.tools.length ? t.tools.join(" → ") : "answered directly"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: "good" | "warn" | "normal";
}) {
  const color = tone === "good" ? "#93d8a8" : tone === "warn" ? "#e6c07b" : "rgba(255,255,255,0.92)";
  return (
    <div>
      <div className="text-[17px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-[11px] text-ink-3">{note}</div>
    </div>
  );
}
