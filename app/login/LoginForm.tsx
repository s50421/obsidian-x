"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";

function initialMessage(error?: string): string {
  if (error === "forbidden") return "That account isn't allowed to use this app.";
  if (error === "auth") return "That sign-in link was invalid or expired. Try again.";
  return "";
}

export default function LoginForm({ initialError }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [message, setMessage] = useState(initialMessage(initialError));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setStatus("sending");
    setMessage("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: addr,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    if (error) {
      setStatus("error");
      setMessage(error.message);
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <div className="w-full rounded-control border border-hairline bg-surface-2 p-4 text-left text-sm text-ink-2">
        Check your email — I sent a sign-in link to{" "}
        <span className="font-semibold text-ink">{email}</span>. Open it on this device.
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full space-y-3">
      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        className="h-[50px] w-full rounded-control border border-hairline bg-surface-2 px-4 text-[16px] text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_rgba(80,107,242,0.25)]"
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="h-[50px] w-full rounded-control bg-accent text-[16px] font-semibold text-white transition disabled:opacity-50"
      >
        {status === "sending" ? "Sending…" : "Send magic link"}
      </button>
      {message && <p className="text-sm text-danger">{message}</p>}
    </form>
  );
}
