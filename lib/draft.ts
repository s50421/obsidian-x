import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/embed";
import { chat } from "@/lib/openrouter";
import { vaultUrl } from "@/lib/vault";
import { logLlmUsage } from "@/lib/usage";
import type { AskSource } from "@/lib/ask-core";

// v3.2 rung 2 — the agent DRAFTS work. Given a task/request, it pulls relevant
// context from the brain (same retrieval as Ask) and produces a ready-to-use
// deliverable — an email, message, outline, or short doc — for the owner to
// approve/edit. Proposal-only: it never sends anything.

type MatchRow = {
  id: string;
  title: string;
  type: string;
  body: string;
  status: string;
  vault_path: string | null;
  sensitive: boolean;
};

export type DraftResult = { draft: string; sources: AskSource[] };

export async function draftForTask(userId: string, task: string): Promise<DraftResult> {
  const t = (task ?? "").toString().trim();
  if (!t) return { draft: "Tell me what to draft — e.g. “email the accountant about Q3”.", sources: [] };

  const admin = createAdminClient();
  const qEmbedding = await embedText(t, userId);
  const { data: matches, error } = await admin.rpc("match_items_v2", {
    query_embedding: qEmbedding,
    query_text: t,
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

  const context = rows.length
    ? rows
        .map((m, i) => {
          const body = m.sensitive ? "(sensitive note — body withheld)" : m.body;
          const status = m.status && m.status !== "open" ? `, ${m.status}` : "";
          return `[${i + 1}] "${m.title}" (${m.type}${status})\n${body}`;
        })
        .join("\n\n")
    : "(no closely-related notes found)";

  const { content: draft, usage } = await chat(
    process.env.OPENROUTER_ANSWER_MODEL!,
    [
      {
        role: "system",
        content:
          "You are the owner's assistant. They asked you to draft or produce something. " +
          "Use the owner's own notes below for facts and context — do not invent facts that " +
          "contradict them. Produce a ready-to-use draft: pick the right form (email, text " +
          "message, outline, or short document) for the request. Write in the first person as " +
          "the owner where appropriate. Be complete and practical; for any detail you genuinely " +
          "don't have, use a clear [placeholder]. Output ONLY the draft itself — no preamble, no " +
          "commentary, no 'here is your draft'.",
      },
      { role: "user", content: `Owner's notes:\n${context}\n\nDraft this: ${t}` },
    ],
    { temperature: 0.4 }
  );

  await logLlmUsage(admin, userId, "draft", usage);
  return { draft: draft.trim(), sources };
}
