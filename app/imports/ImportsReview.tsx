"use client";

import { useCallback, useEffect, useState } from "react";
import { CARD_LIST, EmptyState, FIELD, INPUT, SkeletonRows, TYPE_HUE, TypeChip } from "../components/ui";

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

const PAGER =
  "inline-flex h-11 items-center rounded-control bg-white/[0.08] px-4 text-[13px] font-semibold text-ink transition hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-40";

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
        <div className={`${FIELD} h-11 min-w-0 flex-1`}>
          <span className="text-ink-3">⌕</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(0, type, q, source)}
            placeholder="Search imports…"
            aria-label="Search imports"
            className={INPUT}
          />
        </div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-label="Import source"
          className="h-11 rounded-control border border-hairline bg-surface-2 px-3 text-[15px] text-ink outline-none transition focus:border-accent"
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
              className="inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-[13px] font-semibold transition"
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

      <div className="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-ink-3">
        <button
          onClick={toggleAll}
          className="-ml-1 inline-flex min-h-9 items-center rounded-control px-1 font-semibold text-ink-2 transition hover:text-ink"
        >
          {allOnPage ? "Clear page" : "Select page"} · {selected.size} selected
        </button>
        <span className="tabular-nums">{total} on hold</span>
      </div>
      {notice && <p className="mb-2 px-1 text-xs text-ink-2">{notice}</p>}

      {loading ? (
        <SkeletonRows rows={6} height="h-16" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing left on hold here"
          body="Either this source is fully triaged, or the filter is too narrow — try another source or type."
        />
      ) : (
        <div className={CARD_LIST}>
          {rows.map((r, idx) => {
            const sel = selected.has(r.id);
            const sub = [SOURCE_LABEL[r.source] ?? r.source, r.snippet].filter(Boolean).join(" · ");
            return (
              <div
                key={r.id}
                onClick={() => toggle(r.id)}
                role="checkbox"
                aria-checked={sel}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(r.id);
                  }
                }}
                className={`flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/[0.03] ${idx > 0 ? "border-t border-hairline" : ""}`}
                style={sel ? { background: "rgba(80,107,242,0.08)" } : undefined}
              >
                <div
                  className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] text-[13px]"
                  style={sel ? { background: "#506bf2", color: "#fff" } : { border: "1.5px solid rgba(255,255,255,0.25)" }}
                >
                  {sel ? "✓" : ""}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium text-ink">{r.title}</div>
                  {sub && <div className="mt-0.5 truncate text-[13px] text-ink-3">{sub}</div>}
                </div>
                <TypeChip type={r.type} />
              </div>
            );
          })}
        </div>
      )}

      {total > limit && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            onClick={() => load(Math.max(0, offset - limit), type, q, source)}
            disabled={offset === 0 || loading}
            className={PAGER}
          >
            ← Prev
          </button>
          <span className="text-xs tabular-nums text-ink-3">
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => load(offset + limit, type, q, source)}
            disabled={offset + limit >= total || loading}
            className={PAGER}
          >
            Next →
          </button>
        </div>
      )}

      {/* Floating action bar — clears the mobile tab bar and the home indicator. */}
      {selected.size > 0 && (
        <div className="obx-safe-x fixed inset-x-3 bottom-[calc(88px+env(safe-area-inset-bottom))] z-30 flex items-center gap-2.5 rounded-card border border-hairline-2 bg-material-2 py-2.5 pl-5 pr-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-[20px] md:inset-x-auto md:bottom-6 md:left-1/2 md:-translate-x-1/2">
          <div className="flex-1 text-[14px] font-semibold tabular-nums md:flex-none md:pr-2">
            {selected.size} selected
          </div>
          <button
            onClick={() => act("activate")}
            disabled={busy}
            className="inline-flex h-11 items-center rounded-control bg-accent px-4 text-[14px] font-semibold text-white transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          >
            Activate
          </button>
          <button
            onClick={() => act("remove")}
            disabled={busy}
            className="inline-flex h-11 items-center rounded-control bg-white/[0.08] px-4 text-[14px] font-semibold text-danger transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
