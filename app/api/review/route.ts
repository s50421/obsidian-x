import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { deleteVaultNote } from "@/lib/vault";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) return null;
  return user;
}

// GET: list the items flagged for review (low confidence or possible duplicate).
export async function GET() {
  const user = await requireOwner();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("items")
    .select("id, title, type, priority, review_reason, dup_candidate, created_at")
    .eq("user_id", user.id)
    .eq("needs_review", true)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items = rows ?? [];
  // Resolve duplicate-candidate titles in one extra query.
  const dupIds = [...new Set(items.map((i) => i.dup_candidate).filter(Boolean))] as string[];
  const dupTitles: Record<string, string> = {};
  if (dupIds.length) {
    const { data: dups } = await admin.from("items").select("id, title").in("id", dupIds);
    for (const d of dups ?? []) dupTitles[d.id] = d.title;
  }

  return NextResponse.json({
    items: items.map((i) => ({
      ...i,
      dup_title: i.dup_candidate ? (dupTitles[i.dup_candidate] ?? null) : null,
    })),
  });
}

// POST: act on a flagged item. { id, action: "approve" | "merge" | "delete" }
export async function POST(req: Request) {
  const user = await requireOwner();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let id = "";
  let action = "";
  try {
    ({ id, action } = await req.json());
  } catch {
    // handled below
  }
  if (!id || !["approve", "merge", "delete"].includes(action)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Scope every action to the owner's own row.
  const { data: item } = await admin
    .from("items")
    .select("id, vault_path, dup_candidate")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (action === "approve") {
    await admin
      .from("items")
      .update({ needs_review: false, review_reason: null, dup_candidate: null })
      .eq("id", id);
    await logAudit(admin, {
      user_id: user.id,
      item_id: id,
      action: "review_approve",
      actor: "user",
    });
  } else if (action === "merge") {
    // Keep the original; bi-temporally supersede this duplicate + drop its vault projection.
    await admin
      .from("items")
      .update({
        status: "archived",
        needs_review: false,
        review_reason: null,
        valid_to: new Date().toISOString(),
        superseded_by: item.dup_candidate ?? null,
      })
      .eq("id", id);
    if (item.vault_path) await deleteVaultNote(item.vault_path).catch(() => {});
    await logAudit(admin, {
      user_id: user.id,
      item_id: id,
      action: "review_merge",
      actor: "user",
      detail: { superseded_by: item.dup_candidate },
    });
  } else if (action === "delete") {
    await admin.from("items").delete().eq("id", id);
    if (item.vault_path) await deleteVaultNote(item.vault_path).catch(() => {});
    await logAudit(admin, {
      user_id: user.id,
      item_id: id,
      action: "review_delete",
      actor: "user",
    });
  }

  return NextResponse.json({ ok: true });
}
