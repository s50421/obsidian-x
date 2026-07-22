// Supabase Edge Function: turns text into a 384-dim embedding using the
// built-in `gte-small` model. No paid embedding key required.
//
// Deploy with:  supabase functions deploy embed --project-ref <your-ref>
// Invoke with:  POST /functions/v1/embed  { "input": "some text" }
//
// Note: `Supabase` and `Deno` are globals in the Supabase Edge runtime; this
// file is intentionally excluded from the Next.js TypeScript project.

// @ts-nocheck
const model = new Supabase.ai.Session("gte-small");

Deno.serve(async (req: Request) => {
  try {
    const { input } = await req.json();
    if (!input || typeof input !== "string") {
      return new Response(
        JSON.stringify({ error: "input (string) is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const embedding = await model.run(input, {
      mean_pool: true,
      normalize: true,
    });

    return new Response(JSON.stringify({ embedding }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
