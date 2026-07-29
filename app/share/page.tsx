"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

// v2.1 — Web Share Target. When the PWA is installed, sharing text/a link from
// any app opens here (/share?title=&text=&url=) and captures it. Owner-gated by
// proxy.ts (pages require the session); the capture itself uses /api/capture.
function ShareInner() {
  const sp = useSearchParams();
  const [state, setState] = useState<"saving" | "done" | "empty" | "error">("saving");
  const [detail, setDetail] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const parts = [sp.get("title"), sp.get("text"), sp.get("url")]
      .map((s) => (s ?? "").trim())
      .filter(Boolean);
    const text = [...new Set(parts)].join("\n\n").trim();
    if (!text) {
      setState("empty");
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
        setDetail((data.created ?? []).map((c: { item: { title: string } }) => c.item.title).join(", "));
        setState("done");
      } catch (e) {
        setDetail(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();
  }, [sp]);

  return (
    <main className="obx-safe-x mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="w-full rounded-card border border-hairline bg-surface-1 px-6 py-9">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-control bg-white/[0.06] text-[17px] text-accent-text">
          {state === "saving" ? <span style={{ animation: "obx-pulse 1.2s infinite" }}>◌</span> : state === "error" ? "!" : "✓"}
        </div>
        {state === "saving" && (
          <>
            <p className="text-[17px] font-semibold">Saving to your brain…</p>
            <p className="mt-1 text-[13px] text-ink-2">It&apos;s being titled and filed right now.</p>
          </>
        )}
        {state === "done" && (
          <>
            <p className="text-[17px] font-semibold">Saved</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
              {detail || "It'll show up in tonight's deck."}
            </p>
          </>
        )}
        {state === "empty" && (
          <>
            <p className="text-[17px] font-semibold">Nothing to save</p>
            <p className="mt-1 text-[13px] text-ink-2">That share didn&apos;t carry any text or link.</p>
          </>
        )}
        {state === "error" && (
          <>
            <p className="text-[17px] font-semibold text-danger">Couldn&apos;t save</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{detail}</p>
          </>
        )}
        <Link
          href="/"
          className="mt-6 inline-flex h-11 items-center rounded-control bg-white/[0.08] px-5 text-[15px] font-semibold text-ink transition hover:bg-white/[0.12]"
        >
          Open Obsidian-X
        </Link>
      </div>
    </main>
  );
}

export default function SharePage() {
  return (
    <Suspense
      fallback={
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="obx-skeleton h-40 w-full max-w-md rounded-card" />
        </main>
      }
    >
      <ShareInner />
    </Suspense>
  );
}
