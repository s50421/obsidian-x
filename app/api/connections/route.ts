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

  let body: { id?: string; action?: string; src?: string; dst?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { id, action } = body;
  const admin = createAdminClient();

  // Draw a connection by hand. Stored as kind='manual' so the nightly rebuild
  // re-adds it verbatim instead of deleting something it never derived.
  if (action === "create") {
    const { src, dst, reason } = body;
    if (!src || !dst || src === dst) {
      return NextResponse.json({ error: "two different items are required" }, { status: 400 });
    }
    const [a, b] = src < dst ? [src, dst] : [dst, src];
    const { data: owned } = await admin
      .from("items")
      .select("id,title")
      .eq("user_id", user.id)
      .in("id", [a, b]);
    if ((owned ?? []).length !== 2) {
      return NextResponse.json({ error: "item not found" }, { status: 404 });
    }
    const { error } = await admin.from("edges").upsert(
      {
        user_id: user.id,
        src: a,
        dst: b,
        kind: "manual",
        // A hand-drawn connection still has to explain itself — same rule as
        // every derived one. Falls back to something honest if left blank.
        reason: (reason ?? "").trim() || "you linked these",
        weight: 1,
        discovery: false,
        status: "confirmed",
      },
      { onConflict: "user_id,src,dst,kind,entity_id", ignoreDuplicates: false }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logAudit(admin, {
      user_id: user.id,
      item_id: a,
      action: "connection_created",
      actor: "user",
      detail: { src: a, dst: b, reason },
    });
    return NextResponse.json({ ok: true, status: "confirmed" });
  }

  if (!id || (action !== "confirm" && action !== "dismiss" && action !== "remove")) {
    return NextResponse.json(
      { error: "action must be create, confirm, dismiss or remove" },
      { status: 400 }
    );
  }
  const { data: edge } = await admin
    .from("edges")
    .select("id,src,dst,kind,reason,status")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!edge) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Removing a DERIVED connection has to be remembered, not deleted — the
  // rebuild would simply re-derive it tonight. 'dismissed' is that memory. A
  // hand-drawn one has nothing to re-derive it, so it really is deleted.
  if (action === "remove" && edge.kind === "manual") {
    await admin.from("edges").delete().eq("id", id).eq("user_id", user.id);
    await logAudit(admin, {
      user_id: user.id,
      item_id: edge.src as string,
      action: "connection_removed",
      actor: "user",
      detail: { src: edge.src, dst: edge.dst, kind: edge.kind },
    });
    return NextResponse.json({ ok: true, status: "removed" });
  }

  const status = action === "confirm" ? "confirmed" : "dismissed";
  await admin.from("edges").update({ status }).eq("id", id).eq("user_id", user.id);

  await logAudit(admin, {
    user_id: user.id,
    item_id: edge.src as string,
    action:
      action === "confirm"
        ? "connection_confirmed"
        : action === "remove"
          ? "connection_removed"
          : "connection_dismissed",
    actor: "user",
    detail: { src: edge.src, dst: edge.dst, kind: edge.kind, reason: edge.reason },
  });

  return NextResponse.json({ ok: true, status });
}
