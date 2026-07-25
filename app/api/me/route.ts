import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight identity + badge feed for the shared nav (email + pending-approvals
// count). Owner-authed via the session cookie, like the other page-facing routes.
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

  return NextResponse.json({ email: user.email, pending: count ?? 0 });
}
