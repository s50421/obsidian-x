"use client";

import { useState } from "react";

type CaptureResult = {
  item: {
    id: string;
    type: string;
    title: string;
    tags: string[] | null;
    priority: string;
  };
  vault_path: string | null;
  vault_url: string | null;
  vaultError: string | null;
};

export default function Capture() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
      setResult(data);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide opacity-60">
        Capture
      </h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
        }}
        placeholder="Type a thought, note, task, idea…  (⌘/Ctrl + Enter to save)"
        rows={5}
        className="w-full resize-y rounded-lg border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !text.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>

      {result && (
        <div className="mt-3 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{result.item.title}</span>
            <Badge>{result.item.type}</Badge>
            <Badge>priority: {result.item.priority}</Badge>
            {(result.item.tags ?? []).map((t) => (
              <Badge key={t}>#{t}</Badge>
            ))}
          </div>
          <div className="mt-2 text-xs opacity-70">
            {result.vault_url ? (
              <a
                href={result.vault_url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Written to vault: {result.vault_path}
              </a>
            ) : (
              <span className="text-amber-600">
                Saved to database, but vault write failed
                {result.vaultError ? `: ${result.vaultError}` : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs opacity-80 dark:border-white/20">
      {children}
    </span>
  );
}
