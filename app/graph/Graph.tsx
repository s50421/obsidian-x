"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { layout, W, H, type GraphEdge as Edge, type GraphNode as Node, type Pt } from "./force-layout";

// Node hues from the Apple-dark design foundations (match Ops bars + chips).
const COLORS: Record<string, string> = {
  note: "#8e9ab0",
  task: "#6e8cf0",
  idea: "#a583ea",
  shopping: "#63be7e",
  reference: "#55beb4",
  person: "#e5a063",
  event: "#e87d9a",
};
const color = (t: string) => COLORS[t] ?? "#8e9ab0";

// A small Fruchterman-Reingold-style force layout, computed in the browser.
// Fit the viewBox around the laid-out nodes (with padding) so the canvas opens
// framed on the graph rather than clustered in a corner.
function fitView(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  if (pts.length === 0) return { x: 0, y: 0, w: W, h: H };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 80;
  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(300, maxX - minX + pad * 2),
    h: Math.max(300, maxY - minY + pad * 2),
  };
}

export default function Graph({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  // Layout is computed on the client after mount only — the force sim uses
  // Math.sin/cos over many iterations, which isn't guaranteed bit-identical
  // between the SSR (Node) and client (browser) runtimes; running it during SSR
  // would flag a hydration mismatch. Server renders the empty canvas shell.
  const [pos, setPos] = useState<Pt[] | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
  useEffect(() => {
    const laid = layout(nodes, edges);
    setPos(laid);
    setView(fitView(laid));
  }, [nodes, edges]);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ node: number | null; panning: boolean; sx: number; sy: number; vx: number; vy: number }>(
    { node: null, panning: false, sx: 0, sy: 0, vx: 0, vy: 0 }
  );

  const idx = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);
  const showLabels = nodes.length <= 60;

  const toWorld = (clientX: number, clientY: number): Pt => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const onNodeDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current.node = i;
  };
  const onBgDown = (e: React.PointerEvent) => {
    drag.current.panning = true;
    drag.current.sx = e.clientX;
    drag.current.sy = e.clientY;
    drag.current.vx = view.x;
    drag.current.vy = view.y;
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current.node != null) {
      const w = toWorld(e.clientX, e.clientY);
      setPos((prev) => {
        if (!prev) return prev;
        const next = prev.slice();
        next[drag.current.node!] = w;
        return next;
      });
    } else if (drag.current.panning) {
      const scale = view.w / (svgRef.current?.clientWidth || W);
      setView((v) => ({
        ...v,
        x: drag.current.vx - (e.clientX - drag.current.sx) * scale,
        y: drag.current.vy - (e.clientY - drag.current.sy) * scale,
      }));
    }
  };
  const onUp = () => {
    drag.current.node = null;
    drag.current.panning = false;
  };
  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const c = toWorld(e.clientX, e.clientY);
    setView((v) => ({
      x: c.x - (c.x - v.x) * factor,
      y: c.y - (c.y - v.y) * factor,
      w: v.w * factor,
      h: v.h * factor,
    }));
  };

  const types = [...new Set(nodes.map((n) => n.type))];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="w-full touch-none rounded-card border border-hairline bg-[#08080b]"
        style={{ height: "min(72vh, 640px)" }}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
      >
        {pos &&
          edges.map((e, i) => {
            const a = pos[idx.get(e.source)!];
            const b = pos[idx.get(e.target)!];
            if (!a || !b) return null;
            // A guess looks like a guess. The single legacy link that survived
            // into 2026-08 was a similarity edge drawn identically to a fact,
            // which is a large part of why the graph read as random.
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#ffffff"
                strokeOpacity={e.discovery ? 0.07 : 0.16}
                strokeDasharray={e.discovery ? "3 4" : undefined}
              >
                {e.reason && <title>{e.reason}</title>}
              </line>
            );
          })}
        {pos &&
          nodes.map((nd, i) => (
            <g key={nd.id} transform={`translate(${pos[i].x},${pos[i].y})`} onPointerDown={onNodeDown(i)} className="cursor-grab">
              <circle r={9} fill={color(nd.type)} />
              <title>{nd.title} ({nd.type})</title>
              {showLabels && (
                <text x={13} y={4} fontSize={11} fill="rgba(255,255,255,0.7)" className="pointer-events-none select-none">
                  {nd.title.length > 28 ? nd.title.slice(0, 28) + "…" : nd.title}
                </text>
              )}
            </g>
          ))}
      </svg>

      {/* floating material legend */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap gap-x-3 gap-y-1.5 rounded-card border border-hairline-2 bg-material-2 px-4 py-2.5 backdrop-blur-[20px] md:right-auto">
        {types.map((t) => (
          <span key={t} className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-2">
            <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: color(t) }} />
            {t}
          </span>
        ))}
      </div>
      <div className="mt-2.5 px-1 text-xs text-ink-3">Drag nodes · scroll to zoom · drag background to pan</div>
    </div>
  );
}
