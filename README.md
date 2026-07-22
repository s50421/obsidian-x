# Obsidian-X — v1.1 (walking skeleton)

Personal second brain. **Supabase Postgres is the single source of truth**; the
Obsidian vault (a private GitHub repo) is a human-readable projection.

The v1.1 loop: type a note → an LLM classifies it → it's stored with an
embedding → a markdown file is written to the vault → ask a question → get an
answer that **cites** the source note(s).

## Stack

- **Next.js 16** (App Router) PWA + **Tailwind v4**
- **Supabase** — Postgres + pgvector, Auth (magic link), Edge Function for embeddings
- **OpenRouter** — the only model provider (classify + answer)
- **GitHub API** (Octokit) — writes the vault
- Deploy target: **Vercel**

Embeddings use the Supabase Edge Function `embed` (built-in `gte-small`, 384-dim)
so there's no paid embedding key.

## Setup

1. Copy `.env.example` → `.env.local` and fill every value. Set `OWNER_EMAIL`
   to the single allowed account.
2. Apply the DB migration: paste `supabase/migrations/0001_rls_and_match.sql`
   into the Supabase SQL editor and run it.
3. Deploy the embeddings function:
   ```bash
   supabase functions deploy embed --project-ref <your-ref>
   ```
4. Create the owner user + run health checks:
   ```bash
   npm run setup
   ```
5. (Optional) generate PWA icons and run the end-to-end smoke test:
   ```bash
   npm run icons
   npm run smoke
   ```

## Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
```

## Layout

```
app/
  page.tsx              main app (Capture + Ask), owner-gated
  login/                magic-link sign-in
  auth/callback         code/token exchange + owner gate
  auth/signout
  api/capture           classify -> embed -> store -> vault write
  api/ask               embed -> match_items -> answer with citations
lib/
  supabase/{server,browser,admin,middleware}.ts
  openrouter.ts  embed.ts  vault.ts  classify.ts  owner.ts
supabase/
  functions/embed       Deno edge function (gte-small)
  migrations/           RLS + match_items
scripts/                setup.mjs, smoke.mjs, gen-icons.mjs
```

Out of scope for v1.1 (later rungs): voice/email/photo capture, offline queue,
dedup, feeds, ClickUp, approvals, nightly agents, synthesis, graph viz.
