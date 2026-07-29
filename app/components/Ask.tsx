"use client";

import { useState } from "react";
import { CARD, CARD_INSET, FIELD, INPUT, SectionLabel } from "./ui";

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
      <div className={`flex flex-col gap-3.5 p-4 ${CARD}`}>
        <div className={`${FIELD} h-12 pr-1.5`}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run("answer");
            }}
            aria-label="Ask your brain, or draft from it"
            placeholder="Ask your brain, or draft from it…"
            className={INPUT}
          />
          <button
            onClick={() => run("draft")}
            disabled={busy !== null || !input.trim()}
            className="inline-flex h-9 shrink-0 items-center rounded-[10px] px-2.5 text-[13px] font-semibold text-ink-2 transition hover:bg-white/[0.06] hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            {busy === "draft" ? "…" : "Draft"}
          </button>
          <button
            onClick={() => run("answer")}
            disabled={busy !== null || !input.trim()}
            className="inline-flex h-9 shrink-0 items-center rounded-[10px] bg-accent-soft px-3 text-[13px] font-semibold text-accent-text transition disabled:pointer-events-none disabled:opacity-40"
          >
            {busy === "ask" ? "…" : "Ask"}
          </button>
        </div>

        {busy && (
          <div className="space-y-2" aria-busy="true">
            <div className="obx-skeleton h-3.5 w-full rounded-full" />
            <div className="obx-skeleton h-3.5 w-[86%] rounded-full" />
            <div className="obx-skeleton h-3.5 w-[62%] rounded-full" />
          </div>
        )}

        {error && <p className="text-[13px] text-danger">{error}</p>}

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
                result.kind === "draft" ? `${CARD_INSET} p-3.5` : ""
              }`}
            >
              {result.text}
            </p>
            {result.sources.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-hairline pt-3">
                {result.sources.slice(0, 6).map((s) =>
                  s.vault_url ? (
                    <a
                      key={s.id}
                      href={s.vault_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 max-w-full items-center gap-1.5 truncate rounded-control bg-white/[0.06] px-3 text-[13px] font-semibold text-accent-text transition hover:bg-white/[0.1]"
                    >
                      ↗ {s.title}
                    </a>
                  ) : (
                    <span
                      key={s.id}
                      className="inline-flex min-h-11 max-w-full items-center gap-1.5 truncate rounded-control bg-white/[0.06] px-3 text-[13px] font-semibold text-ink-2"
                    >
                      {s.title}
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
