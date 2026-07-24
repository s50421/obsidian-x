import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage } from "@/lib/telegram";
import { createClickUpTask } from "@/lib/clickup";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { logAudit } from "@/lib/audit";

// v1.5 T2/T4: turn an actionable item (e.g. a task captured from an email) into a
// pending proposal to create a ClickUp task, surface it to the owner (Telegram +
// /approvals), and apply/reject it. Approving runs the action.

export type ProposalRow = { id: string; title: string | null };

type ClickUpPayload = {
  name?: string;
  description?: string | null;
  due_at?: string | null;
  priority?: string | null;
};

export type ApplyResult = {
  ok: boolean;
  message: string;
  url?: string;
  alreadyHandled?: boolean;
};

// Create a `clickup_task` proposal from an existing item. Returns the row, or
// null if the item is missing.
export async function proposeClickUpTaskForItem(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  source: string
): Promise<ProposalRow | null> {
  const { data: item } = await admin
    .from("items")
    .select("id, title, body, due_at, priority, type, external")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!item) return null;
  // Reconcile: don't propose a second ClickUp task for an item already linked.
  const external = item.external as { clickup?: { id?: string } } | null;
  if (external?.clickup?.id) return null;

  const payload: ClickUpPayload = {
    name: item.title,
    description: item.body ?? null,
    due_at: item.due_at ?? null,
    priority: item.priority ?? null,
  };

  const { data: p } = await admin
    .from("proposals")
    .insert({
      user_id: userId,
      kind: "clickup_task",
      status: "pending",
      title: item.title,
      payload,
      source,
      source_item_id: item.id,
    })
    .select("id, title")
    .single();

  return p ?? null;
}

// Push a pending clickup_task proposal to Telegram with Approve/Reject buttons.
export async function notifyClickUpProposal(p: ProposalRow): Promise<void> {
  await sendMessage(`📋 Proposed task: ${p.title ?? "(untitled)"}\n\nAdd this to ClickUp?`, {
    parse_mode: "plain",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${p.id}` },
          { text: "✖ Reject", callback_data: `reject:${p.id}` },
        ],
      ],
    },
  });
}

// Approve a pending proposal → run its action. Currently: create a ClickUp task,
// record the ref back on the source item, and audit it. Shared by Telegram +
// the /approvals page. Never throws — returns a structured result.
export async function applyProposal(
  admin: SupabaseClient,
  userId: string,
  proposalId: string
): Promise<ApplyResult> {
  const { data: p } = await admin
    .from("proposals")
    .select("id, kind, status, payload, source_item_id, title")
    .eq("id", proposalId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!p) return { ok: false, alreadyHandled: true, message: "This request is no longer available" };
  if (p.status !== "pending") return { ok: false, alreadyHandled: true, message: "Already handled" };
  if (p.kind !== "clickup_task") return { ok: false, message: "Unsupported proposal kind" };

  const payload = (p.payload ?? {}) as ClickUpPayload;
  try {
    const task = await createClickUpTask({
      name: payload.name ?? p.title ?? "Task",
      description: payload.description ?? null,
      dueAt: payload.due_at ?? null,
      priority: payload.priority ?? null,
    });
    await admin
      .from("proposals")
      .update({
        status: "approved",
        decided_at: new Date().toISOString(),
        result: { clickup_id: task.id, url: task.url },
      })
      .eq("id", proposalId);
    if (p.source_item_id) {
      await admin
        .from("items")
        .update({ external: { clickup: { id: task.id, url: task.url } } })
        .eq("id", p.source_item_id)
        .eq("user_id", userId);
      await reprojectItemToVault(admin, p.source_item_id); // project the ClickUp link into the vault
    }
    await logAudit(admin, {
      user_id: userId,
      item_id: p.source_item_id,
      action: "clickup_task_created",
      actor: "user",
      detail: { proposal_id: proposalId, clickup_id: task.id, url: task.url },
    });
    return { ok: true, message: `Created in ClickUp: ${task.name}`, url: task.url };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// Reject a pending proposal. Returns true if it was pending and is now rejected.
export async function rejectProposalById(
  admin: SupabaseClient,
  userId: string,
  proposalId: string
): Promise<boolean> {
  const { data: p } = await admin
    .from("proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id, source_item_id")
    .maybeSingle();
  if (p) {
    await logAudit(admin, {
      user_id: userId,
      item_id: p.source_item_id,
      action: "proposal_rejected",
      actor: "user",
      detail: { proposal_id: proposalId },
    });
  }
  return !!p;
}
