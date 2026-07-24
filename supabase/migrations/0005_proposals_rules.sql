-- Obsidian-X v1.5 (T2) — approval inbox foundation. Additive + idempotent.

-- 1. proposals: pending actions awaiting the owner's yes/no (the approval inbox).
--    e.g. an inbound email becomes a proposed ClickUp task; approving runs it,
--    rejecting archives it. Surfaced in /approvals AND via Telegram Yes/No.
create table if not exists proposals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind           text not null,                        -- clickup_task | ...
  status         text not null default 'pending',      -- pending | approved | rejected
  title          text,                                 -- short label for inbox / Telegram
  payload        jsonb not null default '{}'::jsonb,   -- action inputs (task name, list id, …)
  source         text,                                 -- email | telegram | feed | ...
  source_item_id uuid,                                 -- the item that generated it, if any
  result         jsonb,                                -- outcome after apply (e.g. {clickup_id,url})
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  constraint proposals_status_chk check (status in ('pending','approved','rejected'))
);
create index if not exists proposals_user_status_idx on proposals(user_id, status, created_at desc);
alter table proposals enable row level security;
drop policy if exists "proposals owner all" on proposals;
create policy "proposals owner all"
  on proposals for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. rules: the trust dial. Per (source, kind), auto-apply vs. ask, with an
--    optional confidence threshold for auto. Default posture is always "ask".
create table if not exists rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source     text,                                     -- email | telegram | feed | null (any)
  kind       text not null,                            -- clickup_task | ...
  mode       text not null default 'ask',              -- ask | auto
  threshold  numeric,                                  -- optional confidence gate for auto-apply
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  constraint rules_mode_chk check (mode in ('ask','auto'))
);
create index if not exists rules_user_idx on rules(user_id);
alter table rules enable row level security;
drop policy if exists "rules owner all" on rules;
create policy "rules owner all"
  on rules for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
