import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { sendMessage } from "@/lib/telegram";
import { notifyOwner } from "@/lib/conversation";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";
import { detectFollowups } from "@/lib/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v3.2 rung 1 — "you said you'd…" follow-ups. A daily agent pass that finds
// unfulfilled commitments in the owner's recent notes and nudges via Telegram.
// Vercel Cron (daily) or a manual authorized call. `?dry=1` detects + previews
// the message WITHOUT sending or recording (safe testing).
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

  const { followups, usage } = await detectFollowups(admin, uid);

  const lines = followups
    .map((f) => `• ${f.commitment}${f.action ? `\n   ↳ ${f.action}` : ""}`)
    .join("\n\n");
  const message = followups.length
    ? `👋 A few things you said you'd do:\n\n${lines}\n\nReply to knock any out — or ignore this.`
    : "";

  if (!dry) {
    if (usage) await logLlmUsage(admin, uid, "followups", usage);
    if (followups.length) {
      await notifyOwner(admin, owner.id, message);
      for (const f of followups) {
        await logAudit(admin, {
          user_id: uid,
          item_id: f.itemId,
          action: "followup_surfaced",
          actor: "system",
          detail: { commitment: f.commitment },
        });
      }
    }
  }

  return NextResponse.json({ ok: true, dry, count: followups.length, followups, message });
}
