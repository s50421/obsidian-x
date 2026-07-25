"use client";

import { useCallback, useEffect, useState } from "react";
import { TYPE_HUE, TypeChip } from "../components/ui";

type Row = { id: string; title: string; type: string; source: string; tags: string[]; snippet: string };

const TYPES = ["", "note", "task", "idea", "shopping", "reference", "person", "event"];

// Import sources this screen curates. Keep in sync with IMPORT_SOURCES in
// app/api/imports/route.ts. "all" spans every source.
const SOURCES: { value: string; label: string }[] = [
  { value: "all", label: "all sources" },
  { value: "apple-notes", label: "Apple Notes" },
  { value: "chatgpt-profile", label: "ChatGPT profile" },
];

const SOURCE_LABEL: Record<string, string> = {
  "apple-notes": "Apple Notes",
  "chatgpt-profile": "ChatGPT profile",
};

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
      {/* search + source */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-control border border-hairline bg-surface-2 px-3.5 transition focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(80,107,242,0.25)]">
          <span className="text-ink-3">⌕</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(0, type, q, source)}
            placeholder="Search imports…  (Enter)"
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
          />
        </div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="h-11 rounded-control border border-hairline bg-surface-2 px-3 text-sm text-ink outline-none"
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value} className="bg-surface-1">
              {s.label}
              {s.value !== "all" && counts[s.value] != null ? ` (${counts[s.value]})` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* type filter chips */}
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {TYPES.map((t) => {
          const active = type === t;
          const hue = t ? TYPE_HUE[t] : undefined;
          return (
            <button
              key={t || "all"}
              onClick={() => setType(t)}
              className="shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition"
              style={
                active
                  ? { background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.92)" }
                  : t
                    ? { background: `color-mix(in srgb, ${hue} 12%, transparent)`, color: hue }
                    : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)" }
              }
            >
              {t || "All"}
            </button>
          );
        })}
      </div>

      <div className="mb-2 flex items-center justify-between px-1 text-xs text-ink-3">
        <button onClick={toggleAll} className="font-semibold text-ink-2 transition hover:text-ink">
          {allOnPage ? "Clear page" : "Select page"} · {selected.size} selected
        </button>
        <span>{total} on hold</span>
      </div>
      {notice && <p className="mb-2 px-1 text-xs text-ink-2">{notice}</p>}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="obx-skeleton h-14 rounded-card" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline-2 p-8 text-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-control bg-white/[0.06] text-ink-3">✓</div>
          <div className="text-[15px] font-semibold">Nothing left on hold here</div>
          <div className="text-[13px] text-ink-2">Try another source or filter.</div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-hairline bg-surface-1">
          {rows.map((r, idx) => {
            const sel = selected.has(r.id);
            const sub = [SOURCE_LABEL[r.source] ?? r.source, r.snippet].filter(Boolean).join(" · ");
            return (
              <div
                key={r.id}
                onClick={() => toggle(r.id)}
                className={`flex cursor-pointer items-center gap-3 p-4 transition ${idx > 0 ? "border-t border-hairline" : ""}`}
                style={sel ? { background: "rgba(80,107,242,0.08)" } : undefined}
              >
                <div
                  className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] text-[13px]"
                  style={sel ? { background: "#506bf2", color: "#fff" } : { border: "1.5px solid rgba(255,255,255,0.25)" }}
                >
                  {sel ? "✓" : ""}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-ink">{r.title}</div>
                  {sub && <div className="mt-0.5 truncate text-xs text-ink-3">{sub}</div>}
                </div>
                <TypeChip type={r.type} />
              </div>
            );
          })}
        </div>
      )}

      {total > limit && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            onClick={() => load(Math.max(0, offset - limit), type, q, source)}
            disabled={offset === 0 || loading}
            className="rounded-control bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-xs text-ink-3">
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => load(offset + limit, type, q, source)}
            disabled={offset + limit >= total || loading}
            className="rounded-control bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}

      {/* floating action bar — sits above the mobile tab bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-3 bottom-[calc(84px+env(safe-area-inset-bottom))] z-30 flex items-center gap-3 rounded-[18px] border border-hairline-2 bg-material-2 py-2.5 pl-5 pr-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-[20px] md:inset-x-auto md:left-1/2 md:bottom-6 md:-translate-x-1/2">
          <div className="flex-1 text-[14px] font-semibold md:flex-none md:pr-2">{selected.size} selected</div>
          <button
            onClick={() => act("activate")}
            disabled={busy}
            className="h-10 rounded-[11px] bg-accent px-4 text-[14px] font-semibold text-white transition disabled:opacity-50"
          >
            Activate
          </button>
          <button
            onClick={() => act("remove")}
            disabled={busy}
            className="h-10 rounded-[11px] bg-white/[0.08] px-4 text-[14px] font-semibold text-danger transition disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
