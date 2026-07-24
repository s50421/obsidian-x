import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { applyProposal, rejectProposalById } from "@/lib/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Approve/reject a proposal from the /approvals web page (owner-authenticated).
// Shares the same apply/reject logic the Telegram buttons use.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let id = "";
  let action = "";
  try {
    ({ id, action } = await req.json());
  } catch {
    // ignore
  }
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (action === "approve") {
    const r = await applyProposal(admin, user.id, id);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }
  const ok = await rejectProposalById(admin, user.id, id);
  return NextResponse.json({ ok });
}
