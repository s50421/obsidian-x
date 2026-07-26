import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { sendMessage } from "@/lib/telegram";
import { logAudit } from "@/lib/audit";
import { pickResurface } from "@/lib/resurface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v3.3 — spaced resurfacing. Brings a few older notes back via Telegram so
// insights stay alive. Vercel Cron (twice weekly) or a manual authorized call.
// `?dry=1` picks + previews without sending or recording.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });
  const uid = owner.id;

  const picks = await pickResurface(admin, uid, 3);

  const lines = picks.map((p) => `• ${p.title}${p.snippet ? ` — ${p.snippet}` : ""}`).join("\n\n");
  const message = picks.length ? `💡 From your brain — worth a fresh look:\n\n${lines}` : "";

  if (!dry && picks.length) {
    await sendMessage(message, { parse_mode: "plain" });
    for (const p of picks) {
      await logAudit(admin, {
        user_id: uid,
        item_id: p.id,
        action: "resurfaced",
        actor: "system",
        detail: { title: p.title },
      });
    }
  }

  return NextResponse.json({ ok: true, dry, count: picks.length, picks, message });
}
