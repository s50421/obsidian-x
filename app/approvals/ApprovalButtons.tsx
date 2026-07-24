"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ApprovalButtons({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || "Failed");
        setBusy(null);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => act("approve")}
        disabled={busy !== null}
        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy === "approve" ? "…" : "Approve"}
      </button>
      <button
        onClick={() => act("reject")}
        disabled={busy !== null}
        className="rounded-md border border-black/15 px-3 py-1 text-xs transition hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      >
        {busy === "reject" ? "…" : "Reject"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
