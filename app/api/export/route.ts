import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { exportBrain } from "@/lib/export-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v3.4 — one-click full export of the brain as JSON (no lock-in). Owner-authed.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const data = await exportBrain(admin, user.id);
  const body = JSON.stringify(data, null, 2);
  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="obsidian-x-export-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
