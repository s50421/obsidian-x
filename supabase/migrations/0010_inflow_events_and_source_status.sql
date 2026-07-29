-- Obsidian-X v4.1 — complete inflows + the coverage panel.
-- Additive + idempotent. Safe to re-run.
--
-- Two new tables, both owner-scoped with the same RLS pattern as `settings`
-- (migration 0008):
--
--   inflow_events  — the ledger of everything that ARRIVED, from every source.
--                    Design rule from the brief: "mail is INFLOW, not memory."
--                    An email is an inflow event; it becomes an `items` row
--                    only if the ranker scores it above the auto-create bar.
--                    Full message text is fetched on demand via `raw_ref`,
--                    never hoarded here.
--
--   source_status  — one row per declared source. This is the trust surface
--                    behind the completeness law: a source is fully in or
--                    explicitly out, and the coverage panel + brief footer read
--                    straight off this table. A source that stops syncing shows
--                    ⚠ rather than silently vanishing from the brief.

-- ---------------------------------------------------------------------------
-- 1. inflow_events
-- ---------------------------------------------------------------------------
create table if not exists inflow_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- 'gmail' | 'granola' | 'calendar' | 'telegram' | ...  (matches source_status.source)
  source        text not null,
  -- Stable per-source id (Gmail message id, Granola meeting id). The unique
  -- index below is what makes every sync idempotent.
  external_id   text not null,
  -- Account/mailbox this arrived in. Multi-mailbox from day one even though
  -- only one Gmail account is connected at launch (owner decision 2026-07-29).
  account       text,

  ts            timestamptz not null default now(),   -- when it arrived at the source
  sender        text,                                  -- From: display + address
  participants  jsonb not null default '[]'::jsonb,    -- [{name, email, role: to|cc|from}]
  subject       text,
  snippet       text,                                  -- short preview ONLY, never full body
  raw_ref       jsonb not null default '{}'::jsonb,    -- {messageId, threadId, historyId, ...} → fetch on demand

  -- Ranking (see lib/rank-mail.ts). ranked_score is 0..100.
  ranked_score  smallint,
  ranked_reason jsonb not null default '{}'::jsonb,    -- {signals:[...], vip:bool, bulk:bool, confidence:number}

  -- new       = ingested, not yet acted on
  -- surfaced  = shown to the owner (brief / ops)
  -- actioned  = became an item (item_id set) or was otherwise handled
  -- dismissed = explicitly rejected / swiped away
  state         text not null default 'new'
                check (state in ('new','surfaced','actioned','dismissed')),
  item_id       uuid references items(id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Idempotent sync: the same message can be seen many times (History API replays,
-- overlapping backfill windows) and must never duplicate.
create unique index if not exists inflow_events_source_ext_idx
  on inflow_events(user_id, source, external_id);
create index if not exists inflow_events_user_ts_idx    on inflow_events(user_id, ts desc);
create index if not exists inflow_events_state_idx      on inflow_events(user_id, state);
create index if not exists inflow_events_score_idx      on inflow_events(user_id, ranked_score desc);
create index if not exists inflow_events_source_idx     on inflow_events(user_id, source);

drop trigger if exists inflow_events_updated_at on inflow_events;
create trigger inflow_events_updated_at before update on inflow_events
  for each row execute function set_updated_at();

alter table inflow_events enable row level security;
drop policy if exists "inflow owner all" on inflow_events;
create policy "inflow owner all"
  on inflow_events for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. source_status
-- ---------------------------------------------------------------------------
create table if not exists source_status (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- 'gmail' | 'calendar' | 'telegram' | 'granola' | 'imessage' | 'whatsapp' | ...
  source        text not null,
  -- Optional sub-source: one row per mailbox, per calendar feed. NULL = the
  -- source as a whole. '' rather than NULL in the PK so upserts are simple.
  channel       text not null default '',

  label         text,                                   -- display name for the panel
  -- declared: in scope and expected to work (counts toward the coverage KPI)
  -- out:      explicitly not connected, phase 2 (shown as ✗, never silently missing)
  scope         text not null default 'declared'
                check (scope in ('declared','out')),
  connected     boolean not null default false,
  last_sync     timestamptz,
  last_ok       timestamptz,                            -- last sync with no error
  events_24h    integer not null default 0,
  last_error    text,
  detail        jsonb not null default '{}'::jsonb,     -- per-source extras (historyId, counts…)

  updated_at    timestamptz not null default now(),
  primary key (user_id, source, channel)
);
create index if not exists source_status_user_idx on source_status(user_id);

drop trigger if exists source_status_updated_at on source_status;
create trigger source_status_updated_at before update on source_status
  for each row execute function set_updated_at();

alter table source_status enable row level security;
drop policy if exists "source_status owner all" on source_status;
create policy "source_status owner all"
  on source_status for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
