import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { classify } from "@/lib/classify";
import { embed } from "@/lib/embed";
import { writeVaultNote, vaultUrl } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let text = "";
  try {
    ({ text } = await req.json());
  } catch {
    // ignore, handled below
  }
  text = (text ?? "").toString().trim();
  if (!text) {
    return NextResponse.json({ error: "empty note" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 1. classify  2. embed  3. store
  const c = await classify(text);
  const embedding = await embed(`${c.title}\n\n${text}`);
  const createdAt = new Date().toISOString();

  const { data: item, error } = await admin
    .from("items")
    .insert({
      user_id: user.id,
      type: c.type,
      title: c.title,
      body: text,
      status: "inbox",
      priority: c.priority,
      tags: c.tags,
      source: "typed",
      embedding,
      created_at: createdAt,
      valid_from: createdAt,
    })
    .select("id, type, title, tags, priority, created_at")
    .single();

  if (error || !item) {
    return NextResponse.json(
      { error: `db insert failed: ${error?.message ?? "unknown"}` },
      { status: 500 }
    );
  }

  // 4. project to the vault (best effort — a failed write must not lose the note)
  let vault_path: string | null = null;
  let vault_url: string | null = null;
  let vaultError: string | null = null;
  try {
    vault_path = await writeVaultNote({
      id: item.id,
      type: item.type,
      title: item.title,
      body: text,
      tags: item.tags ?? [],
      priority: item.priority,
      source: "typed",
      createdAt,
    });
    vault_url = vaultUrl(vault_path);
    await admin.from("items").update({ vault_path }).eq("id", item.id);
  } catch (e) {
    vaultError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({ item, vault_path, vault_url, vaultError });
}
