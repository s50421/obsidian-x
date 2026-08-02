import type { SupabaseClient } from "@supabase/supabase-js";

// Brain-quality Phase 2, item 5 — tune the classifier against REAL mistakes.
//
// Every correction the owner makes is already in the audit trail; nothing was
// ever done with it. So the classification prompt was being tuned against
// guesses about what it gets wrong, while the evidence sat in a table.
//
// This groups those corrections into categories a prompt can actually act on.
// It deliberately does NOT auto-edit the prompt: a prompt change alters every
// future capture, which is precisely the kind of thing the propose-then-approve
// law exists for. It reports; a human edits.

export type CorrectionCategory =
  | "title"
  | "type"
  | "tags"
  | "duplicate"
  | "junk"
  | "entity"
  | "deleted";

export type CorrectionStat = {
  category: CorrectionCategory;
  count: number;
  /** Real examples, so a prompt edit can be written against actual failures. */
  examples: string[];
};

export type CorrectionReport = {
  since: string;
  total: number;
  stats: CorrectionStat[];
  /** Captures in the same window — corrections are meaningless without a base. */
  captures: number;
};

const LABEL: Record<CorrectionCategory, string> = {
  title: "Title rewritten",
  type: "Type changed",
  tags: "Tags changed",
  duplicate: "Duplicate merged or deleted",
  junk: "Junk verdict overridden",
  entity: "Entity merged",
  deleted: "Item deleted outright",
};

export function categoryLabel(c: CorrectionCategory): string {
  return LABEL[c] ?? c;
}

type AuditRow = {
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

/**
 * Sources whose deletion says nothing about the classifier.
 *
 * The 30-day window still contains the 2026-07-29 import purge — 616 Apple
 * Notes the owner deleted wholesale because he wanted a fresh brain, not
 * because anything was misfiled. Counting those made the first run of this
 * report read "41 items deleted outright" with no examples, which is both
 * unactionable and wrong about what it claims to measure.
 */
const BULK_IMPORT_SOURCES = new Set(["apple-notes", "chatgpt-profile", "readwise"]);

function isBulkImportCleanup(d: Record<string, unknown>): boolean {
  const one = typeof d.source === "string" ? d.source : "";
  const many = Array.isArray(d.sources) ? (d.sources as string[]) : [];
  if (one && BULK_IMPORT_SOURCES.has(one)) return true;
  if (many.some((s) => BULK_IMPORT_SOURCES.has(s))) return true;
  // A row that reports a COUNT rather than an item is a batch operation, not a
  // judgement about one capture.
  return typeof d.count === "number" && d.count > 1;
}

/**
 * Map one audit row to the classifier failure it represents.
 *
 * Returns null for rows that are not a correction — approving something the
 * machine proposed is agreement, not a mistake, and counting it would make the
 * error rate look worse the more the system got right.
 */
export function categorize(row: AuditRow): { category: CorrectionCategory; example: string } | null {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const asText = (v: unknown) => (typeof v === "string" ? v : "");
  // A bulk import cleanup is an owner decision about a backlog, not a
  // correction of something the classifier got wrong.
  if (isBulkImportCleanup(d)) return null;

  switch (row.action) {
    case "deck_edit": {
      // The deck writes what actually changed; prefer the specific field.
      const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
      const title = asText(d.title) || asText(d.newTitle);
      if (fields.includes("type") || d.type) return { category: "type", example: title || asText(d.type) };
      if (fields.includes("tags") || d.tags) return { category: "tags", example: title };
      return { category: "title", example: title };
    }
    case "workshop_correction": {
      const to = (d.to ?? {}) as Record<string, unknown>;
      const why = asText(d.why);
      if (to.type) return { category: "type", example: why || asText(to.type) };
      if (to.tags) return { category: "tags", example: why };
      return { category: "title", example: why };
    }
    case "retitle_undone":
    case "split_undone":
      return { category: "title", example: asText(d.title) };
    case "review_merge":
      return { category: "duplicate", example: asText(d.title) };
    case "deck_rejected": {
      // A rejection in the deck is a rejection of a PROPOSAL, not a deletion of
      // an item — `detail.kind` says which. 36 rejected retitles were being
      // reported as "items deleted outright", which described neither what
      // happened nor which part of the prompt was at fault.
      const kind = asText(d.kind);
      if (kind === "retitle" || kind === "split") {
        return { category: "title", example: asText(d.title) };
      }
      return { category: "deleted", example: asText(d.title) };
    }
    case "review_delete":
    case "import_remove":
      return { category: "deleted", example: asText(d.title) };
    case "deck_archived":
      return { category: "junk", example: asText(d.title) };
    case "entity_merged":
      return { category: "entity", example: `${asText(d.from)} → ${asText(d.into)}` };
    default:
      return null;
  }
}

export async function buildCorrectionReport(
  admin: SupabaseClient,
  userId: string,
  days = 30
): Promise<CorrectionReport> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const [{ data: rows }, { count: captures }] = await Promise.all([
    admin
      .from("audit")
      .select("action,detail,created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .limit(5000),
    admin
      .from("audit")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("action", "capture")
      .gte("created_at", since),
  ]);

  const byCategory = new Map<CorrectionCategory, CorrectionStat>();
  for (const r of (rows ?? []) as AuditRow[]) {
    const hit = categorize(r);
    if (!hit) continue;
    const stat = byCategory.get(hit.category) ?? { category: hit.category, count: 0, examples: [] };
    stat.count += 1;
    if (hit.example && stat.examples.length < 3 && !stat.examples.includes(hit.example)) {
      stat.examples.push(hit.example);
    }
    byCategory.set(hit.category, stat);
  }

  const stats = [...byCategory.values()].sort((a, b) => b.count - a.count);
  return {
    since,
    total: stats.reduce((n, s) => n + s.count, 0),
    stats,
    captures: captures ?? 0,
  };
}
