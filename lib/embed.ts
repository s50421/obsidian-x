// Generate a 384-dim embedding via the Supabase Edge Function (`embed`),
// which runs the built-in `gte-small` model. No paid embedding key needed.

export async function embed(input: string): Promise<number[]> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/embed`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embed edge function ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  const embedding = data?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 384) {
    throw new Error(
      `embed returned unexpected shape (len=${
        Array.isArray(embedding) ? embedding.length : "n/a"
      })`
    );
  }
  return embedding as number[];
}
