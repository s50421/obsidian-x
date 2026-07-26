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

type Outcome = { kind: "answer" | "draft"; text: string; sources: Source[] };

export default function Ask() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"ask" | "draft" | null>(null);
  const [result, setResult] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(kind: "answer" | "draft") {
    const q = input.trim();
    if (!q || busy) return;
    setBusy(kind === "answer" ? "ask" : "draft");
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const url = kind === "answer" ? "/api/ask" : "/api/draft";
      const body = kind === "answer" ? { question: q } : { text: q };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${kind} failed (${res.status})`);
      setResult({ kind, text: kind === "answer" ? data.answer : data.draft, sources: data.sources ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function copyDraft() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <section>
      <SectionLabel className="mb-2.5 px-1">Ask &amp; Draft</SectionLabel>
      <div className="flex flex-col gap-3.5 rounded-card border border-hairline bg-surface-1 p-4">
        <div className="flex h-11 items-center gap-2 rounded-control border border-hairline bg-surface-2 px-3.5 transition focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(80,107,242,0.25)]">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run("answer");
            }}
            placeholder="Ask your brain, or draft from it…"
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
          />
          <button
            onClick={() => run("draft")}
            disabled={busy !== null || !input.trim()}
            className="shrink-0 text-[13px] font-semibold text-ink-2 transition hover:text-ink disabled:opacity-40"
          >
            {busy === "draft" ? "…" : "✍️ Draft"}
          </button>
          <button
            onClick={() => run("answer")}
            disabled={busy !== null || !input.trim()}
            className="shrink-0 text-[13px] font-semibold text-accent-text transition disabled:opacity-40"
          >
            {busy === "ask" ? "…" : "Ask"}
          </button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        {result && (
          <>
            {result.kind === "draft" && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Draft</span>
                <button onClick={copyDraft} className="text-xs font-semibold text-accent-text">
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            )}
            <p
              className={`whitespace-pre-wrap text-[15px] leading-relaxed text-ink ${
                result.kind === "draft" ? "rounded-control border border-hairline bg-surface-2 p-3.5" : ""
              }`}
            >
              {result.text}
            </p>
            {result.sources.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {result.sources.slice(0, 6).map((s) =>
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
