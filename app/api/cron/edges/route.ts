import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { logAudit } from "@/lib/audit";
import { rebuildEdges } from "@/lib/edges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Brain-quality Phase 2 — keep the typed connection graph current.
//
// A full rebuild rather than an incremental update. The derivation is pure and
// the corpus is small, and an incremental edge table drifts out of sync with
// the entities it came from the first time a merge lands — cheap correctness
// beats clever bookkeeping at this size. Revisit if the corpus reaches a scale
// where a full pass stops being free.
//
// `?dry=1` reports what WOULD be written without touching the table.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1";
  // Similarity edges cost one vector query per item. Cheap now, and the flag
  // means a future large corpus can drop them without a code change.
  const includeSimilar = params.get("similar") !== "0";

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  if (dry) {
    const { count } = await admin
      .from("edges")
      .select("id", { count: "exact", head: true })
      .eq("user_id", owner.id);
    return NextResponse.json({ dry: true, currentEdges: count ?? 0 });
  }

  const res = await rebuildEdges(admin, owner.id, { includeSimilar });
  await logAudit(admin, {
    user_id: owner.id,
    action: "edges_rebuilt",
    actor: "system",
    detail: { ...res },
  });
  return NextResponse.json({ ok: true, ...res });
}
