import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v2.4/v1.6 curation — review the on-hold Apple-Notes import and choose which to
// keep. GET: a page of archived apple-notes items (with optional type/search
// filter). POST: activate (un-archive → searchable) or remove (delete) by ids.
const PAGE = 40;

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const type = url.searchParams.get("type") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();

  const admin = createAdminClient();
  let query = admin
    .from("items")
    .select("id,title,type,tags,body", { count: "exact" })
    .eq("user_id", user.id)
    .eq("source", "apple-notes")
    .eq("status", "archived");
  if (type) query = query.eq("type", type);
  if (q) query = query.or(`title.ilike.%${q}%,body.ilike.%${q}%`);

  const { data, count, error } = await query
    .order("title")
    .range(offset, offset + PAGE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (data ?? []).map((i) => ({
    id: i.id,
    title: i.title,
    type: i.type,
    tags: i.tags ?? [],
    snippet: (i.body ?? "").replace(/\s+/g, " ").slice(0, 140),
  }));
  return NextResponse.json({ items, total: count ?? 0, offset, limit: PAGE });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let ids: string[] = [];
  let action = "";
  try {
    ({ ids, action } = await req.json());
  } catch {
    // ignore
  }
  if (!Array.isArray(ids) || ids.length === 0 || (action !== "activate" && action !== "remove")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Scope strictly to the owner's archived apple-notes so nothing else is touched.
  const base = admin
    .from("items")
    .select("id")
    .eq("user_id", user.id)
    .eq("source", "apple-notes")
    .eq("status", "archived")
    .in("id", ids);
  const { data: valid } = await base;
  const validIds = (valid ?? []).map((r) => r.id);
  if (validIds.length === 0) return NextResponse.json({ ok: true, affected: 0 });

  if (action === "activate") {
    await admin.from("items").update({ status: "open" }).in("id", validIds).eq("user_id", user.id);
  } else {
    await admin.from("audit").delete().in("item_id", validIds);
    await admin.from("items").delete().in("id", validIds).eq("user_id", user.id);
  }
  await logAudit(admin, {
    user_id: user.id,
    action: action === "activate" ? "import_activate" : "import_remove",
    actor: "user",
    detail: { source: "apple-notes", count: validIds.length },
  });

  return NextResponse.json({ ok: true, affected: validIds.length });
}
