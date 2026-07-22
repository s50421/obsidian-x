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
      <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        Check your email — I sent a sign-in link to{" "}
        <span className="font-medium">{email}</span>. Open it on this device.
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition disabled:opacity-40"
      >
        {status === "sending" ? "Sending…" : "Send sign-in link"}
      </button>
      {message && <p className="text-sm text-red-500">{message}</p>}
    </form>
  );
}
