"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// v4.1 — the Gmail connection control inside the coverage panel.
//
// The client only ever sees mailbox addresses. Refresh tokens live server-side
// in `settings` and are never sent here.
export default function GmailConnect({ connected }: { connected: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");

  async function disconnect(mailbox: string) {
    if (!confirm(`Disconnect ${mailbox}? Past inflow history is kept.`)) return;
    setBusy(mailbox);
    try {
      await fetch("/api/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox }),
      });
      router.refresh();
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {connected.map((m) => (
        <span
          key={m}
          className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] py-0.5 pl-2.5 pr-1 text-xs text-ink-2"
        >
          {m}
          <button
            type="button"
            onClick={() => disconnect(m)}
            disabled={busy === m}
            aria-label={`Disconnect ${m}`}
            className="flex h-5 w-5 items-center justify-center rounded-full text-ink-3 transition hover:bg-white/[0.08] hover:text-danger disabled:opacity-40"
          >
            ×
          </button>
        </span>
      ))}
      <a
        href="/api/google/connect"
        className="inline-flex h-7 items-center rounded-full bg-white/[0.08] px-3 text-xs font-semibold text-ink transition hover:bg-white/[0.12]"
      >
        {connected.length ? "Add mailbox" : "Connect Gmail"}
      </a>
    </div>
  );
}
