"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BTN_DANGER, BTN_PRIMARY } from "../components/ui";

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
    <div className="flex shrink-0 flex-wrap items-center gap-2.5">
      <button
        onClick={() => act("approve")}
        disabled={busy !== null}
        className={`${BTN_PRIMARY} flex-1 md:flex-none`}
      >
        {busy === "approve" ? "…" : "Approve"}
      </button>
      <button
        onClick={() => act("reject")}
        disabled={busy !== null}
        className={`${BTN_DANGER} flex-1 md:flex-none`}
      >
        {busy === "reject" ? "…" : "Reject"}
      </button>
      {error && <span className="w-full text-xs text-danger md:w-auto">{error}</span>}
    </div>
  );
}
