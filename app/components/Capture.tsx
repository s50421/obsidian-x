"use client";

import { useState } from "react";

type Entity = { name: string; kind: string };
type LinkRef = { id: string; title: string };

type CreatedItem = {
  item: {
    id: string;
    type: string;
    title: string;
    tags: string[] | null;
    priority: string;
  };
  due_at: string | null;
  needs_review: boolean;
  review_reason: string | null;
  entities: Entity[];
  links: LinkRef[];
  vault_path: string | null;
  vault_url: string | null;
  vaultError: string | null;
};

type CaptureResult = {
  created: CreatedItem[];
  confidence: number;
  split: boolean;
};

function formatDue(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
      // Let the Review section refresh if this capture flagged anything.
      window.dispatchEvent(new Event("obx:captured"));
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
        <div className="mt-3 space-y-2">
          {result.split && (
            <p className="text-xs opacity-60">
              Split into {result.created.length} notes.
            </p>
          )}
          {result.created.map((c) => (
            <div
              key={c.item.id}
              className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.item.title}</span>
                <Badge>{c.item.type}</Badge>
                <Badge>priority: {c.item.priority}</Badge>
                {c.due_at && <Badge>due {formatDue(c.due_at)}</Badge>}
                {(c.item.tags ?? []).map((t) => (
                  <Badge key={t}>#{t}</Badge>
                ))}
              </div>

              {c.needs_review && (
                <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                  Needs review — {c.review_reason ?? "please confirm"} · see Review below
                </div>
              )}

              {c.entities.length > 0 && (
                <div className="mt-2 text-xs opacity-70">
                  People/places: {c.entities.map((e) => e.name).join(", ")}
                </div>
              )}

              {c.links.length > 0 && (
                <div className="mt-1 text-xs opacity-70">
                  Linked to: {c.links.map((l) => l.title).join(", ")}
                </div>
              )}

              <div className="mt-2 text-xs opacity-70">
                {c.vault_url ? (
                  <a href={c.vault_url} target="_blank" rel="noreferrer" className="underline">
                    Written to vault: {c.vault_path}
                  </a>
                ) : (
                  <span className="text-amber-600">
                    Saved to database, but vault write failed
                    {c.vaultError ? `: ${c.vaultError}` : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
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
