import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { findLinkedItem, syncItemFromClickUp } from "@/lib/clickup-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v2.2 — ClickUp → brain status sync-back (real-time, best-effort). ClickUp POSTs
// here on `taskStatusUpdated`; if the task is linked to a brain item
// (items.external), we mirror its completion/reopen. A daily reconcile cron
// (/api/cron/clickup-sync) is the reliable backstop. Public route (proxy.ts
// excludes api/), self-authenticated via ClickUp's HMAC signature.

const OK = NextResponse.json({ ok: true });

export async function POST(req: Request) {
  const raw = await req.text();

  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers.get("x-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
  }

  let body: { event?: string; task_id?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return OK;
  }
  if (body.event !== "taskStatusUpdated" || !body.task_id) return OK;

  const admin = createAdminClient();
  const item = await findLinkedItem(admin, body.task_id);
  if (item) await syncItemFromClickUp(admin, item, true);
  return OK;
}
