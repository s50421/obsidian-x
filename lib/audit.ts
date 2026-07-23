import type { SupabaseClient } from "@supabase/supabase-js";

// Append-only audit trail. Logging must never break the main flow.

export type AuditEntry = {
  user_id: string;
  item_id?: string | null;
  action: string; // capture | email_capture | review_approve | review_merge | review_delete | supersede | ...
  actor?: "user" | "system" | "email" | "worker";
  detail?: Record<string, unknown>;
};

export async function logAudit(admin: SupabaseClient, e: AuditEntry): Promise<void> {
  try {
    await admin.from("audit").insert({
      user_id: e.user_id,
      item_id: e.item_id ?? null,
      action: e.action,
      actor: e.actor ?? "system",
      detail: e.detail ?? {},
    });
  } catch {
    // swallow — an audit failure must not fail the operation
  }
}
