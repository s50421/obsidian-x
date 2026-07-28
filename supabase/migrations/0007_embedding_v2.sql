-- Obsidian-X v4.0 W1 — embedding upgrade + hybrid retrieval.
-- Additive + idempotent. Safe to re-run.
--
-- Replaces gte-small (384-dim, high similarity floor -> dup false-flags and link
-- noise) with OpenAI text-embedding-3-large truncated to 1024 dims, and adds
-- hybrid (vector + full-text) retrieval via Reciprocal Rank Fusion.
--
-- NOTE: the existing `match_items` / `match_neighbors` (vector(384) over
-- `items.embedding`) are deliberately LEFT IN PLACE — prod runs on them until
-- the v4.0 deploy. Nothing here drops or alters an existing column or function.

-- 1. The new vector column.
alter table items add column if not exists embedding_v2 vector(1024);

-- 2. HNSW index for cosine distance on the new column.
--    (mirrors items_embedding_idx, the hnsw index on the old 384-dim column)
create index if not exists items_embedding_v2_idx
  on items using hnsw (embedding_v2 vector_cosine_ops);

-- 3. Full-text side of the hybrid. `items.fts` and `items_fts_idx` ALREADY EXIST
--    on the live DB (see instructions/schema.sql) — the column has simply never
--    been used in retrieval. Both statements are therefore no-ops on live; they
--    are repeated here, with the identical generated-column expression, so this
--    migration also stands up a correct database from scratch.
alter table items add column if not exists fts tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) stored;

create index if not exists items_fts_idx on items using gin (fts);

-- 4. match_neighbors_v2 — pure vector neighbor search on embedding_v2.
--    Same shape and same filters as match_neighbors (archived excluded,
--    currently-valid rows only, owner-scoped); only the column and dimension
--    change. Used by capture-core for auto-link + duplicate flagging.
create or replace function match_neighbors_v2(
  query_embedding vector(1024),
  owner uuid,
  exclude_id uuid default null,
  match_count int default 6
) returns table (id uuid, title text, type text, vault_path text, similarity real)
language sql stable set search_path = public as $$
  select i.id, i.title, i.type, i.vault_path,
         (1 - (i.embedding_v2 <=> query_embedding))::real as similarity
  from items i
  where i.embedding_v2 is not null
    and i.status <> 'archived'
    and i.valid_to is null
    and i.user_id = owner
    and (exclude_id is null or i.id <> exclude_id)
  order by i.embedding_v2 <=> query_embedding
  limit match_count;
$$;

-- 5. match_items_v2 — HYBRID retrieval. Reciprocal Rank Fusion (k = 60) over
--    two independent rankings:
--      (a) cosine distance on embedding_v2  (semantic)
--      (b) ts_rank over items.fts using websearch_to_tsquery (lexical —
--          catches names, ids, and rare terms that vectors blur away)
--    RRF score = sum over arms of 1/(k + rank). Rank-based fusion needs no score
--    normalisation between the two very different scales, which is why it beats
--    weighted-sum here. Each arm is over-fetched (match_count * 4) so an item
--    that is mid-pack in both arms can still win on fused rank.
--    Filters are identical to match_items: not archived, valid_to is null,
--    owner-scoped. Returns `setof items`, same as match_items, so callers keep
--    the same row shape.
create or replace function match_items_v2(
  query_embedding vector(1024),
  query_text text default null,
  match_count int default 8,
  owner uuid default null
) returns setof items
language sql stable set search_path = public as $$
  with q as (
    select case
             when query_text is null or btrim(query_text) = '' then null
             else websearch_to_tsquery('english', query_text)
           end as tsq
  ),
  -- Each arm is ranked inside a subquery that is already LIMITed, so the
  -- window function runs over a handful of rows and the HNSW / GIN indexes
  -- still drive the scan.
  vec as (
    select v.id, row_number() over (order by v.dist) as rank
    from (
      select i.id, (i.embedding_v2 <=> query_embedding) as dist
      from items i
      where i.embedding_v2 is not null
        and i.status <> 'archived'
        and i.valid_to is null
        and i.user_id = coalesce(owner, auth.uid())
      order by i.embedding_v2 <=> query_embedding
      limit greatest(match_count * 4, 20)
    ) v
  ),
  txt as (
    select t.id, row_number() over (order by t.score desc) as rank
    from (
      select i.id, ts_rank(i.fts, q.tsq) as score
      from items i, q
      where q.tsq is not null
        and i.fts is not null
        and i.fts @@ q.tsq
        and i.status <> 'archived'
        and i.valid_to is null
        and i.user_id = coalesce(owner, auth.uid())
      order by ts_rank(i.fts, q.tsq) desc
      limit greatest(match_count * 4, 20)
    ) t
  ),
  fused as (
    select id, sum(score) as score
    from (
      select id, 1.0 / (60 + rank) as score from vec
      union all
      select id, 1.0 / (60 + rank) as score from txt
    ) s
    group by id
  )
  select i.*
  from fused f
  join items i on i.id = f.id
  order by f.score desc, i.created_at desc
  limit match_count;
$$;
