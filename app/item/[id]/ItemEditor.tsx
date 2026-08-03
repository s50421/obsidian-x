"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BTN_PRIMARY, CARD_INSET } from "../../components/ui";
import { ALLOWED_TYPES } from "@/lib/title-standard.mjs";

// Edit a memory in place.
//
// The deck deliberately does NOT let you edit the body — a swipe is not the
// moment to rewrite something. This is that moment, so everything is editable
// here and nowhere else.

const TYPES = ALLOWED_TYPES as string[];
const PRIORITIES = ["low", "medium", "high"];
const STATUSES = ["open", "done", "archived"];

export type EditableItem = {
  id: string;
  title: string;
  body: string;
  type: string;
  tags: string[];
  priority: string | null;
  status: string;
  due_at: string | null;
};

const field =
  "w-full rounded-control border border-hairline bg-surface-1 px-3 py-2 text-[14px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent/50";

export default function ItemEditor({ item }: { item: EditableItem }) {
  const router = useRouter();
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [type, setType] = useState(item.type);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [priority, setPriority] = useState(item.priority ?? "");
  const [status, setStatus] = useState(item.status);
  const [due, setDue] = useState(item.due_at ? item.due_at.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const dirty =
    title !== item.title ||
    body !== item.body ||
    type !== item.type ||
    tags !== item.tags.join(", ") ||
    priority !== (item.priority ?? "") ||
    status !== item.status ||
    due !== (item.due_at ? item.due_at.slice(0, 10) : "");

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          title,
          body,
          type,
          status,
          priority: priority || null,
          tags: tags
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
          // A date input gives a bare day; anchor it mid-morning so a timezone
          // shift can't slide the due date onto the day before.
          due_at: due ? `${due}T09:00:00.000Z` : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? (data.message ?? "Saved") : (data.error ?? "Failed"));
      if (res.ok) router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">The memory</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className={`${field} font-sans leading-relaxed`}
        />
      </label>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
            {STATUSES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={field}>
            <option value="">none</option>
            {PRIORITIES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Due</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Tags (comma separated)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} className={field} />
      </label>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={!dirty || busy} className={`${BTN_PRIMARY} disabled:opacity-40`}>
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {msg && <span className="text-[13px] text-ink-3">{msg}</span>}
      </div>

      <p className={`${CARD_INSET} px-3 py-2 text-xs leading-relaxed text-ink-3`}>
        Every edit is recorded, and shows up in the corrections report on Ops — that is how the
        classifier gets tuned against real mistakes rather than guesses.
      </p>
    </div>
  );
}
