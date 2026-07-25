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
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      {state === "saving" && <p className="text-sm text-ink-2">🧠 Saving to your brain…</p>}
      {state === "done" && (
        <>
          <p className="text-lg font-semibold">🧠 Saved</p>
          {detail && <p className="mt-1 text-sm text-ink-2">{detail}</p>}
        </>
      )}
      {state === "empty" && <p className="text-sm text-ink-2">Nothing to save.</p>}
      {state === "error" && (
        <>
          <p className="text-lg font-semibold text-danger">Couldn&apos;t save</p>
          <p className="mt-1 text-sm text-ink-2">{detail}</p>
        </>
      )}
      <Link href="/" className="mt-6 rounded-control bg-white/[0.08] px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-white/[0.12]">
        Open Obsidian-X
      </Link>
    </main>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={<main className="flex flex-1 items-center justify-center p-8 text-sm opacity-60">Loading…</main>}>
      <ShareInner />
    </Suspense>
  );
}
