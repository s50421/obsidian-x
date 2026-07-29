import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { resolveOwnerTz } from "@/lib/tz";
import { countDailyUnreviewed, countPendingImportProposals } from "@/app/api/deck/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight identity + badge feed for the shared nav (email + pending-approvals
// count + the deck badge). Owner-authed via the session cookie, like the other
// page-facing routes.
//
// `deckPending` (v4.0 W3) = today's un-swiped daily-deck items + pending
// import (retitle/split) proposals — the same two counts the evening nudge
// cron uses, so the nav badge and the Telegram nudge always agree.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { count } = await admin
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "pending");

  let deckPending = 0;
  try {
    const tz = await resolveOwnerTz(admin, user.id);
    const [{ remaining }, importPending] = await Promise.all([
      countDailyUnreviewed(admin, user.id, tz),
      countPendingImportProposals(admin, user.id),
    ]);
    deckPending = remaining + importPending;
  } catch {
    // never let the nav badge feed break the rest of /api/me
  }

  return NextResponse.json({ email: user.email, pending: count ?? 0, deckPending });
}
