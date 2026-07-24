import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { embed } from "@/lib/embed";
import { chat } from "@/lib/openrouter";
import { logLlmUsage } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Msg = { role: "assistant" | "user"; content: string };

const SYSTEM =
  "You are a warm, sharp interviewer building a rich profile of the owner for their " +
  "personal 'second brain'. Ask ONE thoughtful question at a time, adapting to their " +
  "answers. Across the interview, cover: their work/role, current projects, goals & " +
  "ambitions, the important people in their life, values & principles, preferences & " +
  "tastes, health & routines, and what they want their second brain to help with. " +
  "Never repeat a question. Keep each question to 1–2 sentences, specific and easy to " +
  "answer. Output ONLY the next question.";

// v2 — AI interview. Each POST carries the transcript so far; if it ends with a
// user answer, that Q&A is captured as a searchable profile note (source
// "interview"), and the next adaptive question is returned.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let history: Msg[] = [];
  try {
    ({ history } = await req.json());
  } catch {
    // ignore
  }
  history = Array.isArray(history)
    ? history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    : [];

  const admin = createAdminClient();

  // Capture the last completed Q&A as a profile note.
  let saved = false;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last?.role === "user" && last.content.trim()) {
    const question = prev?.role === "assistant" ? prev.content : "";
    const answer = last.content.trim();
    try {
      const emb = await embed(answer);
      const now = new Date().toISOString();
      const title = answer.split(/\s+/).slice(0, 8).join(" ").slice(0, 60) || "Interview note";
      await admin.from("items").insert({
        user_id: user.id,
        type: "note",
        title,
        body: answer,
        raw: question ? `Q: ${question}\nA: ${answer}` : answer,
        status: "open",
        priority: "low",
        tags: ["interview", "profile"],
        source: "interview",
        embedding: emb,
        created_at: now,
        valid_from: now,
        confidence: 1,
        needs_review: false,
        entities: [],
      });
      saved = true;
    } catch {
      // best-effort capture
    }
  }

  const messages = [
    { role: "system" as const, content: SYSTEM },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (history.length === 0) {
    messages.push({ role: "user", content: "(Begin the interview with a warm opening question.)" });
  }

  const { content, usage } = await chat(process.env.OPENROUTER_ANSWER_MODEL!, messages, {
    temperature: 0.7,
  });
  await logLlmUsage(admin, user.id, "interview", usage);

  return NextResponse.json({ question: content.trim(), saved });
}
