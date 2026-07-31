-- Obsidian-X v4.2.1 — conversational memory for the Telegram bot.
-- Additive + idempotent. Safe to re-run.
--
-- Why: the bot handled every message as an isolated event, so a perfectly
-- normal follow-up died. Observed 2026-07-30:
--
--   owner: "Canvas to-dos: - instage phone call - resume"
--   bot:   "Save this?"  [Save] [Discard]
--   owner: "Save them as two separate things"
--   bot:   "I need more context to understand what you'd like me to save."
--
-- "them" was one message earlier. Any human would have followed it. This table
-- is the short-term memory that makes the bot a conversation rather than a
-- sequence of unrelated commands.
--
-- Deliberately SHORT-TERM and separate from `items`: this is dialogue, not
-- memory-worthy content. The brain still only holds what the owner actually
-- captures. Old turns are pruned rather than kept forever.

create table if not exists conversation (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- 'user' = the owner spoke; 'assistant' = the bot replied.
  role       text not null check (role in ('user','assistant')),
  text       text not null,
  -- Free-form: the resolved intent, a proposal id the turn relates to, whether
  -- it arrived as voice, etc. Lets a follow-up reattach to what was pending.
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- The only access pattern: "the last N turns for this owner, newest first".
create index if not exists conversation_user_time_idx
  on conversation(user_id, created_at desc);

alter table conversation enable row level security;
drop policy if exists "conversation owner all" on conversation;
create policy "conversation owner all"
  on conversation for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
