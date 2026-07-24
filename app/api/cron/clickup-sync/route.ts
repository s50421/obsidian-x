import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { reconcileLinkedItems } from "@/lib/clickup-sync";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v2.2 — reliable ClickUp → brain reconcile. Polls every linked item's ClickUp
// task status and mirrors completion/reopen. Backstops the (best-effort) webhook.
// Triggered by Vercel Cron or a manual authorized call.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  const { checked, synced } = await reconcileLinkedItems(admin, owner.id);
  if (synced > 0) {
    await logAudit(admin, { user_id: owner.id, action: "clickup_reconcile", actor: "system", detail: { checked, synced } });
  }
  return NextResponse.json({ ok: true, checked, synced });
}
