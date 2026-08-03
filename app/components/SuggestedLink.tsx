"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// One suggested connection, with the two taps that resolve it.
//
// Obsidian's "Unlinked mentions" pane is the model: a suggestion is offered
// next to the real links but visually separate, and one click turns it into a
// real one. Dismissing is equally cheap and is REMEMBERED — the nightly rebuild
// reads the dismissal, so a rejected pair never comes back.

export default function SuggestedLink({ edgeId }: { edgeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function act(action: "confirm" | "dismiss") {
    setBusy(action);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: edgeId, action }),
      });
      if (!res.ok) {
        setBusy(null);
        return;
      }
      setDone(action === "confirm" ? "Linked" : "Dismissed");
      router.refresh();
    } catch {
      setBusy(null);
    }
  }

  if (done) return <span className="shrink-0 text-xs text-ink-3">{done}</span>;

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => act("confirm")}
        disabled={!!busy}
        className="rounded-control border border-hairline px-2 py-1 text-[11px] font-medium text-ink hover:bg-white/[0.06] disabled:opacity-50"
        title="These really are related — draw this connection"
      >
        Link
      </button>
      <button
        type="button"
        onClick={() => act("dismiss")}
        disabled={!!busy}
        className="rounded-control border border-hairline px-2 py-1 text-[11px] text-ink-3 hover:bg-white/[0.06] disabled:opacity-50"
        title="Not related — never suggest this pair again"
      >
        No
      </button>
    </span>
  );
}
