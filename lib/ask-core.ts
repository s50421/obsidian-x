import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/embed";
import { chat } from "@/lib/openrouter";
import { vaultUrl } from "@/lib/vault";
import { logLlmUsage } from "@/lib/usage";

type MatchRow = {
  id: string;
  title: string;
  type: string;
  body: string;
  status: string;
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

// Shared Ask pipeline: embed the question -> HYBRID retrieval (owner-scoped,
// archived + superseded excluded via match_items_v2 — RRF over embedding_v2
// cosine + full-text on items.fts) -> answer with inline citations.
// Sensitive items are retrievable but their body is withheld from the cloud model.
// Used by the /api/ask route and the Telegram webhook.
export async function answerQuestion(
  userId: string,
  question: string
): Promise<AskResult> {
  const q = (question ?? "").toString().trim();
  if (!q) return { answer: "Ask me something and I'll check your notes.", sources: [] };

  const admin = createAdminClient();
  const qEmbedding = await embedText(q, userId);
  // The raw question is the lexical arm's input — websearch_to_tsquery drops
  // stop words itself, so no pre-cleaning is wanted here.
  const { data: matches, error } = await admin.rpc("match_items_v2", {
    query_embedding: qEmbedding,
    query_text: q,
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
      // Surface status so the model treats completed items as done, not to-do.
      const status = m.status && m.status !== "open" ? `, ${m.status}` : "";
      return `[${i + 1}] "${m.title}" (${m.type}${status})\n${body}`;
    })
    .join("\n\n");

  const { content: answer, usage } = await chat(
    process.env.OPENROUTER_ANSWER_MODEL!,
    [
      {
        role: "system",
        content:
          "You are the user's second brain. Answer the question using ONLY the notes provided. " +
          "Each note shows its status in parentheses; a note marked 'done' is already " +
          "completed — never list it as something still to do or outstanding. " +
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
