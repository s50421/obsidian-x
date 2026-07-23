"use client";

import { useCallback, useEffect, useState } from "react";

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
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
        Review <span className="opacity-60">({items.length})</span>
      </h2>
      <div className="space-y-2">
        {items.map((i) => (
          <div
            key={i.id}
            className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{i.title}</span>
              <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs opacity-80 dark:border-white/20">
                {i.type}
              </span>
            </div>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              {i.review_reason ?? "please confirm"}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => act(i.id, "approve")}
                disabled={busy === i.id}
                className="rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background disabled:opacity-40"
              >
                Keep
              </button>
              {i.dup_candidate && (
                <button
                  onClick={() => act(i.id, "merge")}
                  disabled={busy === i.id}
                  className="rounded-md border border-black/20 px-3 py-1 text-xs disabled:opacity-40 dark:border-white/25"
                >
                  Merge (it&apos;s a duplicate)
                </button>
              )}
              <button
                onClick={() => act(i.id, "delete")}
                disabled={busy === i.id}
                className="rounded-md border border-red-500/40 px-3 py-1 text-xs text-red-600 disabled:opacity-40 dark:text-red-400"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
