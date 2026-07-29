"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppNav from "../components/AppNav";

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

  const questionNo = history.filter((m) => m.role === "assistant").length;

  return (
    <>
      <AppNav hideMobileBar />
      <main className="obx-safe-x mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-8">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-hairline bg-base pb-3 pt-[calc(12px+env(safe-area-inset-top))] md:pt-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold tracking-[-0.015em]">Interview</h1>
            <p className="mt-0.5 text-[13px] text-ink-2">
              Question {Math.max(1, questionNo)} · every answer is saved
              {saved > 0 ? ` · ${saved} saved` : ""}
            </p>
          </div>
          <Link
            href="/"
            className="-mr-2 inline-flex h-11 shrink-0 items-center rounded-control px-3 text-[13px] font-semibold text-ink-2 transition hover:bg-white/[0.06] hover:text-ink"
          >
            Done
          </Link>
        </div>

        <div className="flex flex-1 flex-col justify-end gap-3.5 overflow-y-auto py-5">
          {history.map((m, i) => (
            <div key={i} className={m.role === "assistant" ? "flex" : "flex justify-end"}>
              <div
                className={`max-w-[82%] px-4 py-3 text-[15px] leading-relaxed ${
                  m.role === "assistant"
                    ? "rounded-[18px] rounded-bl-[6px] border border-hairline bg-surface-2 text-ink"
                    : "rounded-[18px] rounded-br-[6px] bg-accent-soft text-ink"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex" aria-busy="true">
              <div className="flex items-center gap-1.5 rounded-[18px] rounded-bl-[6px] border border-hairline bg-surface-2 px-4 py-4">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-ink-3"
                    style={{ animation: `obx-pulse 1.2s ${i * 0.18}s infinite` }}
                  />
                ))}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="sticky bottom-0 flex items-end gap-2.5 border-t border-hairline bg-base py-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Type your answer…"
            aria-label="Your answer"
            className="max-h-32 min-h-12 flex-1 resize-none rounded-3xl border border-hairline bg-surface-2 px-4.5 py-3.5 text-[16px] text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_rgba(80,107,242,0.25)]"
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            aria-label="Send answer"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-lg font-semibold text-white transition active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            ↑
          </button>
        </div>
      </main>
    </>
  );
}
