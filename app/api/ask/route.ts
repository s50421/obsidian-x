import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { embed } from "@/lib/embed";
import { chat } from "@/lib/openrouter";
import { vaultUrl } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchRow = {
  id: string;
  title: string;
  type: string;
  body: string;
  vault_path: string | null;
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let question = "";
  try {
    ({ question } = await req.json());
  } catch {
    // ignore
  }
  question = (question ?? "").toString().trim();
  if (!question) {
    return NextResponse.json({ error: "empty question" }, { status: 400 });
  }

  const admin = createAdminClient();

  const qEmbedding = await embed(question);
  const { data: matches, error } = await admin.rpc("match_items", {
    query_embedding: qEmbedding,
    match_count: 8,
    owner: user.id,
  });
  if (error) {
    return NextResponse.json(
      { error: `retrieval failed: ${error.message}` },
      { status: 500 }
    );
  }

  const rows = (matches ?? []) as MatchRow[];
  const sources = rows.map((m, i) => ({
    n: i + 1,
    id: m.id,
    title: m.title,
    type: m.type,
    vault_path: m.vault_path,
    vault_url: m.vault_path ? vaultUrl(m.vault_path) : null,
  }));

  if (rows.length === 0) {
    return NextResponse.json({
      answer: "I don't have any notes about that yet.",
      sources: [],
    });
  }

  const context = rows
    .map((m, i) => `[${i + 1}] "${m.title}" (${m.type})\n${m.body}`)
    .join("\n\n");

  const answer = await chat(
    process.env.OPENROUTER_ANSWER_MODEL!,
    [
      {
        role: "system",
        content:
          "You are the user's second brain. Answer the question using ONLY the notes provided. " +
          "Cite the notes you use inline with their bracketed numbers like [1], [2]. " +
          "If the notes don't contain the answer, say so plainly. Be concise.",
      },
      { role: "user", content: `Notes:\n${context}\n\nQuestion: ${question}` },
    ],
    { temperature: 0.2 }
  );

  return NextResponse.json({ answer, sources });
}
