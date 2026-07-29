"use client";

import { useEffect, useState } from "react";
import type { DeckCard } from "@/app/api/deck/route";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD_INSET,
  InspectorSection,
  MetaRow,
  Pill,
  PriorityChip,
  StatusChip,
  TypeChip,
} from "./ui";

// The item inspector — the PWA's "see deeper" surface, reached by tapping the
// top deck card. One item's whole story, in a fixed order:
//
//   1. what it is now      — title, type/priority/status, tags
//   2. what the AI read    — the model's reading of the capture, with its
//                            confidence and reasoning where it proposed a change
//   3. the memory itself   — cleaned body, and the raw capture beneath it when
//                            the two differ (so nothing is ever hidden)
//   4. what it connects to — similar items, entities
//   5. provenance          — source, captured-at, due
//
// Pure presentational wrapper around callbacks the Deck orchestrator supplies;
// it owns no fetch. `editing` swaps the body for an inline title/type/tags
// editor. Actions stay pinned to the bottom of the sheet, above the home
// indicator, so the decision is always thumb-reachable.

const ITEM_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event", "memory"];

// v4.0.1 — junk is surfaced, never auto-archived. A score of 8+ is a firm
// "would be junk"; 5-7 is a softer "possible junk". null / <5 shows nothing.
function JunkBadge({ score }: { score: number | null }) {
  if (score == null || score < 5) return null;
  const firm = score >= 8;
  const label = firm ? "would be junk" : "possible junk";
  const color = firm ? "#f49a91" : "#e6c07b";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-control border px-2 py-0.5 text-[11px] font-semibold"
      style={{ color, borderColor: color, background: "rgba(10,10,13,0.35)" }}
      title={`Junk score ${score}/10 — your call. Nothing was archived automatically.`}
    >
      ⚑ {label} · {score}/10
    </span>
  );
}

type Props = {
  card: DeckCard;
  mode: "daily" | "import";
  editing: boolean;
  busy: boolean;
  onClose: () => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onSaveEdit: (patch: Record<string, unknown>) => void;
  onCommit: (dir: "right" | "left") => void;
};

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const FIELD_INPUT =
  "h-11 w-full rounded-control border border-hairline bg-surface-2 px-3.5 text-[15px] text-ink outline-none transition focus:border-accent focus:shadow-[0_0_0_3px_rgba(80,107,242,0.2)]";

