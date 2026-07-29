import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";
import { clickupConfigured } from "@/lib/clickup";
import { proposeClickUpTaskForItem, notifyClickUpProposal } from "@/lib/proposals";
import { reportSourceStatus } from "@/lib/source-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Webhook for the "forward-to-brain" email address. An inbound-email provider
// (Cloudflare Email Routing worker, Postmark, Mailgun, …) POSTs the parsed mail
// here. Secured by a shared secret AND by requiring the sender to be the owner.

function extractEmail(v: string): string {
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().toLowerCase();
}

// Pull { from, subject, text } out of whatever shape the provider sends.
function readFields(
  body: Record<string, unknown>
): { from: string; subject: string; text: string } {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const val = body[k];
      if (typeof val === "string" && val.trim()) return val;
    }
    return "";
  };
  return {
    from: extractEmail(pick("from", "From", "sender", "Sender")),
    subject: pick("subject", "Subject"),
    text: pick("text", "TextBody", "body-plain", "stripped-text", "plain"),
  };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret || token !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  // Accept JSON or form-encoded payloads.
  let body: Record<string, unknown> = {};
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      body = (await req.json()) as Record<string, unknown>;
    } else {
      const form = await req.formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    }
  } catch {
    return NextResponse.json({ error: "unparseable body" }, { status: 400 });
  }

  const { from, subject, text } = readFields(body);

  // Only accept mail actually sent by the owner.
  if (!from || from !== ownerEmail()) {
    return NextResponse.json({ error: "sender not allowed" }, { status: 403 });
  }

  const composed = [subject, text].map((s) => s.trim()).filter(Boolean).join("\n\n");
  if (!composed) {
    return NextResponse.json({ error: "empty email" }, { status: 400 });
  }

  // Resolve the owner's user id.
  const admin = createAdminClient();
  const { data: list, error: le } = await admin.auth.admin.listUsers();
  if (le) return NextResponse.json({ error: le.message }, { status: 500 });
  const owner = list.users.find(
    (u) => (u.email ?? "").toLowerCase() === ownerEmail()
  );
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });

  try {
    const outcome = await captureText(owner.id, composed, "email");

    // v4.1 — the forward-to-brain channel just proved it works.
    void reportSourceStatus(admin, owner.id, {
      source: "email",
      label: "Forward-to-brain",
      connected: true,
      error: null,
    });

    // T4: an actionable email (a task) becomes a proposed ClickUp task the owner
    // approves in Telegram — alongside the note, which stays in the brain.
    let proposed = 0;
    if (clickupConfigured()) {
      for (const c of outcome.created) {
        if (c.item.type !== "task") continue;
        const p = await proposeClickUpTaskForItem(admin, owner.id, c.item.id, "email");
        if (p) {
          await notifyClickUpProposal(p);
          proposed++;
        }
      }
    }

    return NextResponse.json({ ok: true, created: outcome.created.length, proposed });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
