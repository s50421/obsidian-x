-- Obsidian-X — canonical entities + typed edges (brain-quality brief, Phase 2).
-- Additive + idempotent. Safe to re-run.
--
-- WHY, measured rather than assumed. The owner said "the connections seem very
-- loose and random". An audit of the live brain on 2026-08-02 found 13 links in
-- total:
--
--   12  "these four came from the same braindump" — one Telegram message split
--       into four items on 2026-07-30, each part linked to its siblings.
--       PROVENANCE, presented in the UI as if it were meaning.
--    1  a leftover gte-small similarity link pairing "Dani works at V-bank via
--       Manhart" with "Beate Manhart emails — father lawsuit review", made in an
--       embedding space the system abandoned in v4.0 W1.
--    0  actual current-space similarity.
--
-- So the complaint was not a threshold-tuning problem. A "connection" had no
-- defined meaning, no type, and no reason a human could read. These two tables
-- give it all three.
--
-- Workshop decisions encoded here (owner, 2026-08-02):
--   * Edge kinds that count: shared person/org/place, shared topic tag,
--     embedding similarity. Thread/braindump provenance was explicitly NOT
--     chosen, so those 12 links are purged rather than relabelled.
--   * Entity merging: obvious matches (exact/alias/case) merge automatically;
--     judgement calls become proposals. Never silent for the ambiguous ones.
--   * Self/system entities ("David Michael Manhart", "Obsidian-X") stay recorded
--     but never derive edges — the owner appears in nearly everything, so
--     "shared person: David" would collapse the graph into one hairball. That is
--     what `edge_eligible` is for.

-- ---------------------------------------------------------------------------
-- entities — one row per real-world thing, however many ways it gets written.
-- ---------------------------------------------------------------------------
create table if not exists entities (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- Canonical display form. "V-Bank", not "v-bank"/"V-bank".
  name        text not null,
  kind        text not null default 'other'
              check (kind in ('person','org','place','other')),

  -- Every other string that means this entity: "mum" -> Beate Manhart.
  -- Matched case-insensitively by the resolver.
  aliases     text[] not null default '{}',

  -- False for the owner himself and for the system. Still recorded (the data is
  -- true and Ask can use it), but excluded from edge derivation. See the header.
  edge_eligible boolean not null default true,

  -- Set when an LLM proposed this entity or a merge into it and the owner has
  -- not yet ruled. Surfaced in the deck; never blocks resolution.
  needs_review  boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One canonical entity per (owner, name, kind), case-insensitively. This is the
-- constraint that makes "resolve or create" safe to run concurrently from the
-- capture path — without it, two captures naming "Dani" in the same second
-- would create two canon rows and quietly split the entity in half.
create unique index if not exists entities_user_name_kind_idx
  on entities(user_id, lower(name), kind);
create index if not exists entities_user_kind_idx on entities(user_id, kind);
-- Alias lookup is the resolver's hot path.
create index if not exists entities_aliases_idx on entities using gin (aliases);

alter table entities enable row level security;
drop policy if exists "entities owner all" on entities;
create policy "entities owner all"
  on entities for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- item_entities — which items mention which entity.
-- ---------------------------------------------------------------------------
create table if not exists item_entities (
  item_id    uuid not null references items(id) on delete cascade,
  entity_id  uuid not null references entities(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- The string as it actually appeared on the item ("mum"), kept even after the
  -- merge into "Beate Manhart". Without it a merge is unexplainable and
  -- unreviewable, and the edge reason would have to say "both mention Beate
  -- Manhart" about an item that never used those words.
  raw_name   text,

  created_at timestamptz not null default now(),
  primary key (item_id, entity_id)
);

create index if not exists item_entities_entity_idx on item_entities(entity_id);
create index if not exists item_entities_user_idx   on item_entities(user_id);

alter table item_entities enable row level security;
drop policy if exists "item_entities owner all" on item_entities;
create policy "item_entities owner all"
  on item_entities for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- edges — typed, explainable connections between items.
-- ---------------------------------------------------------------------------
create table if not exists edges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- Undirected in meaning. Callers MUST store the lexicographically smaller id
  -- in src, so (a,b) and (b,a) collide on the unique index below instead of
  -- producing two rows that render as two identical connections.
  src        uuid not null references items(id) on delete cascade,
  dst        uuid not null references items(id) on delete cascade,

  kind       text not null
             check (kind in ('shared_person','shared_org','shared_place',
                             'shared_topic','reference','thread','similar')),

  -- Human-readable, and NOT optional. The brief's exit test is "the owner can
  -- tap any connection anywhere and see WHY it exists in plain words", so an
  -- edge that cannot explain itself must not be storable in the first place.
  reason     text not null,

  weight     real not null default 1,

  -- Which entity produced this edge, when one did. Lets a merge or a correction
  -- re-derive precisely the edges it affects instead of rebuilding everything.
  entity_id  uuid references entities(id) on delete cascade,

  -- 'similar' edges are guesses, not facts. Marked so the UI can present them
  -- differently and so a future purge can find them without pattern-matching.
  discovery  boolean not null default false,

  created_at timestamptz not null default now(),

  constraint edges_no_self_loop check (src <> dst)
);

-- An entity-derived edge is unique per entity; a topic/similarity edge has no
-- entity, and coalesce keeps those from colliding with each other on NULL
-- (in Postgres, NULL <> NULL, so a plain unique index would allow duplicates).
create unique index if not exists edges_unique_idx
  on edges(user_id, src, dst, kind, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists edges_src_idx    on edges(user_id, src);
create index if not exists edges_dst_idx    on edges(user_id, dst);
create index if not exists edges_kind_idx   on edges(user_id, kind);
create index if not exists edges_entity_idx on edges(entity_id);

alter table edges enable row level security;
drop policy if exists "edges owner all" on edges;
create policy "edges owner all"
  on edges for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
