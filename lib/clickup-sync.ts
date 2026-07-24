import type { SupabaseClient } from "@supabase/supabase-js";
import { getClickUpTaskStatus, isClickUpDone } from "@/lib/clickup";
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

// Reconcile every linked item against ClickUp (used by the cron). Returns counts.
export async function reconcileLinkedItems(
  admin: SupabaseClient,
  userId: string
): Promise<{ checked: number; synced: number }> {
  const { data } = await admin
    .from("items")
    .select(LINK_SELECT)
    .eq("user_id", userId)
    .not("external", "is", null);
  const items = (data ?? []) as LinkedItem[];
  let synced = 0;
  for (const it of items) {
    const r = await syncItemFromClickUp(admin, it, true);
    if (r) synced++;
  }
  return { checked: items.length, synced };
}
