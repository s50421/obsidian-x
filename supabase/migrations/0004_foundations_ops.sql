-- Obsidian-X v1.3 — foundations & ops. Additive + idempotent.

-- 1. items: privacy flag + bi-temporal supersession pointer
alter table items add column if not exists sensitive boolean not null default false;
alter table items add column if not exists superseded_by uuid;

-- 2. audit trail — every automated change
create table if not exists audit (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id    uuid,
  action     text not null,                       -- capture | email_capture | review_* | supersede | ...
  actor      text not null default 'system',      -- user | system | email | worker
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_user_created_idx on audit(user_id, created_at desc);
create index if not exists audit_item_idx on audit(item_id);
alter table audit enable row level security;
drop policy if exists "audit owner read" on audit;
create policy "audit owner read" on audit for select to authenticated using (auth.uid() = user_id);

-- 3. LLM usage / cost
create table if not exists llm_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  operation         text not null,                 -- classify | enrich | answer
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  total_tokens      int,
  cost_usd          numeric,
  created_at        timestamptz not null default now()
);
create index if not exists llm_usage_user_created_idx on llm_usage(user_id, created_at desc);
alter table llm_usage enable row level security;
drop policy if exists "llm owner read" on llm_usage;
create policy "llm owner read" on llm_usage for select to authenticated using (auth.uid() = user_id);

-- 4. Retrieval respects bi-temporal validity (currently-valid rows only),
--    on top of the existing archived-exclusion.
create or replace function match_items(
  query_embedding vector(384),
  match_count int default 8,
  owner uuid default null
) returns setof items language sql stable set search_path = public as $$
  select * from items
  where embedding is not null
    and status <> 'archived'
    and valid_to is null
    and user_id = coalesce(owner, auth.uid())
  order by embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_neighbors(
  query_embedding vector(384),
  owner uuid,
  exclude_id uuid default null,
  match_count int default 6
) returns table (id uuid, title text, type text, vault_path text, similarity real)
language sql stable set search_path = public as $$
  select i.id, i.title, i.type, i.vault_path,
         (1 - (i.embedding <=> query_embedding))::real as similarity
  from items i
  where i.embedding is not null
    and i.status <> 'archived'
    and i.valid_to is null
    and i.user_id = owner
    and (exclude_id is null or i.id <> exclude_id)
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
