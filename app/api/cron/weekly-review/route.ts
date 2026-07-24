import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerEmail } from "@/lib/owner";
import { isCronAuthorized } from "@/lib/cron";
import { sendMessage } from "@/lib/telegram";
import { chat } from "@/lib/openrouter";
import { logAudit } from "@/lib/audit";
import { logLlmUsage } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = process.env.BRIEF_TZ || "America/Los_Angeles";

// v2.3 — weekly review. A Sunday-evening digest of the week's captures,
// completions, and what's ahead → Telegram. Triggered by Vercel Cron (weekly)
// or a manual authorized call.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: list, error } = await admin.auth.admin.listUsers();
  if (error || !list) return NextResponse.json({ error: "no users" }, { status: 500 });
  const owner = list.users.find((u) => (u.email ?? "").toLowerCase() === ownerEmail());
  if (!owner) return NextResponse.json({ error: "owner not found" }, { status: 500 });
  const uid = owner.id;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
  const in7 = new Date(now.getTime() + 7 * 86400 * 1000).toISOString();

  // captures this week (exclude the archived apple-notes import)
  const { data: created } = await admin
    .from("items")
    .select("title,type")
    .eq("user_id", uid)
    .neq("source", "apple-notes")
    .gte("created_at", weekAgo);
  const captures = created ?? [];
  const byType: Record<string, number> = {};
  for (const c of captures) byType[c.type] = (byType[c.type] ?? 0) + 1;

  // completions + ClickUp tasks this week (from the audit trail)
  const { data: audit } = await admin
    .from("audit")
    .select("action")
    .eq("user_id", uid)
    .gte("created_at", weekAgo);
  const acts = audit ?? [];
  const completed = acts.filter((a) => a.action === "mark_done").length;
  const clickup = acts.filter((a) => a.action === "clickup_task_created").length;

  // still-open tasks + what's due in the next 7 days
  const { count: openTasks } = await admin
    .from("items")
    .select("*", { count: "exact", head: true })
    .eq("user_id", uid)
    .eq("status", "open")
    .eq("type", "task")
    .neq("source", "apple-notes")
    .is("valid_to", null);
  const { data: dueSoon } = await admin
    .from("items")
    .select("title,due_at")
    .eq("user_id", uid)
    .eq("status", "open")
    .is("valid_to", null)
    .not("due_at", "is", null)
    .gte("due_at", now.toISOString())
    .lte("due_at", in7)
    .order("due_at");
  const due = dueSoon ?? [];

  // a light one-line theme summary of the week's captures (cheap model)
  let theme = "";
  if (captures.length >= 3) {
    try {
      const { content, usage } = await chat(
        process.env.OPENROUTER_CLASSIFY_MODEL!,
        [
          { role: "system", content: "In ONE short sentence, summarise the themes of this week's notes for the owner. No preamble." },
          { role: "user", content: captures.map((c) => `- ${c.title} (${c.type})`).join("\n") },
        ],
        { temperature: 0.3 }
      );
      theme = content.trim();
      await logLlmUsage(admin, uid, "weekly_review", usage);
    } catch {
      // best-effort
    }
  }

  const range = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  const typeLine = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(", ") || "—";
  const dueText = due.length
    ? due.map((d) => `• ${d.title}${d.due_at ? ` (due ${d.due_at.slice(0, 10)})` : ""}`).join("\n")
    : "_nothing due_";

  const msg =
    `📅 *Weekly review — ${range.format(new Date(weekAgo))}–${range.format(now)}*\n\n` +
    `*Captured:* ${captures.length}${captures.length ? ` (${typeLine})` : ""}\n` +
    `*Completed:* ${completed}${clickup ? ` · ${clickup} → ClickUp` : ""}\n` +
    `*Open tasks:* ${openTasks ?? 0}\n\n` +
    (theme ? `_${theme}_\n\n` : "") +
    `*Due next 7 days (${due.length}):*\n${dueText}`;

  await sendMessage(msg);
  await logAudit(admin, {
    user_id: uid,
    action: "weekly_review",
    actor: "system",
    detail: { captured: captures.length, completed, open_tasks: openTasks ?? 0, due: due.length },
  });

  return NextResponse.json({ ok: true, captured: captures.length, completed, due: due.length });
}
