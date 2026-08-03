"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph from "force-graph";
import type { GraphLinkData, GraphNodeData, GraphPayload } from "@/lib/graph-data";

// Obsidian-X — the graph, on a real renderer (graph-redesign-brief scope 1-5).
//
// Replaces a hand-rolled SVG force layout. That version had two problems the
// brief names: it could not stay legible (with few links, repulsion pushed
// nodes thousands of units apart and the auto-fit rendered every one
// sub-pixel), and it drew every edge identically so no line could say what it
// meant.
//
// `force-graph` is the canvas renderer the brief calls for: zero dependencies,
// its own physics, and it hands us the 2D context so nodes and labels can be
// drawn to the legibility bar rather than left as default dots.
//
// CLIENT-ONLY, and that is load-bearing. The v2.5 lesson: the old SVG layout
// ran Math.sin/cos over hundreds of iterations during SSR and hydrated with
// different coordinates, which React flagged as a mismatch. This component is
// imported with `ssr: false` from GraphView — and per the Next 16 docs, that
// option only works from inside a Client Component, which is why GraphView
// exists at all.

type Node = GraphNodeData & { x?: number; y?: number };
// Omit, not intersect: force-graph MUTATES links in place, replacing the string
// ids with the node objects once the simulation starts, so these fields are
// genuinely one type or the other over the object's life. Intersecting with the
// original string type collapses the object branch to `never`.
type Link = Omit<GraphLinkData, "source" | "target"> & {
  source: Node | string;
  target: Node | string;
};

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
const ENTITY_COLOR = "#9DB2FF";

// Edge styling by kind (brief: "entity edges solid, topic edges medium,
// similar edges thin/dim"). Only confirmed edges are ever drawn, so `similar`
// appears here only if the owner accepted one.
const LINK_STYLE: Record<string, { color: string; width: number; dash?: number[] }> = {
  shared_person: { color: "rgba(157,178,255,0.55)", width: 2 },
  shared_org: { color: "rgba(157,178,255,0.45)", width: 1.8 },
  shared_place: { color: "rgba(157,178,255,0.45)", width: 1.8 },
  shared_topic: { color: "rgba(255,255,255,0.20)", width: 1.2 },
  reference: { color: "rgba(255,255,255,0.30)", width: 1.5 },
  thread: { color: "rgba(255,255,255,0.18)", width: 1 },
  similar: { color: "rgba(255,255,255,0.16)", width: 1, dash: [3, 4] },
};

/**
 * Ceiling on the OPENING zoom.
 *
 * zoomToFit does what it says — with a 3-node cluster in a 400px-wide viewport
 * it happily zooms to 10x, and since nodes are drawn in world coordinates they
 * arrive as dinner plates with their labels pushed off-screen. Framing the
 * largest component is right; framing it at any magnification is not. Panning
 * and pinching past this afterwards is unrestricted.
 */
const MAX_INITIAL_ZOOM = 1.8;

const nodeColor = (n: Node) =>
  n.kind === "entity" ? ENTITY_COLOR : (TYPE_COLORS[n.sub] ?? TYPE_COLORS.note);

/** Bigger with degree, but sub-linearly — one hub must not dwarf everything. */
const nodeRadius = (n: Node) => (n.kind === "entity" ? 7 : 4) + Math.min(6, Math.sqrt(n.degree) * 2);

export type GraphCanvasProps = {
  data: GraphPayload;
  showOrphans: boolean;
  typeFilter: Set<string>;
  kindFilter: Set<string>;
  query: string;
  onSelect: (node: GraphNodeData | null) => void;
  onLinkTap: (link: GraphLinkData | null) => void;
};

