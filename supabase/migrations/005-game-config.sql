-- Migration: `game_config`, the server-side config the admin page edits and
-- every client reads at boot (DESIGN.md §11g).
--
-- WHY THIS TABLE EXISTS: the daily modifier, the poem word bank, and the
-- cosmetic registries were all pure client-side constants — functions of the
-- date, or hardcoded arrays. That made them fast and testable but also
-- unchangeable without a code deploy, so the admin page could only ever *show*
-- the modifier schedule, never alter it. This table is the missing piece: a
-- tiny key/value store, publicly readable so every player's client honours the
-- same config, admin-writable only.
--
-- WHY KEY/VALUE RATHER THAN TYPED COLUMNS: the three settings have completely
-- different shapes (a date→id map, a nested word bank, three lists of cosmetic
-- definitions), and more will follow. One jsonb value per key means adding the
-- next setting needs no migration. The trade-off is that Postgres cannot
-- meaningfully validate the contents, so validation lives in
-- src/core/game-config.js as pure, unit-tested functions and is applied on the
-- way IN (the admin page refuses to save invalid config) and again on the way
-- OUT (a bad stored value falls back to the built-in default rather than
-- breaking the game).
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

create table if not exists public.game_config (
  key text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.game_config enable row level security;

-- Everyone reads it: a config that only admins could see would not actually
-- change anyone's game. There is nothing private here — it is the rules of the
-- game, which players experience anyway.
drop policy if exists "Game config is readable by everyone" on public.game_config;
create policy "Game config is readable by everyone"
  on public.game_config for select
  using (true);

-- No INSERT/UPDATE/DELETE policy at all, deliberately: writes go exclusively
-- through admin_set_config() below. With RLS enabled and no write policy, a
-- direct REST write is refused outright even for an admin, so there is exactly
-- one authorized path and it is the one that checks is_admin().
create or replace function public.admin_set_config(config_key text, config_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_config() requires an admin account';
  end if;

  if config_key !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'config key must match ^[a-z0-9_]{1,40}$';
  end if;

  insert into public.game_config (key, value, updated_at, updated_by)
       values (config_key, config_value, now(), auth.uid())
  on conflict (key)
    do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
end $$;

-- Lets the admin page reset a setting back to the built-in default by removing
-- the row entirely, which is meaningfully different from storing an empty
-- value: absent means "use the code's default", empty means "the admin
-- deliberately cleared this".
create or replace function public.admin_clear_config(config_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_clear_config() requires an admin account';
  end if;

  delete from public.game_config where key = config_key;
end $$;

revoke all on function public.admin_set_config(text, jsonb) from public, anon;
revoke all on function public.admin_clear_config(text) from public, anon;
grant execute on function public.admin_set_config(text, jsonb) to authenticated;
grant execute on function public.admin_clear_config(text) to authenticated;
