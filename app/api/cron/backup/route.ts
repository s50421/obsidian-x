import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { exportBrain } from "@/lib/export-brain";
import { writeVaultFile } from "@/lib/vault";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v3.4 — weekly backup: commit a JSON snapshot of the brain to the vault repo
// (git history keeps every prior version). CRON_SECRET-authed.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  const data = await exportBrain(admin, owner.id);
  const content = JSON.stringify(data, null, 2);
  const date = new Date().toISOString().slice(0, 10);

  try {
    await writeVaultFile("backups/obsidian-x.json", content, `backup ${date} (${data.item_count} items)`);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  await logAudit(admin, {
    user_id: owner.id,
    action: "backup",
    actor: "system",
    detail: { item_count: data.item_count },
  });

  return NextResponse.json({ ok: true, item_count: data.item_count });
}
