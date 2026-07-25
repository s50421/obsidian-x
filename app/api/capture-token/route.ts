import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v2.1 — token-authed capture for an iOS Shortcut (trigger via Siri / Action
// Button / Back Tap / Share Sheet). Public route (proxy.ts excludes api/);
// self-authenticates with SHORTCUT_TOKEN via `Authorization: Bearer <token>` or
// `?token=`. Runs the normal capture pipeline (source "shortcut").
export async function POST(req: Request) {
  const secret = process.env.SHORTCUT_TOKEN;
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const token = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("token") || "";
  if (!secret || token !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  // Accept JSON {text|note} or a raw text body.
  let text = "";
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      const b = (await req.json()) as Record<string, unknown>;
      text = String(b.text ?? b.note ?? b.q ?? "");
    } else {
      text = await req.text();
    }
  } catch {
    // ignore
  }
  text = text.trim();
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  try {
    const outcome = await captureText(owner.id, text, "shortcut");
    return NextResponse.json({
      ok: true,
      created: outcome.created.length,
      titles: outcome.created.map((c) => c.item.title),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
