-- Obsidian-X v1.1 — RLS + vector search.
-- The `items` table and the vector(384) column already exist (created earlier,
-- adjusted in Part A). This migration is idempotent and safe to re-run.

-- 1. Lock every row to its owner.
alter table items enable row level security;

drop policy if exists "owner can do everything" on items;
create policy "owner can do everything"
  on items for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. Vector similarity search.
--    Server routes call this with `owner` explicitly (they use the service_role
--    key, where auth.uid() is null). An authenticated client may omit `owner`.
drop function if exists match_items(vector, int);
drop function if exists match_items(vector, int, uuid);

create function match_items(
  query_embedding vector(384),
  match_count int default 8,
  owner uuid default null
) returns setof items
language sql stable
set search_path = public
as $$
  select *
  from items
  where embedding is not null
    and user_id = coalesce(owner, auth.uid())
  order by embedding <=> query_embedding
  limit match_count;
$$;
