import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { syncAllMailboxes } from "@/lib/gmail-sync";
import { ensureDeclaredSources } from "@/lib/source-status";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// v4.1 — incremental Gmail inflow sync.
//
// Driven by the GitHub Actions pinger every 15 min (Vercel Hobby rejects
// sub-daily crons). Idempotent and cheap when there's no new mail: the History
// API returns an empty delta and the run exits in well under a second.
//
// `?max=` caps messages per run (useful for a first, gentle backfill).
// `?dry=1` reports what is connected without syncing.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1";
  const maxRaw = Number(params.get("max"));
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : undefined;

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  await ensureDeclaredSources(admin, owner.id);

  if (dry) {
    const { loadAccounts } = await import("@/lib/google-auth");
    const accounts = await loadAccounts(admin, owner.id);
    return NextResponse.json({
      dry: true,
      mailboxes: accounts.map((a) => ({
        email: a.email,
        backfilled: !!a.history_id,
        connected_at: a.connected_at,
      })),
    });
  }

  const results = await syncAllMailboxes(admin, owner.id, max ? { max } : {});

  const totals = results.reduce(
    (a, r) => ({
      seen: a.seen + r.seen,
      inserted: a.inserted + r.inserted,
      ranked: a.ranked + r.ranked,
      autoCreated: a.autoCreated + r.autoCreated,
    }),
    { seen: 0, inserted: 0, ranked: 0, autoCreated: 0 }
  );

  // Only log a real event — a no-op tick every 15 min would drown the audit.
  if (totals.inserted > 0) {
    await logAudit(admin, {
      user_id: owner.id,
      action: "gmail_sync",
      actor: "system",
      detail: { ...totals, mailboxes: results.length },
    });
  }

  return NextResponse.json({ ok: true, totals, results });
}
