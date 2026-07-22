-- Obsidian-X v1.2 — capture hardening.
-- Additive + idempotent. Safe to re-run.

alter table items add column if not exists raw text;
alter table items add column if not exists due_at timestamptz;
alter table items add column if not exists confidence real;
alter table items add column if not exists needs_review boolean not null default false;
alter table items add column if not exists review_reason text;
alter table items add column if not exists entities jsonb not null default '[]'::jsonb;
alter table items add column if not exists dup_candidate uuid;

create index if not exists items_needs_review_idx
  on items (user_id) where needs_review;

-- Neighbor search that returns cosine similarity (0..1) so the server can
-- auto-link (loose threshold) and flag duplicates (tight threshold).
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
    and i.user_id = owner
    and (exclude_id is null or i.id <> exclude_id)
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
