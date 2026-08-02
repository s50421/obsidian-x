import { CARD, EmptyState, SectionLabel } from "../components/ui";
import { categoryLabel, type CorrectionReport } from "@/lib/corrections";

// Brain-quality Phase 2, item 5 — what the classifier actually gets wrong.
//
// Deliberately shows EXAMPLES, not just counts. "8 type changes" tells you
// nothing you can act on; "8 type changes, e.g. a shopping-list edit filed as a
// task" tells you exactly which line of the prompt to fix.

export default function Corrections({ report }: { report: CorrectionReport }) {
  const rate = report.captures
    ? Math.round((report.total / report.captures) * 100)
    : null;

  return (
    <div className={`flex flex-col gap-1 p-5 md:col-span-2 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>What you had to correct — last 30 days</SectionLabel>
        <span className="text-xs text-ink-3">
          {report.total} correction{report.total === 1 ? "" : "s"}
          {rate != null ? ` · ~${rate}% of ${report.captures} captures` : ""}
        </span>
      </div>

      {report.total === 0 ? (
        <EmptyState
          bordered={false}
          glyph="✓"
          title="Nothing corrected yet"
          body="Every title, type or tag you fix lands here, grouped by what went wrong — so the classification prompt gets tuned against real mistakes instead of guesses."
        />
      ) : (
        <>
          <p className="mb-1 text-xs leading-relaxed text-ink-3">
            Each row is a class of mistake the classifier keeps making. Fix the prompt against
            these, not against a hunch.
          </p>
          <div className="divide-y divide-hairline">
            {report.stats.map((s) => (
              <div key={s.category} className="flex items-start gap-3 py-2.5">
                <span className="w-8 shrink-0 text-right text-[13px] font-semibold tabular-nums text-ink">
                  {s.count}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink">{categoryLabel(s.category)}</div>
                  {s.examples.length > 0 && (
                    <div className="mt-0.5 text-xs leading-relaxed text-ink-3">
                      {s.examples.map((e) => `“${e}”`).join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
