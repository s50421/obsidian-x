import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getClickUpComments,
  getClickUpDescription,
  getClickUpTaskStatus,
  isClickUpDone,
} from "@/lib/clickup";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { logAudit } from "@/lib/audit";
import { sendMessage } from "@/lib/telegram";

// v2.2 — ClickUp → brain status sync-back. Shared by the ClickUp webhook
// (real-time, best-effort) and the reconcile cron (reliable). The DB stays the
// source of truth for capture; ClickUp is authoritative for a linked task's
// completion state.

export type LinkedItem = {
  id: string;
  status: string;
  user_id: string;
  title: string;
  external: { clickup?: { id?: string } } | null;
};

const LINK_SELECT = "id, status, user_id, title, external";

// Bring one linked item's status in line with its ClickUp task. Returns the new
// status if it changed, else null.
export async function syncItemFromClickUp(
  admin: SupabaseClient,
  item: LinkedItem,
  notify: boolean
): Promise<"done" | "open" | null> {
  const taskId = item.external?.clickup?.id;
  if (!taskId) return null;
  const cu = await getClickUpTaskStatus(taskId);
  if (!cu) return null;
  const done = isClickUpDone(cu.type);

  if (done && item.status !== "done") {
    await apply(admin, item, "done", "clickup_sync_done", `✓ ClickUp done → marked done: ${item.title}`, notify);
    return "done";
  }
  if (!done && item.status === "done") {
    await apply(admin, item, "open", "clickup_sync_reopen", `↩ ClickUp reopened → reopened: ${item.title}`, notify);
    return "open";
  }
  return null;
}

async function apply(
  admin: SupabaseClient,
  item: LinkedItem,
  status: "done" | "open",
  action: string,
  notice: string,
  notify: boolean
): Promise<void> {
  await admin.from("items").update({ status }).eq("id", item.id).eq("user_id", item.user_id);
  await logAudit(admin, { user_id: item.user_id, item_id: item.id, action, actor: "worker", detail: { via: "clickup" } });
  await reprojectItemToVault(admin, item.id);
  if (notify) await sendMessage(notice, { parse_mode: "plain" });
}

// Fetch the single linked item for a ClickUp task id (used by the webhook).
export async function findLinkedItem(
  admin: SupabaseClient,
  taskId: string
): Promise<LinkedItem | null> {
  const { data } = await admin.from("items").select(LINK_SELECT).not("external", "is", null);
  return ((data ?? []) as LinkedItem[]).find((i) => i.external?.clickup?.id === taskId) ?? null;
}

/* ---------------------------------------------------------------------------
   v4.2 — notes sync-back.

   Status has flowed both ways since v2.2. What was missing is the thing the
   owner actually asked for: "if I can add notes to my ClickUp… these should be
   pulled back into the brain including the status." Working a task usually
   means typing into it, and until now that thinking stayed stranded on the
   board while the brain — the supposed single source of truth — knew nothing
   about it.

   Appended to the item body under a marked block rather than merged into it,
   so the owner's original capture is never rewritten by an outside system, and
   so re-syncing is idempotent (each comment is keyed by its ClickUp id).
   --------------------------------------------------------------------------- */

const NOTES_HEADER = "## From ClickUp";

/** Comment ids already pulled in, read straight back out of the body. */
function alreadyPulled(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/<!--\s*clickup-comment:([^\s>]+)\s*-->/g)) out.add(m[1]);
  if (/<!--\s*clickup-description\s*-->/.test(body)) out.add("__description__");
  return out;
}

function fmtWhen(ms: number): string {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(ms));
  } catch {
    return "";
  }
}

/**
 * Pull new ClickUp comments (and the description, once) into the brain item.
 * Returns how many blocks were appended.
 */
export async function syncNotesFromClickUp(
  admin: SupabaseClient,
  item: LinkedItem & { body?: string | null }
): Promise<number> {
  const taskId = item.external?.clickup?.id;
  if (!taskId) return 0;

  const { data: full } = await admin
    .from("items")
    .select("body")
    .eq("id", item.id)
    .eq("user_id", item.user_id)
    .maybeSingle();
  const body = (full?.body as string | undefined) ?? "";
  const have = alreadyPulled(body);

  const additions: string[] = [];

  try {
    const comments = await getClickUpComments(taskId);
    for (const c of comments) {
      if (have.has(c.id)) continue;
      const when = fmtWhen(c.date);
      additions.push(
        `<!-- clickup-comment:${c.id} -->\n**${c.user}**${when ? ` · ${when}` : ""}\n${c.text}`
      );
    }
  } catch {
    // best-effort — a comment fetch failure must not break the status reconcile
  }

  // The description is pulled once: it's the task's own notes field, and after
  // the first pull the owner's edits to it are better treated as history than
  // as something to keep re-appending.
  if (!have.has("__description__")) {
    try {
      const desc = await getClickUpDescription(taskId);
      if (desc && !body.includes(desc)) {
        additions.push(`<!-- clickup-description -->\n${desc}`);
      }
    } catch {
      // best-effort
    }
  }

  if (!additions.length) return 0;

  const header = body.includes(NOTES_HEADER) ? "" : `\n\n${NOTES_HEADER}\n`;
  const nextBody = `${body}${header}\n${additions.join("\n\n")}`.trim();

  const { error } = await admin
    .from("items")
    .update({ body: nextBody })
    .eq("id", item.id)
    .eq("user_id", item.user_id);
  if (error) return 0;

  await logAudit(admin, {
    user_id: item.user_id,
    item_id: item.id,
    action: "clickup_notes_pulled",
    actor: "worker",
    detail: { task_id: taskId, blocks: additions.length },
  });
  await reprojectItemToVault(admin, item.id);
  return additions.length;
}

// Reconcile every linked item against ClickUp (used by the cron). Returns counts.
export async function reconcileLinkedItems(
  admin: SupabaseClient,
  userId: string
): Promise<{ checked: number; synced: number; notesPulled: number }> {
  const { data } = await admin
    .from("items")
    .select(LINK_SELECT)
    .eq("user_id", userId)
    .not("external", "is", null);
  const items = (data ?? []) as LinkedItem[];
  let synced = 0;
  let notesPulled = 0;
  for (const it of items) {
    const r = await syncItemFromClickUp(admin, it, true);
    if (r) synced++;
    notesPulled += await syncNotesFromClickUp(admin, it);
  }
  return { checked: items.length, synced, notesPulled };
}
