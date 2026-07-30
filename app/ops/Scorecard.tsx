import { CARD, SectionLabel } from "../components/ui";
import type { Kpi } from "@/lib/scorecard";

// v4.2 workstream C — "polished", falsifiably.
//
// The design constraint worth preserving: a KPI with no real signal shows a
// dash and says what it would take, never a plausible-looking number. Half the
// value of this card is that the numbers on it can be trusted, and one invented
// figure would cost that for all of them.

const STATE_COLOR: Record<Kpi["state"], string> = {
  ok: "#93d8a8",
  warn: "#f0c26a",
  unknown: "rgba(255,255,255,0.3)",
};

export default function Scorecard({ kpis }: { kpis: Kpi[] }) {
  const measured = kpis.filter((k) => k.state !== "unknown");
  const meeting = measured.filter((k) => k.state === "ok").length;

  return (
    <div className={`flex flex-col gap-1 p-5 md:col-span-2 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>Scorecard</SectionLabel>
        <span className="text-xs tabular-nums text-ink-3">
          {measured.length ? `${meeting}/${measured.length} measurable KPIs on target` : "nothing measurable yet"}
        </span>
      </div>

      <div className="divide-y divide-hairline">
        {kpis.map((k) => (
          <div key={k.n} className="flex items-start gap-3 py-2.5">
            <span
              className="mt-[7px] h-2 w-2 shrink-0 rounded-full"
              style={{ background: STATE_COLOR[k.state] }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[14px] font-medium text-ink">{k.name}</span>
                <span
                  className="shrink-0 text-[13px] tabular-nums"
                  style={{ color: k.value ? STATE_COLOR[k.state] : "rgba(255,255,255,0.3)" }}
                >
                  {k.value ?? "—"}
                </span>
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-ink-3">
                {k.target}
                {k.note ? ` · ${k.note}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        A dash means there is no real signal behind that number yet — never an estimate. Trailing 7 days.
      </p>
    </div>
  );
}
