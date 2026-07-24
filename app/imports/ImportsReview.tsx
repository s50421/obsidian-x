"use client";

import { useCallback, useEffect, useState } from "react";

type Row = { id: string; title: string; type: string; source: string; tags: string[]; snippet: string };

const TYPES = ["", "note", "task", "idea", "shopping", "reference", "person", "event"];

// Import sources this screen curates. Keep in sync with IMPORT_SOURCES in
// app/api/imports/route.ts. "all" spans every source.
const SOURCES: { value: string; label: string }[] = [
  { value: "all", label: "all sources" },
  { value: "apple-notes", label: "Apple Notes" },
  { value: "chatgpt-profile", label: "ChatGPT profile" },
];

export default function ImportsReview() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(40);
  const [type, setType] = useState("");
  const [source, setSource] = useState("all");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (off: number, t: string, query: string, src: string) => {
    setLoading(true);
    const params = new URLSearchParams({ offset: String(off) });
    if (t) params.set("type", t);
    if (query) params.set("q", query);
    if (src) params.set("source", src);
    const res = await fetch(`/api/imports?${params}`);
    const data = await res.json();
    setRows(data.items ?? []);
    setTotal(data.total ?? 0);
    setLimit(data.limit ?? 40);
    setOffset(data.offset ?? 0);
    setCounts(data.counts ?? {});
    setSelected(new Set());
    setLoading(false);
  }, []);

  useEffect(() => {
    load(0, type, q, source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, source]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)));

  const act = useCallback(
    async (action: "activate" | "remove") => {
      if (selected.size === 0 || busy) return;
      setBusy(true);
      setNotice("");
      const ids = [...selected];
      const res = await fetch("/api/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action, source }),
      });
      const data = await res.json();
      setBusy(false);
      if (!res.ok) {
        setNotice(data.error || "Failed");
        return;
      }
      setNotice(`${action === "activate" ? "Activated" : "Removed"} ${data.affected}.`);
      // reload the same page (items shifted out of the archived set)
      load(offset >= total - data.affected ? Math.max(0, offset - limit) : offset, type, q, source);
    },
    [selected, busy, offset, total, limit, type, q, source, load]
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
              {s.value !== "all" && counts[s.value] != null ? ` (${counts[s.value]})` : ""}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t || "all types"}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(0, type, q, source)}
          placeholder="search… (Enter)"
          className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/40 dark:border-white/20"
        />
        <span className="text-xs opacity-60">{total} on hold</span>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allOnPage} onChange={toggleAll} />
          Select page ({selected.size} selected)
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => act("activate")}
            disabled={busy || selected.size === 0}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            Activate
          </button>
          <button
            onClick={() => act("remove")}
            disabled={busy || selected.size === 0}
            className="rounded-md border border-red-500/50 px-3 py-1 text-xs font-medium text-red-600 transition hover:bg-red-500/10 disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      </div>
      {notice && <p className="mb-2 text-xs opacity-70">{notice}</p>}

      {loading ? (
        <p className="py-8 text-center text-sm opacity-60">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">Nothing left on hold here. 🎉</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.id}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 text-sm transition ${
                selected.has(r.id)
                  ? "border-emerald-500/50 bg-emerald-500/5"
                  : "border-black/10 dark:border-white/10"
              }`}
              onClick={() => toggle(r.id)}
            >
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={() => toggle(r.id)}
                onClick={(e) => e.stopPropagation()}
                className="mt-1"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{r.title}</span>
                  <span className="shrink-0 rounded-full border border-black/15 px-1.5 py-0.5 text-[10px] opacity-70 dark:border-white/20">
                    {r.type}
                  </span>
                </div>
                {r.snippet && <div className="mt-0.5 truncate text-xs opacity-60">{r.snippet}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {total > limit && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            onClick={() => load(Math.max(0, offset - limit), type, q, source)}
            disabled={offset === 0 || loading}
            className="rounded-md border border-black/15 px-3 py-1 disabled:opacity-40 dark:border-white/20"
          >
            ← Prev
          </button>
          <span className="text-xs opacity-60">
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => load(offset + limit, type, q, source)}
            disabled={offset + limit >= total || loading}
            className="rounded-md border border-black/15 px-3 py-1 disabled:opacity-40 dark:border-white/20"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
