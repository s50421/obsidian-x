import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { logAudit } from "@/lib/audit";
import { loadAccounts, removeAccount } from "@/lib/google-auth";
import { reportSourceStatus } from "@/lib/source-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v4.1 — drop a connected mailbox. The inflow ledger is left intact (it is
// history, not a live claim); the coverage panel immediately reports the
// mailbox as disconnected, which is the honest state.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let mailbox = "";
  try {
    const b = (await req.json()) as { mailbox?: string };
    mailbox = (b.mailbox ?? "").trim();
  } catch {
    // fall through
  }
  if (!mailbox) return NextResponse.json({ error: "mailbox required" }, { status: 400 });

  const admin = createAdminClient();
  await removeAccount(admin, user.id, mailbox);
  await admin
    .from("source_status")
    .delete()
    .eq("user_id", user.id)
    .eq("source", "gmail")
    .eq("channel", mailbox);

  const remaining = await loadAccounts(admin, user.id);
  await reportSourceStatus(admin, user.id, {
    source: "gmail",
    label: "Gmail",
    connected: remaining.length > 0,
    error: null,
    detail: { mailboxes: remaining.length },
  });
  await logAudit(admin, {
    user_id: user.id,
    action: "gmail_disconnected",
    actor: "user",
    detail: { mailbox },
  });

  return NextResponse.json({ ok: true, remaining: remaining.map((a) => a.email) });
}
