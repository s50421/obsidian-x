"use client";

import { useCallback, useEffect, useState } from "react";
import { CARD_LIST, SectionLabel, TypeChip } from "./ui";

type ReviewItem = {
  id: string;
  title: string;
  type: string;
  priority: string;
  review_reason: string | null;
  dup_candidate: string | null;
  dup_title: string | null;
};

const REVIEW_BTN =
  "inline-flex h-11 flex-1 items-center justify-center rounded-control text-[14px] font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";

export default function Review() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/review");
      const data = await res.json();
      if (res.ok) setItems(data.items ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("obx:captured", load);
    return () => window.removeEventListener("obx:captured", load);
  }, [load]);

  async function act(id: string, action: "approve" | "merge" | "delete") {
    setBusy(id);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) setItems((prev) => prev.filter((i) => i.id !== id));
    } finally {
      setBusy(null);
    }
  }

  // Hide the whole section — including while loading — when there's nothing to
  // review. A skeleton here would flash in on every Home load for a section
  // that is empty most days; absence is the calmer signal.
  if (loading || items.length === 0) return null;

  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between px-1">
        <SectionLabel>Needs review</SectionLabel>
        <span className="text-xs font-semibold text-accent-text">{items.length} to triage</span>
      </div>

      {/* Same anatomy as a deck card front: signal chips, then the one clean
          title, then the decision row — so triage reads identically wherever
          the owner meets it. Controls are 44px, like everywhere else. */}
      <div className={CARD_LIST}>
        {items.map((i, idx) => (
          <div key={i.id} className={idx > 0 ? "border-t border-hairline" : ""}>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <TypeChip type={i.type} />
                <span className="min-w-0 truncate text-xs text-ink-3">
                  {i.dup_title ? `vs. “${i.dup_title}”` : (i.review_reason ?? "please confirm")}
                </span>
              </div>
              <div className="text-[15px] font-semibold leading-snug text-ink">{i.title}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => act(i.id, "approve")}
                  disabled={busy === i.id}
                  className={REVIEW_BTN + " bg-white/[0.08] text-ink hover:bg-white/[0.12]"}
                >
                  Keep
                </button>
                {i.dup_candidate && (
                  <button
                    onClick={() => act(i.id, "merge")}
                    disabled={busy === i.id}
                    className={REVIEW_BTN + " bg-accent-soft text-accent-text"}
                  >
                    Merge
                  </button>
                )}
                <button
                  onClick={() => act(i.id, "delete")}
                  disabled={busy === i.id}
                  className={REVIEW_BTN + " bg-transparent text-danger hover:bg-white/[0.06]"}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
