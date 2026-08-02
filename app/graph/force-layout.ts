// Obsidian-X — force-directed layout for the vault graph.
//
// NOT named layout.ts: inside app/, that filename is reserved by Next.js for a
// route layout and the build rejects it for lacking a default export.
//
// Pulled out of the component so it can be tested directly: it is pure, it is
// where the graph's one real failure mode lives, and a bug here is invisible in
// a screenshot until the canvas already looks empty.
//
// Deterministic on purpose (no Math.random) — the component renders this on the
// client only, but a non-deterministic layout would also make any future SSR
// hydrate with different coordinates.

export type GraphNode = { id: string; title: string; type: string };
export type GraphEdge = {
  source: string;
  target: string;
  /** Why this line exists, in plain words. Shown on hover. */
  reason?: string;
  /** A similarity guess rather than a stated fact — drawn dashed and fainter. */
  discovery?: boolean;
};
export type Pt = { x: number; y: number };

export const W = 1000;
export const H = 700;

/**
 * How far from centre a node may drift.
 *
 * Repulsion is the ONLY force acting on an isolated node — the centering pull
 * is deliberately weak (0.02) so clusters can separate. Over 220 iterations a
 * disconnected node therefore drifts thousands of units out, fitView frames
 * that whole expanse, and every node renders sub-pixel. That is exactly what
 * "23 nodes · 0 links" looked like on 2026-08-02: a canvas that appeared empty
 * apart from one stray label. A sparse graph must still be legible.
 */
export const MAX_RADIUS = 900;

export function layout(nodes: GraphNode[], edges: GraphEdge[]): Pt[] {
  const n = nodes.length;
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const E = edges
    .map((e) => [idx.get(e.source), idx.get(e.target)] as [number | undefined, number | undefined])
    .filter((e): e is [number, number] => e[0] != null && e[1] != null);

  // Deterministic jitter (not Math.random) so SSR and client hydrate identically.
  const jitter = (s: number) => {
    const v = Math.sin(s * 127.1) * 43758.5453;
    return (v - Math.floor(v) - 0.5) * 30;
  };
  const p: Pt[] = nodes.map((_, i) => ({
    x: W / 2 + Math.cos((i / n) * 2 * Math.PI) * 250 + jitter(i * 2 + 1),
    y: H / 2 + Math.sin((i / n) * 2 * Math.PI) * 250 + jitter(i * 2 + 2),
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

      // Keep every node inside a bounded field.
      //
      // Repulsion is the only force acting on an ISOLATED node, and the weak
      // centering pull (0.02) cannot hold it: over 220 iterations a node can
      // drift thousands of units out, fitView then frames that whole expanse,
      // and every node renders sub-pixel. That is exactly what "23 nodes · 0
      // links" looked like on 2026-08-02 — a canvas that appeared empty apart
      // from one stray label. A sparse graph must still be legible.
      const cx = p[i].x - W / 2;
      const cy = p[i].y - H / 2;
      const dist = Math.hypot(cx, cy);
      if (dist > MAX_RADIUS) {
        p[i].x = W / 2 + (cx / dist) * MAX_RADIUS;
        p[i].y = H / 2 + (cy / dist) * MAX_RADIUS;
      }
    }
  }
  return p;
}
