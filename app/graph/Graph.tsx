"use client";

import { useMemo, useRef, useState } from "react";

type Node = { id: string; title: string; type: string };
type Edge = { source: string; target: string };
type Pt = { x: number; y: number };

const W = 1000;
const H = 700;

const COLORS: Record<string, string> = {
  task: "#ef4444",
  note: "#3b82f6",
  idea: "#eab308",
  shopping: "#22c55e",
  reference: "#a855f7",
  person: "#ec4899",
  event: "#f97316",
};
const color = (t: string) => COLORS[t] ?? "#9ca3af";

// A small Fruchterman-Reingold-style force layout, computed in the browser.
function layout(nodes: Node[], edges: Edge[]): Pt[] {
  const n = nodes.length;
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const E = edges
    .map((e) => [idx.get(e.source), idx.get(e.target)] as [number | undefined, number | undefined])
    .filter((e): e is [number, number] => e[0] != null && e[1] != null);

  const p: Pt[] = nodes.map((_, i) => ({
    x: W / 2 + Math.cos((i / n) * 2 * Math.PI) * 250 + (Math.random() - 0.5) * 30,
    y: H / 2 + Math.sin((i / n) * 2 * Math.PI) * 250 + (Math.random() - 0.5) * 30,
  }));

  const k = Math.max(30, Math.sqrt((W * H) / Math.max(1, n)) * 0.6);
  const iters = n > 300 ? 90 : 220;
  for (let it = 0; it < iters; it++) {
    const disp: Pt[] = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (k * k) / d;
        dx /= d;
        dy /= d;
        disp[i].x += dx * f;
        disp[i].y += dy * f;
        disp[j].x -= dx * f;
        disp[j].y -= dy * f;
      }
    }
    for (const [a, b] of E) {
      let dx = p[a].x - p[b].x;
      let dy = p[a].y - p[b].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      dx /= d;
      dy /= d;
      disp[a].x -= dx * f;
      disp[a].y -= dy * f;
      disp[b].x += dx * f;
      disp[b].y += dy * f;
    }
    const temp = Math.max(1, 40 * (1 - it / iters));
    for (let i = 0; i < n; i++) {
      disp[i].x += (W / 2 - p[i].x) * 0.02;
      disp[i].y += (H / 2 - p[i].y) * 0.02;
      const dl = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      p[i].x += (disp[i].x / dl) * Math.min(dl, temp);
      p[i].y += (disp[i].y / dl) * Math.min(dl, temp);
    }
  }
  return p;
}

export default function Graph({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const [pos, setPos] = useState<Pt[]>(() => layout(nodes, edges));
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
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
    <div>
      <div className="mb-2 flex flex-wrap gap-2 text-xs">
        {types.map((t) => (
          <span key={t} className="flex items-center gap-1 opacity-80">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color(t) }} />
            {t}
          </span>
        ))}
        <span className="opacity-50">· drag nodes · scroll to zoom · drag background to pan</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="w-full touch-none rounded-lg border border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.02]"
        style={{ height: "min(70vh, 620px)" }}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
      >
        {edges.map((e, i) => {
          const a = pos[idx.get(e.source)!];
          const b = pos[idx.get(e.target)!];
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.15} />;
        })}
        {nodes.map((nd, i) => (
          <g key={nd.id} transform={`translate(${pos[i].x},${pos[i].y})`} onPointerDown={onNodeDown(i)} className="cursor-grab">
            <circle r={8} fill={color(nd.type)} stroke="white" strokeWidth={1.5} />
            <title>{nd.title} ({nd.type})</title>
            {showLabels && (
              <text x={11} y={4} fontSize={11} fill="currentColor" className="pointer-events-none select-none">
                {nd.title.length > 28 ? nd.title.slice(0, 28) + "…" : nd.title}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
