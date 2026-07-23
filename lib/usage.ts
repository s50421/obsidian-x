import type { SupabaseClient } from "@supabase/supabase-js";
import type { Usage } from "@/lib/openrouter";

// Record one LLM call's tokens + cost. Never break the main flow.
export async function logLlmUsage(
  admin: SupabaseClient,
  userId: string,
  operation: string,
  usage: Usage
): Promise<void> {
  try {
    await admin.from("llm_usage").insert({
      user_id: userId,
      operation,
      model: usage.model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cost_usd: usage.cost_usd,
    });
  } catch {
    // swallow
  }
}
