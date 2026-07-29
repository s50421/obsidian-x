"use client";

import { useEffect, useState } from "react";
import type { DeckCard } from "@/app/api/deck/route";
import { PriorityChip, StatusChip, TypeChip } from "./ui";

// Full-detail sheet for the top deck card — tap-to-expand target. Shows the
// original memory (body + raw, if they differ), type/tags/priority, entities,
// created/source, the AI's reason (proposals only), similarity-linked items,
// and — via `editing` — an inline title/type/tags editor. Pure presentational
// wrapper around callbacks the Deck orchestrator supplies; it owns no fetch.

const ITEM_TYPES = ["note", "task", "idea", "shopping", "reference", "person", "event"];

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

  const save = () => {
    const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
    if (isImport) {
      if (card.proposalKind !== "retitle") return; // split parts aren't inline-editable here
      onSaveEdit({ newTitle: title.trim(), newType: type, newTags: tags });
    } else {
      onSaveEdit({ title: title.trim(), type, tags });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-[24px] border border-hairline-2 bg-surface-1 p-5 shadow-[0_-16px_48px_rgba(0,0,0,0.5)] md:rounded-card md:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
            {isImport ? `Proposed ${card.proposalKind}` : "Today's memory"}
          </span>
          <button onClick={onClose} className="text-ink-3 transition hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>

        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-3">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-control border border-hairline bg-surface-2 px-3 py-2 text-[15px] text-ink outline-none focus:border-accent"
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-semibold text-ink-3">Type</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full rounded-control border border-hairline bg-surface-2 px-3 py-2 text-[14px] text-ink outline-none"
                >
                  {ITEM_TYPES.map((t) => (
                    <option key={t} value={t} className="bg-surface-1">
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-[2]">
                <label className="mb-1 block text-xs font-semibold text-ink-3">Tags (comma-separated)</label>
                <input
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  className="w-full rounded-control border border-hairline bg-surface-2 px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={save}
                disabled={busy || !title.trim()}
                className="h-10 flex-1 rounded-control bg-accent text-[14px] font-semibold text-white transition disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={onEditCancel}
                disabled={busy}
                className="h-10 flex-1 rounded-control bg-white/[0.08] text-[14px] font-semibold text-ink transition disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-[19px] font-bold leading-snug text-ink">{card.title}</h2>
            {card.subtitle && <p className="mt-1 text-[13px] text-ink-3 line-through decoration-ink-3/60">{card.subtitle}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <TypeChip type={isImport ? (card.newType ?? card.type) : card.type} />
              {card.priority && <PriorityChip priority={card.priority} />}
              <StatusChip status={card.status} />
              {(isImport ? (card.newTags ?? card.tags) : card.tags).map((t) => (
                <span key={t} className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-medium text-ink-2">
                  #{t}
                </span>
              ))}
            </div>

            {card.proposalKind === "split" && card.parts && card.parts.length > 0 && (
              <div className="mt-4">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
                  Splits into {card.parts.length} items
                </div>
                <div className="space-y-2">
                  {card.parts.map((p, i) => (
                    <div key={i} className="rounded-control border border-hairline bg-surface-2 p-3">
                      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                        <TypeChip type={p.type} /> {p.title}
                      </div>
                      <p className="mt-1 line-clamp-3 text-[13px] text-ink-2">{p.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isImport && card.reason && (
              <div className="mt-4 rounded-control border border-dashed border-hairline-2 bg-accent-soft/40 p-3">
                <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-accent-text">
                  AI&apos;s reasoning{card.confidence != null ? ` · ${Math.round(card.confidence * 100)}% confident` : ""}
                </div>
                <p className="text-[13px] text-ink-2">{card.reason}</p>
              </div>
            )}

            {isImport && card.proposalKind === "retitle" && (
              <p className="mt-3 text-xs text-ink-3">
                Multiple topics in here? Full note-splitting runs in the reprocess pipeline — reject and it&apos;ll be
                reconsidered, or approve and split it manually afterward.
              </p>
            )}

            <div className="mt-4">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
                {isImport ? "Original memory" : "Full memory"}
              </div>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{card.body}</p>
            </div>

            {card.raw && card.raw.trim() && card.raw.trim() !== card.body.trim() && (
              <div className="mt-4">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Raw text</div>
                <p className="whitespace-pre-wrap rounded-control bg-surface-2 p-3 text-[13px] leading-relaxed text-ink-2">
                  {card.raw}
                </p>
              </div>
            )}

            {card.entities.length > 0 && (
              <div className="mt-4">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Entities</div>
                <div className="flex flex-wrap gap-1.5">
                  {card.entities.map((e, i) => (
                    <span key={i} className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs text-ink-2">
                      {e.name} <span className="text-ink-3">· {e.kind}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {card.links.length > 0 && (
              <div className="mt-4">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Similar items</div>
                <div className="space-y-1.5">
                  {card.links.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-control bg-surface-2 px-3 py-2 text-[13px]">
                      <TypeChip type={l.type} />
                      <span className="truncate text-ink-2">{l.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between text-xs text-ink-3">
              <span>
                {card.source} · {fmtDate(card.createdAt)}
              </span>
              {card.dueAt && <span>due {fmtDate(card.dueAt)}</span>}
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={onEditStart}
                disabled={busy}
                className="h-10 flex-1 rounded-control bg-white/[0.08] text-[14px] font-semibold text-ink transition disabled:opacity-50"
              >
                Edit
              </button>
              <button
                onClick={() => onCommit("left")}
                disabled={busy}
                className="h-10 flex-1 rounded-control text-[14px] font-semibold text-danger transition disabled:opacity-50"
                style={{ background: "rgba(244,154,145,0.14)" }}
              >
                {isImport ? "Reject" : "Archive"}
              </button>
              <button
                onClick={() => onCommit("right")}
                disabled={busy}
                className="h-10 flex-1 rounded-control bg-accent text-[14px] font-semibold text-white transition disabled:opacity-50"
              >
                {isImport ? "Approve" : "Keep"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
