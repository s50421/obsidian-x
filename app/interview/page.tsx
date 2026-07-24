"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Msg = { role: "assistant" | "user"; content: string };

export default function InterviewPage() {
  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(0);
  const started = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function next(hist: Msg[]) {
    setLoading(true);
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: hist }),
      });
      const data = await res.json();
      if (data.saved) setSaved((s) => s + 1);
      if (data.question) setHistory([...hist, { role: "assistant", content: data.question }]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    next([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, loading]);

  async function send() {
    const a = input.trim();
    if (!a || loading) return;
    const hist: Msg[] = [...history, { role: "user", content: a }];
    setHistory(hist);
    setInput("");
    await next(hist);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 sm:py-10">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Interview</h1>
          <p className="text-xs opacity-60">
            I&apos;ll build a fuller picture of you — every answer is saved to your brain
            {saved > 0 ? ` (${saved} so far)` : ""}.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
        >
          Done
        </Link>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {history.map((m, i) => (
          <div key={i} className={m.role === "assistant" ? "flex" : "flex justify-end"}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                m.role === "assistant"
                  ? "bg-black/5 dark:bg-white/10"
                  : "bg-foreground text-background"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && <div className="flex"><div className="rounded-2xl bg-black/5 px-4 py-2 text-sm opacity-60 dark:bg-white/10">…</div></div>}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 flex items-end gap-2 border-t border-black/10 bg-background pt-3 dark:border-white/10">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Your answer…  (Enter to send)"
          className="flex-1 resize-none rounded-lg border border-black/15 bg-transparent p-2.5 text-sm outline-none focus:border-black/40 dark:border-white/20"
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background transition disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </main>
  );
}
