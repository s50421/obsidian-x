// Obsidian-X — the features a connection is judged on.
//
// Owner decision (2026-08-02): no custom model, but do build the learning loop.
// These features are that loop's input. Every one is CHEAP (no model call) and
// every one can be said in words, because the design law is that a connection
// must explain itself — a learned weight over "shared people" renders as "mostly
// because they both mention Dani", which a network's score never could.
//
// Deliberately small. Eight features can be fitted from ~50 labels; forty
// cannot, and this corpus produces labels slowly.

export type LinkFeatures = {
  /** Cosine over embedding_v2. The old system's ONLY signal. */
  similarity: number;
  /** Canonical entities both items mention, normalised. */
  sharedEntities: number;
  /** Jaccard over taxonomy tags. */
  tagOverlap: number;
  /** Both projected onto the same ClickUp task. */
  sameTask: number;
  /** Closeness of due dates, 0 when either is undated. */
  dueProximity: number;
  /**
   * Word overlap over title+body, stopwords removed.
   *
   * The lexical half that embeddings miss. Worth having precisely because this
   * corpus tops out at 0.503 cosine — two shopping lists share the literal word
   * "shopping" long before any embedding is confident about them. This is the
   * cheap stand-in for the BM25 signal the claude-obsidian project uses.
   */
  lexicalOverlap: number;
  /** Captured close together in time. */
  captureProximity: number;
  /** Same item type (task/shopping/…). */
  sameType: number;
};

export const FEATURE_KEYS: (keyof LinkFeatures)[] = [
  "similarity",
  "sharedEntities",
  "tagOverlap",
  "sameTask",
  "dueProximity",
  "lexicalOverlap",
  "captureProximity",
  "sameType",
];

/** Human wording for each feature, used to explain a score. */
export const FEATURE_LABEL: Record<keyof LinkFeatures, string> = {
  similarity: "they read alike",
  sharedEntities: "they mention the same people or places",
  tagOverlap: "they share topics",
  sameTask: "they are on the same task",
  dueProximity: "they are due around the same time",
  lexicalOverlap: "they use the same words",
  captureProximity: "you captured them close together",
  sameType: "they are the same kind of thing",
};

export type FeatureItem = {
  id: string;
  title: string | null;
  body: string | null;
  type: string;
  tags: string[] | null;
  due_at: string | null;
  created_at: string;
  external: { clickup?: { id?: string } } | null;
  entityIds: Set<string>;
};

const STOPWORDS = new Set(
  ("a an the and or but if then of to in on for with at by from up about into over after " +
    "is are was were be been being do does did doing have has had having i me my we our you " +
    "your it its this that these those as not no so than too very can will just dont should now")
    .split(" ")
);

export function contentWords(s: string): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/** Decay a gap in days to 0..1 — 1 is same day, ~0.5 a week out. */
function proximity(days: number, halfLife = 7): number {
  if (!Number.isFinite(days)) return 0;
  return 1 / (1 + Math.abs(days) / halfLife);
}

export function extractFeatures(a: FeatureItem, b: FeatureItem, similarity: number): LinkFeatures {
  let sharedEnt = 0;
  for (const e of a.entityIds) if (b.entityIds.has(e)) sharedEnt += 1;

  const dueA = a.due_at ? new Date(a.due_at).getTime() : null;
  const dueB = b.due_at ? new Date(b.due_at).getTime() : null;

  return {
    similarity: Math.max(0, Math.min(1, similarity)),
    // Two shared entities is already a strong claim; more adds little.
    sharedEntities: Math.min(1, sharedEnt / 2),
    tagOverlap: jaccard(new Set(a.tags ?? []), new Set(b.tags ?? [])),
    sameTask:
      a.external?.clickup?.id && a.external.clickup.id === b.external?.clickup?.id ? 1 : 0,
    dueProximity:
      dueA != null && dueB != null ? proximity(Math.abs(dueA - dueB) / 86_400_000, 3) : 0,
    lexicalOverlap: jaccard(
      contentWords(`${a.title ?? ""} ${a.body ?? ""}`),
      contentWords(`${b.title ?? ""} ${b.body ?? ""}`)
    ),
    captureProximity: proximity(
      Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) / 86_400_000,
      3
    ),
    sameType: a.type === b.type ? 1 : 0,
  };
}
