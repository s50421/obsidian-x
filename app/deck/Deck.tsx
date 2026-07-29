"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DeckCard } from "@/app/api/deck/route";
import DeckDetail from "../components/DeckDetail";
import { PriorityChip, TypeChip } from "../components/ui";
import {
  decideSwipe,
  rotationForDrag,
  springSettled,
  stepSpring,
  velocityFromSamples,
  type Spring1D,
  type SwipeDir,
} from "./spring";

// v4.0 W3 — the swipe deck. One orchestrator, two modes (daily / import),
// driven entirely by app/api/deck (GET) + app/api/deck/act (POST). The card
// stack + drag physics live here; the tap-to-expand full-detail sheet is
// DeckDetail.tsx. No external animation/gesture library — pointer events +
// CSS transforms + the tiny spring in ./spring.ts.

type Mode = "daily" | "import";
type UndoDescriptor = Record<string, unknown>;

type ApiResponse = {
  mode: Mode;
  total: number;
  reviewed: number;
  cards: DeckCard[];
  nextCursor: string | null;
};

const UNDO_MS = 5000;
const EXIT_MS = 220;
const DEFAULT_CARD_WIDTH = 340;
const TAP_MOVE_TOLERANCE = 6; // px — below this, a pointer down/up pair is a tap, not a drag

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Optimistic local patch after an inline edit is saved — mirrors the two
// shapes DeckDetail.onSaveEdit can send (see its `save()`).
function applyEditToCard(mode: Mode, card: DeckCard, patch: Record<string, unknown>): DeckCard {
  if (mode === "daily") {
    return {
      ...card,
      title: typeof patch.title === "string" ? patch.title : card.title,
      type: typeof patch.type === "string" ? patch.type : card.type,
      tags: Array.isArray(patch.tags) ? (patch.tags as string[]) : card.tags,
    };
  }
  return {
    ...card,
    title: typeof patch.newTitle === "string" ? (patch.newTitle as string) : card.title,
    newType: typeof patch.newType === "string" ? (patch.newType as string) : card.newType,
    newTags: Array.isArray(patch.newTags) ? (patch.newTags as string[]) : card.newTags,
  };
}

function actionForDir(mode: Mode, dir: SwipeDir): "keep" | "archive" | "approve" | "reject" {
  if (mode === "daily") return dir === "right" ? "keep" : "archive";
  return dir === "right" ? "approve" : "reject";
}

function defaultMessageFor(action: string): string {
  switch (action) {
    case "keep":
      return "Kept";
    case "archive":
      return "Archived";
    case "approve":
      return "Approved";
    case "reject":
      return "Rejected";
    default:
      return "Done";
  }
}

function SwipeBadge({ dir, mode }: { dir: SwipeDir; mode: Mode }) {
  const label =
    mode === "daily" ? (dir === "right" ? "KEEP" : "ARCHIVE") : dir === "right" ? "APPROVE" : "REJECT";
  const color = dir === "right" ? "#93d8a8" : "#f49a91";
  return (
    <div
      className={`pointer-events-none absolute top-6 rounded-control border-2 px-3 py-1 text-sm font-extrabold tracking-wider ${
        dir === "right" ? "left-6 -rotate-12" : "right-6 rotate-12"
      }`}
      style={{ color, borderColor: color, background: "rgba(10,10,13,0.55)" }}
    >
      {label}
    </div>
  );
}

