"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// v4.1 — the Gmail connection control inside the coverage panel.
//
// Two OAuth clients, because Google forces it: a Workspace "Internal" app can
// only be authorized by accounts inside that Workspace, so a consumer Gmail
// needs its own (External) client. Each mailbox remembers which client issued
// its grant so refreshes go back to the right one.
//
// The client only ever sees mailbox addresses. Refresh tokens live server-side
// in `settings` and are never sent here.

export type ConnectedMailbox = { email: string; app: "workspace" | "personal" };

const APP_LABEL: Record<ConnectedMailbox["app"], string> = {
  workspace: "workspace",
  personal: "personal",
};

export default function GmailConnect({
  connected,
  personalReady,
}: {
  connected: ConnectedMailbox[];
  /** Is a second (External) OAuth client configured? */
  personalReady: boolean;
}) {
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

  const hasPersonal = connected.some((c) => c.app === "personal");

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {connected.map((m) => (
        <span
          key={m.email}
          className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] py-0.5 pl-2.5 pr-1 text-xs text-ink-2"
        >
          {m.email}
          <span className="text-ink-3">· {APP_LABEL[m.app]}</span>
          <button
            type="button"
            onClick={() => disconnect(m.email)}
            disabled={busy === m.email}
            aria-label={`Disconnect ${m.email}`}
            className="flex h-5 w-5 items-center justify-center rounded-full text-ink-3 transition hover:bg-white/[0.08] hover:text-danger disabled:opacity-40"
          >
            ×
          </button>
        </span>
      ))}

      <a
        href="/api/google/connect?app=workspace"
        className="inline-flex h-7 items-center rounded-full bg-white/[0.08] px-3 text-xs font-semibold text-ink transition hover:bg-white/[0.12]"
      >
        {connected.some((c) => c.app === "workspace") ? "Add workspace mailbox" : "Connect Workspace Gmail"}
      </a>

      {personalReady && !hasPersonal && (
        <a
          href="/api/google/connect?app=personal"
          className="inline-flex h-7 items-center rounded-full bg-white/[0.08] px-3 text-xs font-semibold text-ink transition hover:bg-white/[0.12]"
        >
          Connect personal Gmail
        </a>
      )}
    </div>
  );
}
