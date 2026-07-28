-- Obsidian-X v4.0 (W4) — per-owner key/value settings.
-- Additive + idempotent. First consumer: 'tz_override' (Telegram /tz command),
-- read by lib/tz.ts to resolve the owner's timezone for 6:30am-local letter
-- delivery. Same RLS/ownership pattern as `rules` (migration 0005).

create table if not exists settings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists settings_user_idx on settings(user_id);

-- Reuse the existing set_updated_at() trigger function (defined alongside
-- `items` in the base schema).
drop trigger if exists settings_updated_at on settings;
create trigger settings_updated_at before update on settings
  for each row execute function set_updated_at();

alter table settings enable row level security;
drop policy if exists "settings owner all" on settings;
create policy "settings owner all"
  on settings for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
