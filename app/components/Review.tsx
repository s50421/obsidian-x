"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionLabel, TypeChip } from "./ui";

type ReviewItem = {
  id: string;
  title: string;
  type: string;
  priority: string;
  review_reason: string | null;
  dup_candidate: string | null;
  dup_title: string | null;
};

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

  // Hide the whole section when there's nothing to review.
  if (loading || items.length === 0) return null;

  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between px-1">
        <SectionLabel>Review</SectionLabel>
        <span className="text-xs font-semibold text-accent-text">{items.length} to triage</span>
      </div>

      <div className="overflow-hidden rounded-card border border-hairline bg-surface-1">
        {items.map((i, idx) => (
          <div key={i.id} className={idx > 0 ? "border-t border-hairline" : ""}>
            <div className="flex flex-col gap-2.5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <TypeChip type={i.type} />
                <span className="text-xs text-ink-3">
                  {i.dup_title ? `vs. “${i.dup_title}”` : (i.review_reason ?? "please confirm")}
                </span>
              </div>
              <div className="text-[15px] leading-snug">{i.title}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => act(i.id, "approve")}
                  disabled={busy === i.id}
                  className="h-9 flex-1 rounded-[10px] bg-white/[0.08] text-[13px] font-semibold text-ink transition disabled:opacity-40"
                >
                  Keep
                </button>
                {i.dup_candidate && (
                  <button
                    onClick={() => act(i.id, "merge")}
                    disabled={busy === i.id}
                    className="h-9 flex-1 rounded-[10px] bg-accent-soft text-[13px] font-semibold text-accent-text transition disabled:opacity-40"
                  >
                    Merge
                  </button>
                )}
                <button
                  onClick={() => act(i.id, "delete")}
                  disabled={busy === i.id}
                  className="h-9 flex-1 rounded-[10px] bg-transparent text-[13px] font-semibold text-danger transition disabled:opacity-40"
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
