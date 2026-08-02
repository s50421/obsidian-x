import { CARD, SectionLabel } from "../components/ui";

// Brain-quality Phase 2 — is the brain's STRUCTURE sound?
//
// The scorecard measures whether the product works. This measures whether the
// data underneath it is worth trusting: are entities canonical, do connections
// mean anything, how much is the classifier unsure about.
//
// Same governing rule as the scorecard: no fake numbers. Every figure here is a
// straight count from the live tables.

export type DataQualityStats = {
  items: number;
  itemsWithEntities: number;
  entities: number;
  entitiesNeedingReview: number;
  edgesByKind: Record<string, number>;
  legacyLinks: number;
  lowConfidence: number;
  pendingMerges: number;
};

function Row({
  label,
  value,
  note,
  tone = "normal",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "normal" | "good" | "warn";
}) {
  const color =
    tone === "good" ? "#93d8a8" : tone === "warn" ? "#e6c07b" : "rgba(255,255,255,0.92)";
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{label}</div>
        {note && <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{note}</div>}
      </div>
      <div className="shrink-0 text-[13px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  shared_person: "same person",
  shared_org: "same organisation",
  shared_place: "same place",
  shared_topic: "same topic",
  similar: "reads similarly (a guess)",
  reference: "explicit reference",
  thread: "same thread",
};

export default function DataQuality({ stats }: { stats: DataQualityStats }) {
  const totalEdges = Object.values(stats.edgesByKind).reduce((a, b) => a + b, 0);
  const pctEntities = stats.items ? Math.round((stats.itemsWithEntities / stats.items) * 100) : 0;

  return (
    <div className={`flex flex-col gap-1 p-5 ${CARD}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <SectionLabel>Brain data quality</SectionLabel>
        <span className="text-xs text-ink-3">{stats.items} active items</span>
      </div>

      <div className="divide-y divide-hairline">
        <Row
          label="Items with canonical entities"
          value={`${pctEntities}%`}
          note={`${stats.itemsWithEntities} of ${stats.items} resolved against the entity table`}
          tone={pctEntities >= 50 ? "good" : "normal"}
        />
        <Row
          label="Canonical entities"
          value={String(stats.entities)}
          note={
            stats.entitiesNeedingReview
              ? `${stats.entitiesNeedingReview} under question — a merge is waiting on you`
              : "no duplicates awaiting a decision"
          }
          tone={stats.entitiesNeedingReview ? "warn" : "good"}
        />
        <Row
          label="Merges awaiting approval"
          value={String(stats.pendingMerges)}
          note="proposed by the model, never applied silently"
          tone={stats.pendingMerges ? "warn" : "normal"}
        />
        <Row
          label="Legacy links left"
          value={String(stats.legacyLinks)}
          note={
            stats.legacyLinks
              ? "untyped items.links entries — these predate the typed graph"
              : "purged; connections now live only in the typed edge table"
          }
          tone={stats.legacyLinks ? "warn" : "good"}
        />
        <Row
          label="Low-confidence classifications"
          value={String(stats.lowConfidence)}
          note="shown first in the evening deck so a correction is one tap"
          tone={stats.lowConfidence ? "warn" : "good"}
        />
      </div>

      <div className="mt-3 border-t border-hairline pt-3">
        <SectionLabel className="mb-1">Connections by kind</SectionLabel>
        {totalEdges === 0 ? (
          <p className="py-2 text-xs leading-relaxed text-ink-3">
            No connections yet. They are derived nightly from shared entities and topics —
            every one carries a reason you can read.
          </p>
        ) : (
          <div className="divide-y divide-hairline">
            {Object.entries(stats.edgesByKind)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, n]) => (
                <Row key={kind} label={KIND_LABEL[kind] ?? kind} value={String(n)} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
