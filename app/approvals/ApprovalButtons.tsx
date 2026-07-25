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
    <div className="flex shrink-0 items-center gap-2.5">
      <button
        onClick={() => act("approve")}
        disabled={busy !== null}
        className="h-11 flex-1 rounded-control bg-accent px-6 text-[14px] font-semibold text-white transition disabled:opacity-50 md:flex-none"
      >
        {busy === "approve" ? "…" : "Approve"}
      </button>
      <button
        onClick={() => act("reject")}
        disabled={busy !== null}
        className="h-11 flex-1 rounded-control bg-white/[0.08] px-6 text-[14px] font-semibold text-danger transition disabled:opacity-50 md:flex-none"
      >
        {busy === "reject" ? "…" : "Reject"}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
