"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CARD, CARD_INSET, BTN_PRIMARY, SectionLabel, TypeChip } from "../components/ui";

// The connection editor — see, make and unmake connections without a canvas.
//
// The graph is a lovely way to LOOK at connections and a poor way to work with
// them: hit-testing a 6px circle with a thumb is fiddly, and the owner reported
// simply not being able to click a node at all. Everything here is ordinary
// DOM, so it works on any device regardless of what the canvas is doing.

export type EditorItem = { id: string; title: string; type: string };

export type EditorEdge = {
  id: string;
  src: string;
  dst: string;
  kind: string;
  reason: string;
  status: string;
};

const KIND_LABEL: Record<string, string> = {
  shared_person: "same person",
  shared_org: "same organisation",
  shared_place: "same place",
  shared_topic: "same topic",
  same_task: "same ClickUp task",
  same_due_date: "same due date",
  reference: "one mentions the other",
  thread: "same thread",
  similar: "reads similarly",
  manual: "you linked these",
};

function ItemPicker({
  items,
  value,
  onChange,
  placeholder,
  exclude,
}: {
  items: EditorItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  exclude?: string;
}) {
  const [q, setQ] = useState("");
  const chosen = items.find((i) => i.id === value);
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => i.id !== exclude)
      .filter((i) => !needle || i.title.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [items, q, exclude]);

  if (chosen) {
    return (
      <div className={`${CARD_INSET} flex items-center gap-2 px-3 py-2.5`}>
        <TypeChip type={chosen.type} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{chosen.title}</span>
        <button
          type="button"
          onClick={() => {
            onChange("");
            setQ("");
          }}
          className="shrink-0 text-xs text-ink-3 hover:text-ink"
        >
          change
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="rounded-control border border-hairline bg-surface-1 px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent/50"
      />
      {q.trim() && (
        <div className={`${CARD_INSET} max-h-52 overflow-y-auto`}>
          {matches.length === 0 ? (
            <div className="px-3 py-2.5 text-[13px] text-ink-3">Nothing matches.</div>
          ) : (
            matches.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChange(m.id)}
                className="flex w-full items-center gap-2 border-b border-hairline px-3 py-2.5 text-left last:border-0 hover:bg-white/[0.05]"
              >
                <TypeChip type={m.type} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{m.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function ConnectionsEditor({
  items,
  confirmed,
  suggested,
}: {
  items: EditorItem[];
  confirmed: EditorEdge[];
  suggested: EditorEdge[];
}) {
  const router = useRouter();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const title = (id: string) => items.find((i) => i.id === id)?.title ?? "(unknown)";
  const itemType = (id: string) => items.find((i) => i.id === id)?.type ?? "note";

  async function post(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed");
        setBusy(null);
        return;
      }
      router.refresh();
      setBusy(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-7">
      {/* make one */}
      <section className={`flex flex-col gap-3 p-5 ${CARD}`}>
        <SectionLabel>Connect two memories</SectionLabel>
        <ItemPicker items={items} value={a} onChange={setA} placeholder="Search for the first…" exclude={b} />
        <div className="text-center text-[13px] text-ink-3">↕</div>
        <ItemPicker items={items} value={b} onChange={setB} placeholder="Search for the second…" exclude={a} />
        <input
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          placeholder="Why are these connected? (shown on the line)"
          className="rounded-control border border-hairline bg-surface-1 px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!a || !b || busy === "create"}
            onClick={() =>
              post({ action: "create", src: a, dst: b, reason: why }, "create").then(() => {
                setA("");
                setB("");
                setWhy("");
              })
            }
            className={`${BTN_PRIMARY} disabled:opacity-40`}
          >
            {busy === "create" ? "Connecting…" : "Connect"}
          </button>
          {error && <span className="text-[13px] text-danger">{error}</span>}
        </div>
      </section>

      {/* suggestions */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <SectionLabel>Suggested</SectionLabel>
          <span className="text-xs text-ink-3">{suggested.length} waiting</span>
        </div>
        {suggested.length === 0 ? (
          <p className={`${CARD} p-4 text-[13px] text-ink-3`}>
            Nothing suggested right now. These appear when two memories read alike or share a name.
          </p>
        ) : (
          suggested.map((e) => (
            <div key={e.id} className={`flex flex-col gap-2.5 p-4 ${CARD}`}>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <TypeChip type={itemType(e.src)} />
                <span className="min-w-0 flex-1 truncate text-ink">{title(e.src)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <TypeChip type={itemType(e.dst)} />
                <span className="min-w-0 flex-1 truncate text-ink">{title(e.dst)}</span>
              </div>
              <div className="text-xs text-ink-3">{e.reason}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => post({ id: e.id, action: "confirm" }, e.id)}
                  className={`${BTN_PRIMARY} disabled:opacity-40`}
                >
                  Connect
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => post({ id: e.id, action: "dismiss" }, e.id)}
                  className="rounded-control border border-hairline px-3 py-1.5 text-[13px] text-ink-2 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Not related
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {/* existing */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <SectionLabel>Your connections</SectionLabel>
          <span className="text-xs text-ink-3">{confirmed.length} drawn in the graph</span>
        </div>
        {confirmed.length === 0 ? (
          <p className={`${CARD} p-4 text-[13px] text-ink-3`}>
            No connections yet. Confirm a suggestion above, or connect two memories by hand.
          </p>
        ) : (
          confirmed.map((e) => (
            <div key={e.id} className={`flex flex-col gap-2 p-4 ${CARD}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-ink">{title(e.src)}</div>
                  <div className="truncate text-[13px] text-ink">{title(e.dst)}</div>
                  <div className="mt-1 text-xs text-ink-3">
                    <span className="uppercase tracking-wide">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    {" · "}
                    {e.reason}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => post({ id: e.id, action: "remove" }, e.id)}
                  className="shrink-0 rounded-control border border-hairline px-2.5 py-1 text-xs text-ink-3 hover:bg-white/[0.06] disabled:opacity-40"
                  title={
                    e.kind === "manual"
                      ? "Delete this connection"
                      : "Remove it, and don't derive it again"
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
