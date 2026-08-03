import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { logAudit } from "@/lib/audit";
import { reprojectItemToVault } from "@/lib/vault-sync";
import { ALLOWED_TYPES } from "@/lib/title-standard.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["open", "done", "archived"];
const PRIORITIES = ["low", "medium", "high"];

/**
 * Edit one memory from its own page.
 *
 * Separate from /api/deck/act, which edits in the CONTEXT of a review sweep and
 * carries that semantics (keep/reject/archive alongside the edit). This is the
 * plain "open a thing and change it" path, and it is the only one that can edit
 * the BODY — the deck deliberately doesn't, because a swipe is not the moment
 * to rewrite a memory.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("items")
    .select("id,title,type,tags,priority,status,body,due_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!before) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Whitelist, not passthrough — an editor must never be able to write
  // embedding, source, or the audit-relevant columns.
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 300);
  if (typeof body.body === "string") patch.body = body.body.slice(0, 100_000);
  if (typeof body.type === "string" && ALLOWED_TYPES.includes(body.type)) patch.type = body.type;
  if (typeof body.status === "string" && STATUSES.includes(body.status)) patch.status = body.status;
  if (body.priority === null || (typeof body.priority === "string" && PRIORITIES.includes(body.priority)))
    patch.priority = body.priority;
  if (Array.isArray(body.tags))
    patch.tags = body.tags.filter((t): t is string => typeof t === "string").slice(0, 20);
  if (body.due_at === null || typeof body.due_at === "string") patch.due_at = body.due_at || null;

  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: true, message: "Nothing to save" });
  }

  // An edit no longer needs review — the owner just told us what it should say.
  patch.needs_review = false;
  patch.review_reason = null;
  patch.updated_at = new Date().toISOString();

  const { error } = await admin.from("items").update(patch).eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await reprojectItemToVault(admin, id).catch(() => {});
  await logAudit(admin, {
    user_id: user.id,
    item_id: id,
    action: "item_edited",
    actor: "user",
    // The BEFORE values, so the corrections report can tell what the classifier
    // actually got wrong rather than merely that something changed.
    detail: {
      fields: Object.keys(patch).filter((k) => !["needs_review", "review_reason", "updated_at"].includes(k)),
      title: before.title,
      from: {
        type: before.type,
        tags: before.tags,
        priority: before.priority,
        status: before.status,
      },
    },
  });

  return NextResponse.json({ ok: true, message: "Saved" });
}