function CardFront({ card, mode }: { card: DeckCard; mode: Mode }) {
  const isImport = mode === "import";
  const displayType = isImport ? (card.newType ?? card.type) : card.type;
  const displayTags = isImport ? (card.newTags ?? card.tags) : card.tags;
  return (
    <div className="flex h-full select-none flex-col p-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {isImport ? `Proposed ${card.proposalKind ?? "retitle"}` : "Today"}
        </span>
        {isImport && card.confidence != null && (
          <span className="text-[11px] font-medium text-ink-3">{Math.round(card.confidence * 100)}% confident</span>
        )}
      </div>

      <div className="mt-3 flex-1 overflow-hidden">
        <h2 className="line-clamp-4 text-[21px] font-bold leading-snug text-ink">{card.title}</h2>
        {isImport && card.subtitle && (
          <p className="mt-1.5 line-clamp-1 text-[13px] text-ink-3 line-through decoration-ink-3/60">{card.subtitle}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <TypeChip type={displayType} />
          {card.priority && <PriorityChip priority={card.priority} />}
          {displayTags.slice(0, 4).map((t) => (
            <span key={t} className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-medium text-ink-2">
              #{t}
            </span>
          ))}
          {displayTags.length > 4 && <span className="text-xs text-ink-3">+{displayTags.length - 4}</span>}
        </div>

        {!isImport && <p className="mt-4 line-clamp-5 text-[14px] leading-relaxed text-ink-2">{card.body}</p>}
        {isImport && card.reason && (
          <p className="mt-4 line-clamp-3 text-[13px] leading-relaxed text-accent-text">{card.reason}</p>
        )}
        {isImport && card.proposalKind === "split" && card.parts && (
          <p className="mt-3 text-xs text-ink-3">splits into {card.parts.length} items — tap to preview</p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-ink-3">
        <span>
          {card.source} · {timeAgo(card.createdAt)}
        </span>
        <span>tap for full memory</span>
      </div>
    </div>
  );
}

function DeckSkeleton() {
  return (
    <div className="relative mx-auto h-[60vh] max-h-[540px] w-full max-w-sm">
      <div className="obx-skeleton absolute inset-0 rounded-card border border-hairline" style={{ transform: "scale(0.96) translateY(10px)" }} />
      <div className="obx-skeleton absolute inset-0 rounded-card border border-hairline-2" />
    </div>
  );
}

function DeckClear({
  mode,
  total,
  reviewed,
  counts,
}: {
  mode: Mode;
  total: number;
  reviewed: number;
  counts: { right: number; left: number };
}) {
  const rightLabel = mode === "daily" ? "kept" : "approved";
  const leftLabel = mode === "daily" ? "archived" : "rejected";
  return (
    <div className="flex h-[60vh] max-h-[540px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-hairline-2 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06] text-2xl">🃏</div>
      <div className="text-[17px] font-semibold text-ink">Deck clear</div>
      {counts.right + counts.left > 0 && (
        <div className="text-[13px] text-ink-2">
          {counts.right} {rightLabel} · {counts.left} {leftLabel} this sweep
        </div>
      )}
      <div className="text-[12px] text-ink-3">
        {reviewed} of {total} total
      </div>
    </div>
  );
}

export default function Deck() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialMode: Mode = searchParams.get("mode") === "import" ? "import" : "daily";

  const [mode, setMode] = useState<Mode>(initialMode);
  const [queue, setQueue] = useState<DeckCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const [baseReviewed, setBaseReviewed] = useState(0);
  const [sessionActed, setSessionActed] = useState(0);
  const [sessionCounts, setSessionCounts] = useState({ right: 0, left: 0 });
  const [loading, setLoading] = useState(true);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: UndoDescriptor; card: DeckCard; dir: SwipeDir } | null>(
    null
  );
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exit, setExit] = useState<SwipeDir | null>(null);
  // Rendered card width — mirrored into state (from the pointerdown handler)
  // so the rotation transform in JSX reads from state, not a ref, during
  // render.
  const [cardWidth, setCardWidth] = useState(DEFAULT_CARD_WIDTH);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    pointerId: number | null;
    samples: { t: number; x: number }[];
    cardWidth: number;
  }>({ startX: 0, startY: 0, pointerId: null, samples: [], cardWidth: DEFAULT_CARD_WIDTH });
  const springRAF = useRef<number | null>(null);

  const top = queue[0] ?? null;
  const next = queue[1] ?? null;
  const reviewed = Math.min(total, baseReviewed + sessionActed);

  const clearToastTimer = () => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
  };

  const load = useCallback(async (m: Mode) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deck?mode=${m}&limit=20`);
      if (!res.ok) throw new Error("Failed to load the deck");
      const data: ApiResponse = await res.json();
      setQueue(data.cards);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
      setTotal(data.total);
      setBaseReviewed(data.reviewed);
      setSessionActed(0);
      setSessionCounts({ right: 0, left: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
      setInitialLoadDone(true);
    }
  }, []);

  useEffect(() => {
    load(mode);
  }, [mode, load]);

  useEffect(() => {
    return () => {
      if (springRAF.current) cancelAnimationFrame(springRAF.current);
      clearToastTimer();
    };
  }, []);

  // Prefetch the next page once the local queue runs low, so the stack never
  // visibly stalls mid-sweep.
  useEffect(() => {
    if (!hasMore || !cursor || queue.length > 4 || loading) return;
    let alive = true;
    fetch(`/api/deck?mode=${mode}&limit=20&cursor=${encodeURIComponent(cursor)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ApiResponse | null) => {
        if (!alive || !data) return;
        setQueue((q) => [...q, ...data.cards.filter((c) => !q.some((existing) => existing.id === c.id))]);
        setCursor(data.nextCursor);
        setHasMore(!!data.nextCursor);
        setTotal(data.total);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [queue.length, hasMore, cursor, mode, loading]);

  const switchMode = (m: Mode) => {
    if (m === mode || loading) return;
    setToast(null);
    clearToastTimer();
    setExpanded(false);
    setEditing(false);
    setDragX(0);
    setDragY(0);
    setDragging(false);
    setExit(null);
    setMode(m);
    router.replace(`${pathname}?mode=${m}`, { scroll: false });
  };

  const showToast = useCallback((message: string, undo: UndoDescriptor | undefined, card: DeckCard, dir: SwipeDir) => {
    clearToastTimer();
    setToast({ message, undo, card, dir });
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  }, []);

  // Removes the card from the queue immediately (the fly-off already ran),
  // then fires the API call in the background and surfaces the result as an
  // undo-able toast. Optimistic on purpose — "must feel instant" per the
  // brief; a failed call still shows an (un-undoable) error toast rather than
  // silently reinserting the card, since the reviewer already moved on.
  const commitAction = useCallback(
    async (card: DeckCard, dir: SwipeDir, editsPatch?: Record<string, unknown>) => {
      setQueue((q) => q.filter((c) => c.id !== card.id));
      setSessionActed((n) => n + 1);
      setSessionCounts((c) => (dir === "right" ? { ...c, right: c.right + 1 } : { ...c, left: c.left + 1 }));
      setExpanded(false);
      setEditing(false);
      setBusy(true);
      const action = actionForDir(mode, dir);
      try {
        const res = await fetch("/api/deck/act", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, id: card.id, action, edits: editsPatch }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast(data.message ?? defaultMessageFor(action), data.undo, card, dir);
        } else {
          showToast(data.message ?? "That didn't go through", undefined, card, dir);
        }
      } catch {
        showToast("Network error — action may not have saved", undefined, card, dir);
      } finally {
        setBusy(false);
      }
    },
    [mode, showToast]
  );

  const undoLast = useCallback(async () => {
    if (!toast) return;
    const { undo, card, dir } = toast;
    clearToastTimer();
    setToast(null);
    if (!undo) return;
    setBusy(true);
    try {
      const res = await fetch("/api/deck/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, id: card.id, action: "undo", edits: { undo } }),
      });
      const data = await res.json();
      if (data.ok) {
        setQueue((q) => (q.some((c) => c.id === card.id) ? q : [card, ...q]));
        setSessionActed((n) => Math.max(0, n - 1));
        setSessionCounts((c) =>
          dir === "right" ? { ...c, right: Math.max(0, c.right - 1) } : { ...c, left: Math.max(0, c.left - 1) }
        );
      }
    } catch {
      // best-effort — leave state as-is; a reload will resync
    } finally {
      setBusy(false);
    }
  }, [toast, mode]);

  const flyOffAndCommit = useCallback(
    (card: DeckCard, dir: SwipeDir, editsPatch?: Record<string, unknown>) => {
      setExit(dir);
      const cardWidth = dragRef.current.cardWidth || DEFAULT_CARD_WIDTH;
      setDragX(dir === "right" ? cardWidth * 1.6 : -cardWidth * 1.6);
      setDragY(0);
      setTimeout(() => {
        setExit(null);
        setDragX(0);
        setDragY(0);
        commitAction(card, dir, editsPatch);
      }, EXIT_MS);
    },
    [commitAction]
  );

  // ---- pointer gesture on the top card --------------------------------------

  const springBack = useCallback((fromX: number) => {
    if (springRAF.current) cancelAnimationFrame(springRAF.current);
    let state: Spring1D = { x: fromX, v: 0 };
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      state = stepSpring(state, 0, dt);
      setDragX(state.x);
      setDragY((y) => y * 0.82);
      if (!springSettled(state, 0)) {
        springRAF.current = requestAnimationFrame(tick);
      } else {
        setDragX(0);
        setDragY(0);
        springRAF.current = null;
      }
    };
    springRAF.current = requestAnimationFrame(tick);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || expanded || !top) return;
    if (springRAF.current) {
      cancelAnimationFrame(springRAF.current);
      springRAF.current = null;
    }
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const width = el.offsetWidth || DEFAULT_CARD_WIDTH;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      samples: [{ t: performance.now(), x: 0 }],
      cardWidth: width,
    };
    setCardWidth(width);
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || dragRef.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    dragRef.current.samples.push({ t: performance.now(), x: dx });
    if (dragRef.current.samples.length > 10) dragRef.current.samples.shift();
    setDragX(dx);
    setDragY(dy * 0.15);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || dragRef.current.pointerId !== e.pointerId || !top) {
      setDragging(false);
      return;
    }
    setDragging(false);
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const cardWidth = dragRef.current.cardWidth;

    if (Math.abs(dx) < TAP_MOVE_TOLERANCE && Math.abs(dy) < TAP_MOVE_TOLERANCE) {
      setDragX(0);
      setDragY(0);
      setExpanded(true);
      return;
    }

    const vx = velocityFromSamples(dragRef.current.samples);
    const dir = decideSwipe(dx, vx, cardWidth);
    if (dir) {
      flyOffAndCommit(top, dir);
    } else {
      springBack(dx);
    }
  };

  const onPointerCancel = () => {
    if (!dragging) return;
    setDragging(false);
    springBack(dragX);
  };

  const buttonSwipe = (dir: SwipeDir) => {
    if (!top || busy || dragging) return;
    flyOffAndCommit(top, dir);
  };

  const onCommitFromDetail = (dir: SwipeDir) => {
    if (!top) return;
    flyOffAndCommit(top, dir);
  };

  const onSaveEdit = async (patch: Record<string, unknown>) => {
    if (!top) return;
    setBusy(true);
    try {
      const res = await fetch("/api/deck/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, id: top.id, action: "edit", edits: patch }),
      });
      const data = await res.json();
      if (data.ok) {
        setQueue((q) => q.map((c) => (c.id === top.id ? applyEditToCard(mode, c, patch) : c)));
      }
    } finally {
      setBusy(false);
      setEditing(false);
    }
  };

  const progressPct = total > 0 ? Math.min(100, (reviewed / total) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-sm flex-1 px-4 pb-6 pt-3 md:max-w-md md:pt-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-[-0.022em] md:text-[22px]">Deck</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {total > 0 ? `${reviewed} of ${total} reviewed` : mode === "daily" ? "Nothing captured yet today" : "Nothing to import"}
          </p>
        </div>
        <div className="flex rounded-control border border-hairline bg-surface-1 p-0.5">
          <button
            type="button"
            onClick={() => switchMode("daily")}
            className={`rounded-[9px] px-3 py-1.5 text-[13px] font-semibold transition ${
              mode === "daily" ? "bg-white/[0.08] text-ink" : "text-ink-2"
            }`}
          >
            Daily
          </button>
          <button
            type="button"
            onClick={() => switchMode("import")}
            className={`rounded-[9px] px-3 py-1.5 text-[13px] font-semibold transition ${
              mode === "import" ? "bg-white/[0.08] text-ink" : "text-ink-2"
            }`}
          >
            Import
          </button>
        </div>
      </div>

      <div className="mb-5 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${progressPct}%` }} />
      </div>

      {error && (
        <div className="mb-4 rounded-control border border-hairline-2 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}{" "}
          <button className="font-semibold underline" onClick={() => load(mode)}>
            retry
          </button>
        </div>
      )}

      {loading && !initialLoadDone ? (
        <DeckSkeleton />
      ) : top ? (
        <div className="relative mx-auto h-[60vh] max-h-[540px] w-full">
          {next && (
            <div
              className="absolute inset-0 rounded-card border border-hairline bg-surface-1 shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
              style={{ transform: "scale(0.96) translateY(10px)", opacity: 0.7 }}
            >
              <CardFront card={next} mode={mode} />
            </div>
          )}
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            className="absolute inset-0 touch-none overflow-hidden rounded-card border border-hairline-2 bg-surface-1 shadow-[0_16px_48px_rgba(0,0,0,0.45)]"
            style={{
              transform: `translate(${dragX}px, ${dragY}px) rotate(${rotationForDrag(dragX, cardWidth)}deg)`,
              transition: dragging ? "none" : exit ? `transform ${EXIT_MS}ms cubic-bezier(0.2,0.8,0.2,1)` : undefined,
              cursor: dragging ? "grabbing" : "grab",
            }}
          >
            <CardFront card={top} mode={mode} />
            {dragX > 24 && <SwipeBadge dir="right" mode={mode} />}
            {dragX < -24 && <SwipeBadge dir="left" mode={mode} />}
          </div>
        </div>
      ) : (
        <DeckClear mode={mode} total={total} reviewed={reviewed} counts={sessionCounts} />
      )}

      <div className="mt-5 flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={() => buttonSwipe("left")}
          disabled={!top || busy}
          aria-label={mode === "daily" ? "Archive" : "Reject"}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-hairline-2 bg-surface-2 text-2xl text-danger transition active:scale-95 disabled:opacity-40"
        >
          ✕
        </button>
        <button
          type="button"
          onClick={() => top && setExpanded(true)}
          disabled={!top}
          aria-label="Expand"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.06] text-ink-2 transition active:scale-95 disabled:opacity-40"
        >
          ⤢
        </button>
        <button
          type="button"
          onClick={() => buttonSwipe("right")}
          disabled={!top || busy}
          aria-label={mode === "daily" ? "Keep" : "Approve"}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-hairline-2 bg-surface-2 text-2xl transition active:scale-95 disabled:opacity-40"
          style={{ color: "#93d8a8" }}
        >
          ✓
        </button>
      </div>

      {expanded && top && (
        <DeckDetail
          card={top}
          mode={mode}
          editing={editing}
          busy={busy}
          onClose={() => {
            setExpanded(false);
            setEditing(false);
          }}
          onEditStart={() => setEditing(true)}
          onEditCancel={() => setEditing(false)}
          onSaveEdit={onSaveEdit}
          onCommit={onCommitFromDetail}
        />
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-[calc(84px+env(safe-area-inset-bottom))] z-[70] flex justify-center px-4 md:bottom-6">
          <div className="flex items-center gap-3 rounded-control border border-hairline-2 bg-material-2 px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-[20px]">
            <span className="text-[13px] text-ink">{toast.message}</span>
            {toast.undo && (
              <button type="button" onClick={undoLast} className="text-[13px] font-semibold text-accent-text">
                Undo
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
