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

/* ---------------------------------------------------------------------------
   v4.0 W6 — one spacing rhythm, one card treatment, one control treatment.
   Every screen composes from the constants + primitives below rather than
   hand-rolling its own paddings, so "Apple-grade consistency" is enforced by
   sharing code, not by discipline.
   --------------------------------------------------------------------------- */

// The one card. Nested/inset surfaces use CARD_INSET.
export const CARD = "rounded-card border border-hairline bg-surface-1";
export const CARD_INSET = "rounded-control border border-hairline bg-surface-2";
// Grouped list container — rows separated by hairlines, corners clipped.
export const CARD_LIST = "overflow-hidden rounded-card border border-hairline bg-surface-1";

// Controls. Every interactive control is ≥44px tall (h-11) per the foundations
// sheet; `CTRL_SM` (h-9) is only for chips/secondary affordances inside a row
// that already has a 44px hit target around it.
const CTRL_BASE =
  "inline-flex h-11 items-center justify-center rounded-control px-5 text-[15px] font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
export const BTN_PRIMARY = `${CTRL_BASE} bg-accent text-white hover:bg-accent/90`;
export const BTN_SECONDARY = `${CTRL_BASE} bg-white/[0.08] text-ink hover:bg-white/[0.12]`;
export const BTN_QUIET = `${CTRL_BASE} bg-transparent text-ink-2 hover:text-ink`;
export const BTN_DANGER = `${CTRL_BASE} bg-white/[0.08] text-danger hover:bg-white/[0.12]`;

// Text fields: the wrapper carries the focus ring so an inline button can sit
// inside the same pill without breaking it.
export const FIELD =
  "flex items-center gap-2 rounded-control border border-hairline bg-surface-2 px-3.5 transition focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(80,107,242,0.25)]";
export const INPUT = "w-full bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3";

/**
 * The page container. One horizontal rhythm, one top rhythm, and bottom padding
 * that always clears the mobile tab bar + home indicator.
 */
export function PageMain({
  children,
  width = "wide",
  className = "",
}: {
  children: ReactNode;
  width?: "wide" | "narrow" | "full";
  className?: string;
}) {
  const max = width === "narrow" ? "max-w-2xl" : width === "full" ? "max-w-5xl" : "max-w-4xl";
  return (
    <main
      className={`obx-safe-x obx-pb-bar mx-auto w-full ${max} flex-1 px-4 pt-4 md:px-8 md:pt-8 ${className}`}
    >
      {children}
    </main>
  );
}

/**
 * The one header pattern: large title + quiet one-line subtitle, with an
 * optional trailing action. Present on every screen at both breakpoints — the
 * title shrinks on desktop, where the top nav already carries the wordmark.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-5 flex items-start justify-between gap-4 md:mb-6 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.022em] md:text-[22px]">{title}</h1>
        {subtitle != null && subtitle !== "" && (
          <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * The one empty state: a quiet glyph, an invitation, and a single line telling
 * the owner what will show up here. Never a bare "no data".
 */
export function EmptyState({
  glyph = "✓",
  title,
  body,
  action,
  bordered = true,
  className = "",
}: {
  glyph?: ReactNode;
  title: string;
  body: ReactNode;
  action?: ReactNode;
  /** Off when the empty state already sits inside a card — no border on border. */
  bordered?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-1.5 px-6 text-center ${
        bordered ? "rounded-card border border-dashed border-hairline-2 py-10" : "py-7"
      } ${className}`}
    >
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-control bg-white/[0.06] text-[17px] text-ink-3">
        {glyph}
      </div>
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      <div className="max-w-xs text-[13px] leading-relaxed text-ink-2">{body}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** The one loading treatment — a shimmer in the shape of what's coming. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`obx-skeleton rounded-control ${className}`} aria-hidden />;
}

export function SkeletonRows({ rows = 4, height = "h-14" }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`${height} rounded-card`} />
      ))}
    </div>
  );
}

/* --- Item inspector building blocks ---------------------------------------
   Shared by the deck's expanded card and any other surface that has to show an
   item's full story, so "see deeper" reads the same everywhere. */

/** A labelled block inside the inspector. */
export function InspectorSection({
  label,
  trailing,
  children,
  className = "",
}: {
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mt-5 ${className}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <SectionLabel>{label}</SectionLabel>
        {trailing && <span className="text-xs text-ink-3">{trailing}</span>}
      </div>
      {children}
    </section>
  );
}

/** A key/value line for the AI-reading block. */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-[13px]">
      <span className="w-[74px] shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 text-ink">{children}</span>
    </div>
  );
}

/** A neutral pill for tags/entities/values — the one non-semantic chip. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-medium text-ink-2">
      {children}
    </span>
  );
}
