import { CARD, SectionLabel } from "../components/ui";
import { FEATURE_KEYS, FEATURE_LABEL } from "@/lib/link-features";
import { MIN_LABELS, type ModelState } from "@/lib/link-model";

// What the connection scorer has learned from the owner's decisions.
//
// Same rule as the rest of Ops: no fake numbers. Below the label threshold this
// says plainly that it is running on priors — a model implying it has learned
// something from nine examples is the no-half-baked law broken.

export default function LinkLearning({ model }: { model: ModelState }) {
  const ranked = FEATURE_KEYS.map((k) => ({ k, w: model.weights[k] })).sort((a, b) => b.w - a.w);
  const max = Math.max(...ranked.map((r) => Math.abs(r.w)), 0.001);
  const pct = Math.min(100, Math.round((model.labels / MIN_LABELS) * 100));

  return (
    <div className={`flex flex-col gap-1 p-5 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>What connections have taught it</SectionLabel>
        <span className="text-xs text-ink-3">
          {model.labels} decision{model.labels === 1 ? "" : "s"}
        </span>
      </div>

      {model.trained ? (
        <p className="mb-2 text-xs leading-relaxed text-ink-3">
          Fitted from your own Link / Not-related choices
          {model.accuracy != null ? ` · agrees with ${Math.round(model.accuracy * 100)}% of them` : ""}
          {model.fittedAt ? ` · last fitted ${new Date(model.fittedAt).toLocaleDateString()}` : ""}.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs leading-relaxed text-warn">
            Running on starting values, not on anything learned. Needs {MIN_LABELS} decisions with at
            least 5 of each answer — {model.labels} so far ({model.positives} connected).
          </p>
          <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}

      <div className="divide-y divide-hairline">
        {ranked.map(({ k, w }) => (
          <div key={k} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 text-[13px] text-ink">{FEATURE_LABEL[k]}</span>
            <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.round((Math.abs(w) / max) * 100)}%`,
                  background: w >= 0 ? "#93d8a8" : "#f49a91",
                }}
              />
            </span>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-3">
              {w.toFixed(1)}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 border-t border-hairline pt-3 text-xs leading-relaxed text-ink-3">
        Every suggestion records what it was judged on, and every Link / Not-related answer labels
        it. That dataset is what a model would need — collecting it costs nothing and keeps the
        decision open.
      </p>
    </div>
  );
}
