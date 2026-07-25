"use client";

import { useState } from "react";
import { SectionLabel } from "./ui";

type Source = {
  n: number;
  id: string;
  title: string;
  type: string;
  vault_path: string | null;
  vault_url: string | null;
};

type AskResult = {
  answer: string;
  sources: Source[];
};

export default function Ask() {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `ask failed (${res.status})`);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }

  return (
    <section>
      <SectionLabel className="mb-2.5 px-1">Ask</SectionLabel>
      <div className="flex flex-col gap-3.5 rounded-card border border-hairline bg-surface-1 p-4">
        <div className="flex h-11 items-center gap-2 rounded-control border border-hairline bg-surface-2 px-3.5 transition focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(80,107,242,0.25)]">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
            placeholder="Ask your brain a question…"
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
          />
          <button
            onClick={ask}
            disabled={asking || !question.trim()}
            className="shrink-0 text-[13px] font-semibold text-accent-text transition disabled:opacity-40"
          >
            {asking ? "…" : "Ask"}
          </button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        {result && (
          <>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{result.answer}</p>
            {result.sources.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {result.sources.map((s) =>
                  s.vault_url ? (
                    <a
                      key={s.id}
                      href={s.vault_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-[10px] bg-white/[0.06] px-2.5 py-1.5 text-xs font-semibold text-accent-text transition hover:bg-white/[0.1]"
                    >
                      ↗ {s.title}
                    </a>
                  ) : (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1.5 rounded-[10px] bg-white/[0.06] px-2.5 py-1.5 text-xs font-semibold text-accent-text"
                    >
                      ↗ {s.title}
                    </span>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
