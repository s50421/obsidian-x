-- Keep archived/merged items out of retrieval (Ask) and neighbor search.
-- Idempotent: replaces both functions in place.

create or replace function match_items(
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
    and status <> 'archived'
    and user_id = coalesce(owner, auth.uid())
  order by embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_neighbors(
  query_embedding vector(384),
  owner uuid,
  exclude_id uuid default null,
  match_count int default 6
) returns table (
  id uuid,
  title text,
  type text,
  vault_path text,
  similarity real
)
language sql stable
set search_path = public
as $$
  select
    i.id,
    i.title,
    i.type,
    i.vault_path,
    (1 - (i.embedding <=> query_embedding))::real as similarity
  from items i
  where i.embedding is not null
    and i.status <> 'archived'
    and i.user_id = owner
    and (exclude_id is null or i.id <> exclude_id)
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
