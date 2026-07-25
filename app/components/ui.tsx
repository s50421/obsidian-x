// Obsidian-X — shared presentational primitives for the Apple-dark redesign.
// Pure (no hooks / browser APIs) so they render in both server and client
// components. Exact colors come straight from the design foundations sheet.
import type { CSSProperties, ReactNode } from "react";

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap";

// Item-type hues: [chip background, text/hue].
export const TYPE_HUE: Record<string, string> = {
  note: "#aebace",
  task: "#96b2ff",
  idea: "#c4abf8",
  shopping: "#93d8a8",
  reference: "#83d2cc",
  person: "#f0b487",
  event: "#f2a5b8",
};

const TYPE_BG: Record<string, string> = {
  note: "rgba(148,163,199,0.14)",
  task: "rgba(110,140,245,0.16)",
  idea: "rgba(168,130,240,0.16)",
  shopping: "rgba(90,190,120,0.15)",
  reference: "rgba(80,190,180,0.15)",
  person: "rgba(235,160,95,0.15)",
  event: "rgba(235,120,150,0.15)",
};

// Solid node/bar hues (Ops bars, Graph nodes) — a touch deeper than chip text.
export const TYPE_SOLID: Record<string, string> = {
  note: "#8e9ab0",
  task: "#6e8cf0",
  idea: "#a583ea",
  shopping: "#63be7e",
  reference: "#55beb4",
  person: "#e5a063",
  event: "#e87d9a",
};

export function TypeChip({ type }: { type: string }) {
  const hue = TYPE_HUE[type] ?? "#aebace";
  const bg = TYPE_BG[type] ?? "rgba(148,163,199,0.14)";
  return (
    <span className={CHIP_BASE} style={{ background: bg, color: hue }}>
      {type}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const dot =
    status === "done" ? "#93d8a8" : status === "archived" ? "rgba(255,255,255,0.35)" : "#96b2ff";
  const text = status === "archived" ? "rgba(255,255,255,0.45)" : dot;
  return (
    <span className={CHIP_BASE} style={{ background: "rgba(255,255,255,0.06)", color: text }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      {status}
    </span>
  );
}

export function PriorityChip({ priority }: { priority: string }) {
  const style: CSSProperties =
    priority === "high"
      ? { background: "rgba(240,138,128,0.15)", color: "#f49a91" }
      : priority === "medium"
        ? { background: "rgba(240,194,106,0.14)", color: "#f0c26a" }
        : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.55)" };
  return (
    <span className={CHIP_BASE} style={style}>
      {priority}
    </span>
  );
}

export function DuplicateChip() {
  return (
    <span className={CHIP_BASE} style={{ background: "rgba(240,194,106,0.14)", color: "#f0c26a" }}>
      ⚠ possible duplicate
    </span>
  );
}

export function LowConfidenceChip() {
  return (
    <span
      className={`${CHIP_BASE} border border-dashed`}
      style={{
        background: "rgba(255,255,255,0.06)",
        color: "rgba(255,255,255,0.55)",
        borderColor: "rgba(255,255,255,0.18)",
      }}
    >
      low confidence
    </span>
  );
}

// A quiet caps section label used above every card group.
export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-xs font-semibold uppercase tracking-[0.08em] text-ink-3 ${className}`}>
      {children}
    </div>
  );
}
