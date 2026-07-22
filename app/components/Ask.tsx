"use client";

import { useState } from "react";

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
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
        Ask
      </h2>
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask();
          }}
          placeholder="Ask your brain a question…"
          className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
        />
        <button
          onClick={ask}
          disabled={asking || !question.trim()}
          className="shrink-0 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition disabled:opacity-40"
        >
          {asking ? "…" : "Ask"}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

      {result && (
        <div className="mt-3 space-y-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {result.answer}
          </p>
          {result.sources.length > 0 && (
            <div className="border-t border-black/10 pt-3 dark:border-white/15">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide opacity-50">
                Sources
              </p>
              <ul className="space-y-1 text-xs">
                {result.sources.map((s) => (
                  <li key={s.id} className="opacity-80">
                    <span className="opacity-50">[{s.n}]</span>{" "}
                    {s.vault_url ? (
                      <a
                        href={s.vault_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {s.title}
                      </a>
                    ) : (
                      s.title
                    )}{" "}
                    <span className="opacity-50">({s.type})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
