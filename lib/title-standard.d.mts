// Types for lib/title-standard.mjs. The implementation is plain ESM JavaScript
// so that `node scripts/*.mjs` can import it without a build step; this file
// gives the TypeScript side (lib/enrich.ts, lib/ingest-document.ts,
// lib/proposals.ts) real types instead of `any`.

export type EntityKind = "person" | "place" | "org" | "other";
export type Entity = { name: string; kind: EntityKind };
export type Priority = "low" | "medium" | "high";

export type ReprocessPart = {
  title: string;
  body: string;
  type: string;
  tags: string[];
};

export type JunkVerdict = "archive" | "review" | "keep";

export type JunkScore = {
  score: number; // 0..10
  confidence: number; // 0..1, certainty in the SCORE
  verdict: JunkVerdict;
  structuralReason: string | null;
};

export type ReprocessVerdict = {
  junkScore: number;
  junkVerdict: JunkVerdict;
  junkReason: string | null;
  splitCapped: boolean;
  confidence: number;
  title: string;
  titleIssues: string[];
  type: string;
  tags: string[];
  dueDate: string | null;
  entities: Entity[];
  reason: string | null;
  parts: ReprocessPart[];
  oldTitle: string;
};

export declare const ALLOWED_TYPES: string[];
export declare const ALLOWED_PRIORITY: string[];
export declare const ENTITY_KINDS: string[];

export declare const TITLE_MAX: number;
export declare const CONFIDENCE_BAR: number;
export declare const JUNK_CONFIDENCE_BAR: number;
export declare const JUNK_ARCHIVE_SCORE: number;
export declare const JUNK_REVIEW_SCORE: number;
export declare const MAX_SPLIT_PARTS: number;

export declare const TAG_TAXONOMY: string[];
export declare const SYSTEM_TAGS: Set<string>;

export declare const TITLE_RULES: string;
export declare const TITLE_EXAMPLES: string;
export declare const TAG_RULES: string;
export declare const CONFIDENCE_RULES: string;
export declare const SPLIT_RULES: string;
export declare const JUNK_RULES: string;

export declare function cleanTitle(raw: unknown): string;
export declare function titleQualityIssues(title: unknown, body?: string): string[];
export declare function normalizeTags(tags: unknown): string[];
export declare function mergeTags(existingTags: unknown, nextTags: unknown): string[];
export declare function structuralJunkReason(title: unknown, body: unknown): string | null;
export declare function structuralJunkScore(
  title: unknown,
  body: unknown
): { score: number; reason: string | null; certain: boolean };
export declare function scoreJunk(input?: {
  modelScore?: unknown;
  modelConfidence?: unknown;
  title?: unknown;
  body?: unknown;
}): JunkScore;
export declare function capSplitParts<T>(
  parts: readonly T[] | null | undefined
): { parts: T[]; capped: boolean };

export declare function clamp01(n: unknown): number;
export declare function isValidISODate(v: unknown): v is string;
export declare function sanitizeEntities(v: unknown): Entity[];
export declare function coerceType(v: unknown, fallback?: string): string;
export declare function coercePriority(v: unknown, fallback?: string): Priority;

export type EnrichedItemFields = {
  title: string;
  type: string;
  body: string;
  tags: string[];
  priority: Priority;
  due_date: string | null;
  entities: Entity[];
  confidence: number;
  needs_review: boolean;
  review_reason: string | null;
  junk_score: number;
  junk_verdict: JunkVerdict;
  junk_reason: string | null;
};

export declare function parseEnrichPayload(
  parsed: unknown,
  originalText: string
): { items: EnrichedItemFields[]; confidence: number; split: boolean };

export declare function buildReprocessSystem(todayISO: string): string;
export declare function parseReprocessReply(
  parsed: unknown,
  item: { title?: unknown; body?: unknown }
): ReprocessVerdict;