export default function GraphCanvas({
  data,
  showOrphans,
  typeFilter,
  kindFilter,
  query,
  onSelect,
  onLinkTap,
}: GraphCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph<Node, Link> | null>(null);
  const hoverRef = useRef<Node | null>(null);
  const neighbourRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  // Filtered view of the data. Orphans are hidden by default: with a sparse
  // brain they are most of the canvas and they push the interesting structure
  // into a corner, which is exactly what the legibility bar forbids. Obsidian
  // ships the same toggle.
  const view = useMemo(() => {
    const links = data.links.filter((l) => kindFilter.has(l.kind));
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const nodes = data.nodes
      .filter((n) => (n.kind === "entity" ? true : typeFilter.has(n.sub)))
      .filter((n) => showOrphans || (degree.get(n.id) ?? 0) > 0)
      .map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    const present = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      links: links.filter((l) => present.has(l.source) && present.has(l.target)),
    };
  }, [data, showOrphans, typeFilter, kindFilter]);

  // Create the instance once. Re-creating it on every data change would restart
  // the simulation and throw away the layout the owner is looking at.
  useEffect(() => {
    if (!holder.current || graphRef.current) return;
    const g = new ForceGraph<Node, Link>(holder.current);
    graphRef.current = g;

    g.backgroundColor("#08080b")
      .nodeId("id")
      .nodeRelSize(1)
      .linkSource("source")
      .linkTarget("target")
      .cooldownTicks(120)
      .d3AlphaDecay(0.03)
      .d3VelocityDecay(0.35)
      .nodeCanvasObject((node, ctx, scale) => {
        const n = node as Node;
        const hovering = hoverRef.current;
        // Hover dims everything that is not the node or its neighbours, which
        // is how a dense area becomes readable without zooming.
        const dim = hovering ? (n.id === hovering.id || neighbourRef.current.has(n.id) ? 1 : 0.15) : 1;
        const r = nodeRadius(n);

        ctx.globalAlpha = dim;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
        if (n.kind === "entity") {
          // Dashed ring for people/orgs/places, per the brief — an entity is a
          // different KIND of thing from a memory and must not read as one.
          ctx.fillStyle = "rgba(80,107,242,0.18)";
          ctx.fill();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = ENTITY_COLOR;
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = nodeColor(n);
          ctx.fill();
        }

        // LABELS AT REST. The owner's legibility bar: readable without zooming.
        // Font size is divided by the zoom scale so it stays a constant size on
        // screen, and a backing plate keeps it legible over a line.
        const label = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
        const fontPx = (n.kind === "entity" ? 13 : 11) / scale;
        ctx.font = `${n.kind === "entity" ? 600 : 400} ${fontPx}px -apple-system, system-ui, sans-serif`;
        const w = ctx.measureText(label).width;
        const lx = (n.x ?? 0) + r + 3 / scale;
        const ly = (n.y ?? 0) + fontPx / 3;

        ctx.globalAlpha = dim * 0.75;
        ctx.fillStyle = "rgba(8,8,11,0.72)";
        ctx.fillRect(lx - 1 / scale, ly - fontPx * 0.85, w + 2 / scale, fontPx * 1.15);
        ctx.globalAlpha = dim;
        ctx.fillStyle = n.kind === "entity" ? ENTITY_COLOR : "rgba(255,255,255,0.9)";
        ctx.fillText(label, lx, ly);
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        const n = node as Node;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, nodeRadius(n) + 4, 0, 2 * Math.PI);
        ctx.fill();
      })
      .linkCanvasObject((link, ctx, scale) => {
        const l = link as Link;
        const s = l.source as Node;
        const t = l.target as Node;
        if (!s?.x || !t?.x) return;
        const style = LINK_STYLE[l.kind] ?? LINK_STYLE.similar;
        const hovering = hoverRef.current;
        const lit = !hovering || s.id === hovering.id || t.id === hovering.id;

        ctx.globalAlpha = lit ? 1 : 0.12;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width / scale;
        if (style.dash) ctx.setLineDash(style.dash.map((d) => d / scale));
        ctx.beginPath();
        ctx.moveTo(s.x, s.y ?? 0);
        ctx.lineTo(t.x, t.y ?? 0);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      })
      .linkPointerAreaPaint((link, color, ctx) => {
        const l = link as Link;
        const s = l.source as Node;
        const t = l.target as Node;
        if (!s?.x || !t?.x) return;
        // A 1px line is untappable on a phone; widen the hit area so "tap an
        // edge to see why it exists" actually works with a thumb.
        ctx.strokeStyle = color;
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y ?? 0);
        ctx.lineTo(t.x, t.y ?? 0);
        ctx.stroke();
      })
      .onNodeHover((node) => {
        const n = (node as Node) ?? null;
        hoverRef.current = n;
        const near = new Set<string>();
        if (n) {
          for (const l of view.links) {
            if (l.source === n.id) near.add(l.target);
            else if (l.target === n.id) near.add(l.source);
          }
        }
        neighbourRef.current = near;
        if (holder.current) holder.current.style.cursor = n ? "pointer" : "grab";
      })
      .onNodeClick((node) => {
        onSelect((node as Node) ?? null);
        onLinkTap(null);
      })
      .onLinkClick((link) => {
        const l = link as Link;
        const s = typeof l.source === "string" ? l.source : l.source.id;
        const t = typeof l.target === "string" ? l.target : l.target.id;
        onLinkTap({ source: s, target: t, kind: l.kind, reason: l.reason });
        onSelect(null);
      })
      .onBackgroundClick(() => {
        onSelect(null);
        onLinkTap(null);
      });

    setReady(true);
    return () => {
      g._destructor?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the canvas sized to its container — force-graph needs explicit pixels.
  useEffect(() => {
    if (!ready || !holder.current) return;
    const el = holder.current;
    const resize = () => {
      graphRef.current?.width(el.clientWidth).height(el.clientHeight);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  // Feed data, then frame the LARGEST CONNECTED COMPONENT rather than
  // everything. Fitting the whole sparse cloud is what made the old graph
  // render every node sub-pixel; the interesting structure is the big cluster.
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready) return;
    g.graphData({ nodes: view.nodes as Node[], links: view.links as unknown as Link[] });
    let clamp: ReturnType<typeof setTimeout> | null = null;
    const t = setTimeout(() => {
      const inBiggest = new Set(
        view.nodes.filter((n) => n.component === 0).map((n) => n.id)
      );
      // zoomToFit's filter runs per node; falling back to everything when the
      // biggest component is a single node avoids zooming to infinity.
      if (inBiggest.size > 1) {
        g.zoomToFit(600, 70, (n) => inBiggest.has((n as Node).id));
      } else {
        g.zoomToFit(600, 70);
      }
      // Clamp once the fit animation has landed.
      clamp = setTimeout(() => {
        if (g.zoom() > MAX_INITIAL_ZOOM) g.zoom(MAX_INITIAL_ZOOM, 300);
      }, 700);
    }, 700);
    return () => {
      clearTimeout(t);
      if (clamp) clearTimeout(clamp);
    };
  }, [view, ready]);

  // Search flies to the first match (brief: "search box = fly-to-node").
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const hit = view.nodes.find((n) => n.label.toLowerCase().includes(q)) as Node | undefined;
    if (hit?.x != null && hit?.y != null) {
      g.centerAt(hit.x, hit.y, 600);
      g.zoom(3.5, 600);
    }
  }, [query, view, ready]);

  return <div ref={holder} className="absolute inset-0" />;
}
