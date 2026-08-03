import type { SupabaseClient } from "@supabase/supabase-js";

// Append-only audit trail. Logging must never break the main flow.

export type AuditEntry = {
  user_id: string;
  item_id?: string | null;
  action: string; // capture | email_capture | review_approve | review_merge | review_delete | supersede | ...
  // "agent" is its own actor (v4.2.3). An action the tool loop took on the
  // owner's behalf must be distinguishable from one he took himself — that
  // distinction is what the propose-then-approve law is enforced against, and
  // v4.3's MCP agents will use the same value.
  actor?: "user" | "system" | "email" | "worker" | "agent";
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
