import { createAdminClient } from "@/lib/supabase/admin";
import { embed } from "@/lib/embed";
import { chat } from "@/lib/openrouter";
import { vaultUrl } from "@/lib/vault";
import { logLlmUsage } from "@/lib/usage";

type MatchRow = {
  id: string;
  title: string;
  type: string;
  body: string;
  vault_path: string | null;
  sensitive: boolean;
};

export type AskSource = {
  n: number;
  id: string;
  title: string;
  type: string;
  vault_path: string | null;
  vault_url: string | null;
};

export type AskResult = { answer: string; sources: AskSource[] };

// Shared Ask pipeline: embed the question -> semantic retrieval (owner-scoped,
// archived + superseded excluded via match_items) -> answer with inline citations.
// Sensitive items are retrievable but their body is withheld from the cloud model.
// Used by the /api/ask route and the Telegram webhook.
export async function answerQuestion(
  userId: string,
  question: string
): Promise<AskResult> {
  const q = (question ?? "").toString().trim();
  if (!q) return { answer: "Ask me something and I'll check your notes.", sources: [] };

  const admin = createAdminClient();
  const qEmbedding = await embed(q);
  const { data: matches, error } = await admin.rpc("match_items", {
    query_embedding: qEmbedding,
    match_count: 8,
    owner: userId,
  });
  if (error) throw new Error(`retrieval failed: ${error.message}`);

  const rows = (matches ?? []) as MatchRow[];
  const sources: AskSource[] = rows.map((m, i) => ({
    n: i + 1,
    id: m.id,
    title: m.title,
    type: m.type,
    vault_path: m.vault_path,
    vault_url: m.vault_path ? vaultUrl(m.vault_path) : null,
  }));

  if (rows.length === 0) {
    return { answer: "I don't have any notes about that yet.", sources: [] };
  }

  const context = rows
    .map((m, i) => {
      const body = m.sensitive ? "(sensitive note — body withheld)" : m.body;
      return `[${i + 1}] "${m.title}" (${m.type})\n${body}`;
    })
    .join("\n\n");

  const { content: answer, usage } = await chat(
    process.env.OPENROUTER_ANSWER_MODEL!,
    [
      {
        role: "system",
        content:
          "You are the user's second brain. Answer the question using ONLY the notes provided. " +
          "Cite the notes you use inline with their bracketed numbers like [1], [2]. " +
          "If the notes don't contain the answer, say so plainly. Be concise.",
      },
      { role: "user", content: `Notes:\n${context}\n\nQuestion: ${q}` },
    ],
    { temperature: 0.2 }
  );

  await logLlmUsage(admin, userId, "answer", usage);

  return { answer, sources };
}
