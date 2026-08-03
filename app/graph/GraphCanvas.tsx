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
 * Generous, because the node sizing below is what actually stops a small
 * cluster looking absurd. Clamping the zoom hard instead left a 6-node graph
 * marooned in the middle of an empty canvas — the fit was doing the right thing
 * and the clamp was undoing it.
 */
const MAX_INITIAL_ZOOM = 5;

/** On-screen node radius stays in this band whatever the zoom. */
const MIN_SCREEN_R = 3.5;
const MAX_SCREEN_R = 13;

const nodeColor = (n: Node) =>
  n.kind === "entity" ? ENTITY_COLOR : (TYPE_COLORS[n.sub] ?? TYPE_COLORS.note);

/**
 * Bigger with degree, but sub-linearly — one hub must not dwarf everything.
 *
 * Returned in WORLD units, derived from a target SCREEN size. Nodes drawn in
 * raw world units grow with the zoom, so a tight cluster arrived as dinner
 * plates with the labels shoved off the canvas; sizing from the screen back
 * means a node looks the same whether you are framed on two nodes or two
 * hundred.
 */
const nodeRadius = (n: Node, scale = 1) => {
  const target = (n.kind === "entity" ? 7 : 4.5) + Math.min(5, Math.sqrt(n.degree) * 1.8);
  const onScreen = Math.max(MIN_SCREEN_R, Math.min(MAX_SCREEN_R, target));
  return onScreen / scale;
};

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
  // Set when new data arrives; consumed once the physics settles. Framing on a
  // fixed timeout was a guess about how long the simulation takes, and on a
  // slower load it fired before the nodes had positions and framed empty space.
  const needsFrameRef = useRef(true);
  const frameFnRef = useRef<() => void>(() => {});
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
        const r = nodeRadius(n, scale);

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
      .nodePointerAreaPaint((node, color, ctx, scale) => {
        const n = node as Node;
        ctx.fillStyle = color;
        ctx.beginPath();
        // Generous hit area — a thumb is far bigger than a 4px dot.
        ctx.arc(n.x ?? 0, n.y ?? 0, nodeRadius(n, scale) + 8 / scale, 0, 2 * Math.PI);
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
      })
      // The simulation tells us when it has settled. Framing then is the only
      // way to be sure every node has a position to frame.
      .onEngineStop(() => {
        if (!needsFrameRef.current) return;
        needsFrameRef.current = false;
        frameFnRef.current();
      });

    setReady(true);
    return () => {
      g._destructor?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the canvas sized to its container — force-graph needs explicit pixels.
  //
  // AND re-frame afterwards. A fit is a function of the viewport, so one
  // computed before the canvas reached its final size is simply wrong: on load
  // the graph was framed against a placeholder size and the ResizeObserver then
  // moved the goalposts, leaving the nodes off-screen and the canvas looking
  // empty. This is worse on a phone, where layout settles latest.
  useEffect(() => {
    if (!ready || !holder.current) return;
    const el = holder.current;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const resize = () => {
      const g = graphRef.current;
      if (!g) return;
      g.width(el.clientWidth).height(el.clientHeight);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => frameFnRef.current(), 120);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (debounce) clearTimeout(debounce);
    };
  }, [ready]);

  // Feed data, then frame it once the engine settles.
  //
  // What to frame depends on what is on screen. Orphans hidden (the default)
  // means everything visible IS the connected structure, so fit all of it — the
  // brief's "not the whole sparse cloud" is already satisfied by the filter, and
  // framing only the biggest component leaves the second cluster in the dark.
  // Orphans shown: fall back to the largest component, or the cloud dominates
  // and the structure shrinks into a corner again.
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready) return;

    frameFnRef.current = () => {
      const framed = showOrphans
        ? new Set(view.nodes.filter((n) => n.component === 0).map((n) => n.id))
        : new Set(view.nodes.map((n) => n.id));
      if (framed.size > 1) g.zoomToFit(400, 60, (n) => framed.has((n as Node).id));
      else g.zoomToFit(400, 60);
      // Clamp after the fit animation lands. zoomToFit does what it says: with
      // a three-node cluster in a phone-width viewport it reaches ~10x, and
      // nodes drawn in world coordinates arrive as dinner plates.
      setTimeout(() => {
        if (g.zoom() > MAX_INITIAL_ZOOM) g.zoom(MAX_INITIAL_ZOOM, 250);
      }, 450);
    };

    needsFrameRef.current = true;
    g.graphData({ nodes: view.nodes as Node[], links: view.links as unknown as Link[] });

    // Backstop: if the engine was already cold when the data arrived,
    // onEngineStop may never fire again. Frame anyway rather than leave the
    // owner looking at empty space.
    const backstop = setTimeout(() => {
      if (!needsFrameRef.current) return;
      needsFrameRef.current = false;
      frameFnRef.current();
    }, 1500);
    return () => clearTimeout(backstop);
  }, [view, ready, showOrphans]);

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