export default function DeckDetail({ card, mode, editing, busy, onClose, onEditStart, onEditCancel, onSaveEdit, onCommit }: Props) {
  const isImport = mode === "import";
  const [title, setTitle] = useState(card.title);
  const [type, setType] = useState(isImport ? (card.newType ?? card.type) : card.type);
  const [tagsStr, setTagsStr] = useState((isImport ? (card.newTags ?? card.tags) : card.tags).join(", "));

  // Reset the form whenever a different card is shown or edit mode re-opens.
  useEffect(() => {
    setTitle(card.title);
    setType(isImport ? (card.newType ?? card.type) : card.type);
    setTagsStr((isImport ? (card.newTags ?? card.tags) : card.tags).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, editing]);

  // Escape closes the sheet, matching every other dismissible surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
    if (isImport) {
      if (card.proposalKind !== "retitle") return; // split parts aren't inline-editable here
      onSaveEdit({ newTitle: title.trim(), newType: type, newTags: tags });
    } else {
      onSaveEdit({ title: title.trim(), type, tags });
    }
  };

  const shownType = isImport ? (card.newType ?? card.type) : card.type;
  const shownTags = isImport ? (card.newTags ?? card.tags) : card.tags;
  const rawDiffers = !!card.raw && card.raw.trim() !== "" && card.raw.trim() !== card.body.trim();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm md:items-center md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Item detail"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-[24px] border border-hairline-2 bg-surface-1 shadow-[0_-16px_48px_rgba(0,0,0,0.5)] md:max-h-[86vh] md:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sheet header — grab handle on mobile, context label, close. */}
        <div className="shrink-0 border-b border-hairline px-5 pb-3 pt-2.5 md:px-6 md:pt-4">
          <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/[0.18] md:hidden" aria-hidden />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
              {isImport ? `Proposed ${card.proposalKind ?? "retitle"}` : "Today's memory"}
            </span>
            <button
              onClick={onClose}
              className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-ink-3 transition hover:bg-white/[0.06] hover:text-ink"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-6">
          {editing ? (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
                  Title
                </label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD_INPUT} autoFocus />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
                    Type
                  </label>
                  <select value={type} onChange={(e) => setType(e.target.value)} className={FIELD_INPUT}>
                    {ITEM_TYPES.map((t) => (
                      <option key={t} value={t} className="bg-surface-1">
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-[2]">
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
                    Tags
                  </label>
                  <input
                    value={tagsStr}
                    onChange={(e) => setTagsStr(e.target.value)}
                    placeholder="comma, separated"
                    className={FIELD_INPUT}
                  />
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* 1 · what it is now */}
              <h2 className="text-[20px] font-bold leading-snug tracking-[-0.01em] text-ink">{card.title}</h2>
              {card.subtitle && (
                <p className="mt-1.5 text-[13px] text-ink-3">
                  <span className="text-ink-3/70">was</span>{" "}
                  <span className="line-through decoration-ink-3/60">{card.subtitle}</span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <TypeChip type={shownType} />
                {card.priority && <PriorityChip priority={card.priority} />}
                <StatusChip status={card.status} />
                <JunkBadge score={card.junkScore} />
                {shownTags.map((t) => (
                  <Pill key={t}>#{t}</Pill>
                ))}
              </div>

              {/* Split preview — what approving this proposal would produce. */}
              {card.proposalKind === "split" && card.parts && card.parts.length > 0 && (
                <InspectorSection label={`Splits into ${card.parts.length} items`}>
                  <div className="space-y-2">
                    {card.parts.map((p, i) => (
                      <div key={i} className={`${CARD_INSET} p-3`}>
                        <div className="flex items-center gap-2">
                          <TypeChip type={p.type} />
                          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{p.title}</span>
                        </div>
                        <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-ink-2">{p.body}</p>
                      </div>
                    ))}
                  </div>
                </InspectorSection>
              )}

              {/* 2 · what the AI read */}
              <InspectorSection
                label="AI reading"
                trailing={card.confidence != null ? `${Math.round(card.confidence * 100)}% confident` : undefined}
              >
                <div className={`${CARD_INSET} px-3.5 py-2`}>
                  <MetaRow label="Type">{shownType}</MetaRow>
                  <MetaRow label="Tags">
                    {shownTags.length > 0 ? (
                      <span className="flex flex-wrap gap-1.5">
                        {shownTags.map((t) => (
                          <Pill key={t}>#{t}</Pill>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-3">none</span>
                    )}
                  </MetaRow>
                  <MetaRow label="Due">
                    {card.dueAt ? fmtDate(card.dueAt) : <span className="text-ink-3">no date read</span>}
                  </MetaRow>
                  <MetaRow label="Entities">
                    {card.entities.length > 0 ? (
                      <span className="flex flex-wrap gap-1.5">
                        {card.entities.map((e, i) => (
                          <Pill key={i}>
                            {e.name}
                            <span className="text-ink-3">· {e.kind}</span>
                          </Pill>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-3">none found</span>
                    )}
                  </MetaRow>
                </div>

                {card.reason && (
                  <div className="mt-2 rounded-control border border-dashed border-hairline-2 bg-accent-soft/40 p-3">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-accent-text">
                      Why it proposed this
                    </div>
                    <p className="text-[13px] leading-relaxed text-ink-2">{card.reason}</p>
                  </div>
                )}

                {isImport && card.proposalKind === "retitle" && (
                  <p className="mt-2 text-xs leading-relaxed text-ink-3">
                    Multiple topics in here? Full note-splitting runs in the reprocess pipeline — reject and it&apos;ll
                    be reconsidered, or approve and split it manually afterward.
                  </p>
                )}
              </InspectorSection>

              {/* 3 · the memory itself */}
              <InspectorSection label={rawDiffers ? "Cleaned memory" : isImport ? "Original memory" : "Full memory"}>
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{card.body}</p>
              </InspectorSection>

              {rawDiffers && (
                <InspectorSection label="Raw capture" trailing="exactly as it arrived">
                  <p className={`${CARD_INSET} whitespace-pre-wrap p-3 text-[13px] leading-relaxed text-ink-2`}>
                    {card.raw}
                  </p>
                </InspectorSection>
              )}

              {/* 4 · what it connects to */}
              {card.links.length > 0 && (
                <InspectorSection label="Linked items" trailing={`${card.links.length}`}>
                  <div className="space-y-1.5">
                    {card.links.map((l) => (
                      <div key={l.id} className={`${CARD_INSET} flex items-center gap-2 px-3 py-2.5 text-[13px]`}>
                        <TypeChip type={l.type} />
                        <span className="min-w-0 flex-1 truncate text-ink-2">{l.title}</span>
                      </div>
                    ))}
                  </div>
                </InspectorSection>
              )}

              {/* 5 · provenance */}
              <InspectorSection label="Provenance">
                <div className={`${CARD_INSET} px-3.5 py-2`}>
                  <MetaRow label="Source">{card.source}</MetaRow>
                  <MetaRow label="Captured">{fmtDate(card.createdAt)}</MetaRow>
                  <MetaRow label="Item ID">
                    <span className="break-all font-mono text-[11px] text-ink-3">{card.itemId}</span>
                  </MetaRow>
                </div>
              </InspectorSection>
            </>
          )}
        </div>

        {/* Actions stay pinned above the home indicator — the decision is
            always in thumb reach, never scrolled off. */}
        <div className="shrink-0 border-t border-hairline bg-surface-1 px-5 pb-[calc(16px+env(safe-area-inset-bottom))] pt-3 md:px-6 md:pb-4">
          {editing ? (
            <div className="flex gap-2">
              <button onClick={onEditCancel} disabled={busy} className={`${BTN_SECONDARY} flex-1`}>
                Cancel
              </button>
              <button onClick={save} disabled={busy || !title.trim()} className={`${BTN_PRIMARY} flex-1`}>
                Save changes
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button onClick={onEditStart} disabled={busy} className={`${BTN_SECONDARY} flex-1 px-3`}>
                Edit
              </button>
              <button
                onClick={() => onCommit("left")}
                disabled={busy}
                className="inline-flex h-11 flex-1 items-center justify-center rounded-control px-3 text-[15px] font-semibold text-danger transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
                style={{ background: "rgba(244,154,145,0.14)" }}
              >
                {isImport ? "Reject" : "Archive"}
              </button>
              <button onClick={() => onCommit("right")} disabled={busy} className={`${BTN_PRIMARY} flex-1 px-3`}>
                {isImport ? "Approve" : "Keep"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
