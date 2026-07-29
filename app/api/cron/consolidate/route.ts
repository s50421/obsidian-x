import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { chat } from "@/lib/openrouter";
import { embedText } from "@/lib/embed";
import { writeVaultNote } from "@/lib/vault";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";
import { isCronAuthorized } from "@/lib/cron";
import { notifyTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nightly consolidation: summarize the last 24h of captures into a digest note
// and push it to Telegram. Triggered by Vercel Cron (or a manual authorized call).
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: list, error: le } = await admin.auth.admin.listUsers();
  if (le) return NextResponse.json({ error: le.message }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: items } = await admin
    .from("items")
    .select("title,type,body,due_at,sensitive")
    .eq("user_id", owner.id)
    .eq("status", "open")
    .is("valid_to", null)
    .neq("source", "system") // don't consolidate previous digests
    .gte("created_at", since)
    .order("created_at");

  if (!items || items.length === 0) {
    return NextResponse.json({ ok: true, note: "nothing to consolidate" });
  }

  // Sensitive notes are referenced by title only (never sent to the cloud model).
  const listText = items
    .map((it) => {
      const body = it.sensitive ? "(private)" : (it.body ?? "").slice(0, 200);
      const due = it.due_at ? ` [due ${it.due_at.slice(0, 10)}]` : "";
      return `- (${it.type}) ${it.title}${due}: ${body}`;
    })
    .join("\n");

  const { content: summary, usage } = await chat(
    process.env.OPENROUTER_ANSWER_MODEL!,
    [
      {
        role: "system",
        content:
          "You are the user's second brain. Summarize today's captures into a short daily digest: " +
          "2-3 sentences of what happened, then a bulleted list of any open tasks or upcoming due items. " +
          "Be concise and useful. Do not invent anything not in the notes.",
      },
      { role: "user", content: `Today's ${items.length} captures:\n${listText}` },
    ]
  );
  await logLlmUsage(admin, owner.id, "consolidate", usage);

  const createdAt = new Date().toISOString();
  const title = `Daily digest — ${createdAt.slice(0, 10)}`;
  const embedding = await embedText(`${title}\n\n${summary}`);

  const { data: item, error } = await admin
    .from("items")
    .insert({
      user_id: owner.id,
      type: "note",
      title,
      body: summary,
      raw: summary,
      status: "open",
      priority: "low",
      tags: ["digest"],
      source: "system",
      embedding_v2: embedding,
      created_at: createdAt,
      valid_from: createdAt,
    })
    .select("id")
    .single();
  if (error || !item) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }

  try {
    const vault_path = await writeVaultNote({
      id: item.id,
      type: "note",
      title,
      body: summary,
      tags: ["digest"],
      priority: "low",
      source: "system",
      createdAt,
    });
    await admin.from("items").update({ vault_path }).eq("id", item.id);
  } catch {
    // best effort
  }

  await logAudit(admin, {
    user_id: owner.id,
    item_id: item.id,
    action: "consolidate",
    actor: "system",
    detail: { count: items.length },
  });

  await notifyTelegram(`🌙 *Daily digest*\n\n${summary}`);

  return NextResponse.json({ ok: true, count: items.length, digest_id: item.id });
}
