import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accept or dismiss a SUGGESTED connection — the Obsidian "unlinked mention →
// link" conversion, adapted.
//
// A dismissal is remembered rather than deleted: the nightly rebuild reads
// status='dismissed' before proposing anything, so a pair the owner has
// rejected is never offered again. Deleting the row would mean the same
// suggestion returned every night and the feature felt broken within a week.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { id, action } = body;
  if (!id || (action !== "confirm" && action !== "dismiss")) {
    return NextResponse.json({ error: "id and action (confirm|dismiss) required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: edge } = await admin
    .from("edges")
    .select("id,src,dst,kind,reason,status")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!edge) return NextResponse.json({ error: "not found" }, { status: 404 });

  const status = action === "confirm" ? "confirmed" : "dismissed";
  await admin.from("edges").update({ status }).eq("id", id).eq("user_id", user.id);

  await logAudit(admin, {
    user_id: user.id,
    item_id: edge.src as string,
    action: action === "confirm" ? "connection_confirmed" : "connection_dismissed",
    actor: "user",
    detail: { src: edge.src, dst: edge.dst, kind: edge.kind, reason: edge.reason },
  });

  return NextResponse.json({ ok: true, status });
}
