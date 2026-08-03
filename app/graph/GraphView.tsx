"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { GraphLinkData, GraphNodeData, GraphPayload } from "@/lib/graph-data";

// The client boundary. Two jobs:
//
// 1. `ssr: false` — per the Next 16 docs, that option ONLY works from inside a
//    Client Component, so a server page cannot dynamically import the canvas
//    directly. This wrapper is what makes the renderer client-only, which is
//    the v2.5 hydration lesson: the previous SVG graph ran its force layout
//    during SSR and hydrated with different coordinates.
//
// 2. All the controls the brief asks for — type filters, edge-kind toggles,
//    search, the orphans switch — so the canvas itself stays a renderer.

const GraphCanvas = dynamic(() => import("./GraphCanvas"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center text-[13px] text-ink-3">
      Laying out the graph…
    </div>
  ),
});

const TYPE_COLORS: Record<string, string> = {
  note: "#8e9ab0",
  task: "#6e8cf0",
  idea: "#a583ea",
  shopping: "#63be7e",
  reference: "#55beb4",
  person: "#e5a063",
  event: "#e87d9a",
  memory: "#c7b3f5",
};

const KIND_LABEL: Record<string, string> = {
  shared_person: "same person",
  shared_org: "same organisation",
  shared_place: "same place",
  shared_topic: "same topic",
  reference: "reference",
  thread: "same thread",
  similar: "reads similarly",
};

function Chip({
  on,
  onClick,
  color,
  children,
}: {
  on: boolean;
  onClick: () => void;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-[12px] transition-colors"
      style={{
        borderColor: on ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)",
        color: on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.38)",
        background: on ? "rgba(255,255,255,0.06)" : "transparent",
      }}
    >
      {color && (
        <span
          className="inline-block h-[7px] w-[7px] rounded-full"
          style={{ background: color, opacity: on ? 1 : 0.4 }}
        />
      )}
      {children}
    </button>
  );
}

export default function GraphView({ data }: { data: GraphPayload }) {
  const types = useMemo(
    () => [...new Set(data.nodes.filter((n) => n.kind === "item").map((n) => n.sub))].sort(),
    [data]
  );
  const kinds = useMemo(() => [...new Set(data.links.map((l) => l.kind))].sort(), [data]);

  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set(types));
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set(kinds));
  // Hidden by default. With a sparse brain the orphans ARE the canvas, and
  // framing them is what made the old graph unreadable.
  const [showOrphans, setShowOrphans] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GraphNodeData | null>(null);
  const [tappedLink, setTappedLink] = useState<GraphLinkData | null>(null);

  const toggle = (set: Set<string>, v: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };

  const label = (id: string) => data.nodes.find((n) => n.id === id)?.label ?? id;
  const orphanCount = data.counts.items + data.counts.entities - connectedCount(data);

  return (
    <div className="flex flex-col gap-3">
      {/* controls */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search to focus a node…"
            className="min-w-0 flex-1 rounded-control border border-hairline bg-surface-1 px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
          <Chip on={showOrphans} onClick={() => setShowOrphans((v) => !v)}>
            {showOrphans ? "Hiding nothing" : `${orphanCount} unconnected hidden`}
          </Chip>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {types.map((t) => (
            <Chip
              key={t}
              on={typeFilter.has(t)}
              color={TYPE_COLORS[t] ?? TYPE_COLORS.note}
              onClick={() => toggle(typeFilter, t, setTypeFilter)}
            >
              {t}
            </Chip>
          ))}
        </div>

        {kinds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-ink-3">Connections</span>
            {kinds.map((k) => (
              <Chip key={k} on={kindFilter.has(k)} onClick={() => toggle(kindFilter, k, setKindFilter)}>
                {KIND_LABEL[k] ?? k}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* canvas */}
      <div
        className="relative overflow-hidden rounded-card border border-hairline bg-[#08080b]"
        style={{ height: "min(68vh, 620px)" }}
      >
        <GraphCanvas
          data={data}
          showOrphans={showOrphans}
          typeFilter={typeFilter}
          kindFilter={kindFilter}
          query={query}
          onSelect={setSelected}
          onLinkTap={setTappedLink}
        />

        {/* Tap an edge → what it MEANS, in plain words. The brief's exit test. */}
        {tappedLink && (
          <div className="absolute inset-x-3 bottom-3 rounded-card border border-hairline-2 bg-material-2 px-4 py-3 backdrop-blur-[20px]">
            <div className="text-[11px] uppercase tracking-wide text-ink-3">
              {KIND_LABEL[tappedLink.kind] ?? tappedLink.kind}
            </div>
            <div className="mt-1 text-[13px] leading-relaxed text-ink">{tappedLink.reason}</div>
            <div className="mt-1.5 text-xs text-ink-3">
              {label(tappedLink.source)} ↔ {label(tappedLink.target)}
            </div>
          </div>
        )}

        {selected && !tappedLink && (
          <div className="absolute inset-x-3 bottom-3 rounded-card border border-hairline-2 bg-material-2 px-4 py-3 backdrop-blur-[20px]">
            <div className="text-[11px] uppercase tracking-wide text-ink-3">
              {selected.kind === "entity" ? selected.sub : selected.sub}
              {selected.degree > 0 ? ` · ${selected.degree} connection${selected.degree === 1 ? "" : "s"}` : " · unconnected"}
            </div>
            <div className="mt-1 text-[14px] font-semibold leading-snug text-ink">{selected.label}</div>
            {selected.kind === "item" && (
              // The item's OWN page, not the deck. The deck is a daily review
              // sweep — sending someone there to look one thing up made no
              // sense, as the owner pointed out.
              <Link
                href={`/item/${selected.id}`}
                className="mt-1.5 inline-block text-[13px] font-medium text-accent-text hover:underline"
              >
                Open this memory →
              </Link>
            )}
          </div>
        )}
      </div>

      <p className="px-1 text-xs leading-relaxed text-ink-3">
        Drag to pan · scroll or pinch to zoom · tap a line to see why it exists.
        {data.counts.suggested > 0 && (
          <>
            {" "}
            {data.counts.suggested} suggested connection{data.counts.suggested === 1 ? " is" : "s are"} waiting
            in the deck — only ones you confirm appear here.
          </>
        )}
      </p>
    </div>
  );
}

function connectedCount(data: GraphPayload): number {
  const seen = new Set<string>();
  for (const l of data.links) {
    seen.add(l.source);
    seen.add(l.target);
  }
  return seen.size;
}
