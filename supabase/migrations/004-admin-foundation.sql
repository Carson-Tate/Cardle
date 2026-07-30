-- Migration: admin foundation (DESIGN.md §11f) — an admin flag, the guard
-- function every admin action checks, and the privileged functions that let an
-- admin act on other players' data.
--
-- ===========================================================================
-- READ THIS FIRST: WHY NONE OF THIS IS ENFORCED IN THE BROWSER
-- ===========================================================================
-- Cardle is a static site. Every line of its JavaScript is public, and the
-- Supabase key it holds is the PUBLIC anon key. A check like
-- `if (username === 'car') showAdminPage()` is therefore decoration, not
-- access control: anyone can read the bundle, see the check, and call the same
-- REST endpoints directly without it.
--
-- So the real boundary is here, in Postgres. Every privileged operation is a
-- `security definer` function that begins by calling `public.is_admin()`, which
-- reads the CALLER's own row via auth.uid(). The client-side check in
-- src/ui/header.js exists only to decide whether to render a link — if a
-- non-admin loads the admin page anyway, every action it can take is refused by
-- the database.
--
-- ===========================================================================
-- AND WHY is_admin NEEDS COLUMN-LEVEL PROTECTION
-- ===========================================================================
-- `profiles` already has an UPDATE policy of `auth.uid() = id` with NO column
-- restriction, which means a user can update any column on their own row via a
-- direct REST call. Adding `is_admin` under that policy would have let ANY
-- signed-in user grant themselves admin — the flag would be the exploit.
--
-- Step 3 below closes that by revoking blanket UPDATE from `authenticated` and
-- re-granting it only on the columns players are supposed to change. Same
-- lesson, and the same fix, as `daily_plays.seed` (which was writable for the
-- same reason and would have let a player reroll their own hand).
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The flag, and admin-granted cosmetic unlocks
-- ---------------------------------------------------------------------------
-- `admin_unlocks` exists because cosmetic unlocks are otherwise DERIVED from
-- achievements and level (src/core/cosmetics.js), so there was nowhere to
-- record "an admin gave this player that badge." Ids listed here are treated
-- as unlocked regardless of whether the player earned them.
alter table public.profiles
  add column if not exists is_admin boolean not null default false,
  add column if not exists admin_unlocks text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- 2. The guard
-- ---------------------------------------------------------------------------
-- `security definer` for two reasons: it must read profiles.is_admin without
-- being subject to the very policies that call it (which would recurse), and it
-- must be impossible for a caller to influence what it reads — it takes no
-- arguments and only ever looks at auth.uid().
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stop players writing privileged columns (see the header note)
-- ---------------------------------------------------------------------------
revoke update on public.profiles from authenticated;
grant update (username, equipped_badge, equipped_title, equipped_paint)
  on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Let admins read every player's runs
-- ---------------------------------------------------------------------------
-- daily_plays' existing SELECT policy is own-rows-only. Admin needs the whole
-- table for the player detail view and the active-player counts. This is an
-- ADDITIONAL policy: Postgres ORs permissive policies together, so ordinary
-- players are unaffected.
drop policy if exists "Admins can view all daily plays" on public.daily_plays;
create policy "Admins can view all daily plays"
  on public.daily_plays for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. Privileged actions
-- ---------------------------------------------------------------------------
-- Each one is `security definer` (so it can write rows RLS would otherwise
-- refuse) and each one's FIRST statement re-checks is_admin(). The check is
-- inside the function rather than relying on the caller, because the caller is
-- untrusted by definition.

-- Overview counters. Computed in SQL rather than by shipping rows to the
-- browser and counting them there — the numbers are all the admin page needs,
-- and this keeps the payload constant no matter how large the tables get.
-- "Active" is defined as accounts with a COMPLETED run in the window (result
-- is not null); real login timestamps live in auth.users and aren't reachable
-- from the browser, so play activity is the honest available signal.
create or replace function public.admin_overview()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_overview() requires an admin account';
  end if;

  return json_build_object(
    'total_profiles', (select count(*) from public.profiles),
    'total_runs', (select count(*) from public.daily_plays where result is not null),
    'runs_today', (select count(*) from public.daily_plays where result is not null and play_date = current_date),
    'active_24h', (select count(distinct user_id) from public.daily_plays
                    where result is not null and play_date >= current_date - 1),
    'active_7d', (select count(distinct user_id) from public.daily_plays
                    where result is not null and play_date >= current_date - 7),
    'active_30d', (select count(distinct user_id) from public.daily_plays
                    where result is not null and play_date >= current_date - 30),
    'admins', (select count(*) from public.profiles where is_admin)
  );
end $$;

-- Sets another player's equipped cosmetics. Deliberately cannot touch
-- is_admin: promoting an admin is a SQL-console action on purpose, so no
-- compromised admin session can mint more admins.
create or replace function public.admin_set_cosmetics(
  target_id uuid,
  badge text,
  title text,
  paint text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_cosmetics() requires an admin account';
  end if;

  update public.profiles
     set equipped_badge = badge,
         equipped_title = title,
         equipped_paint = paint
   where id = target_id;

  if not found then
    raise exception 'no profile with id %', target_id;
  end if;
end $$;

-- Grants or removes cosmetic unlocks for a player (see admin_unlocks above).
create or replace function public.admin_set_unlocks(target_id uuid, unlocks text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_unlocks() requires an admin account';
  end if;

  -- Same shape rule as the equipped_* columns: these ids are rendered next to
  -- usernames, so nothing needing HTML escaping may be stored.
  if exists (select 1 from unnest(coalesce(unlocks, '{}')) u where u !~ '^[A-Za-z0-9_]{1,40}$') then
    raise exception 'unlock ids must match ^[A-Za-z0-9_]{1,40}$';
  end if;

  update public.profiles set admin_unlocks = coalesce(unlocks, '{}') where id = target_id;

  if not found then
    raise exception 'no profile with id %', target_id;
  end if;
end $$;

-- Clears a player's claimed hand for a date so they can play it again. Deletes
-- the row rather than blanking `result`, because a null result means "seed
-- claimed, not finished" (§11c) — which would leave them stuck on the same
-- hand instead of getting a fresh one.
create or replace function public.admin_reset_day(target_id uuid, day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_reset_day() requires an admin account';
  end if;

  delete from public.daily_plays where user_id = target_id and play_date = coalesce(day, current_date);
end $$;

-- Deletes another player's account entirely. Cascades from auth.users the same
-- way delete_own_account() does (migration 002).
create or replace function public.admin_delete_player(target_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_delete_player() requires an admin account';
  end if;

  -- Refuse to delete an admin, including yourself: an accidental click here is
  -- unrecoverable and would also be a way to lock the project out of its own
  -- admin access. Demote in SQL first if this is really intended.
  if (select is_admin from public.profiles where id = target_id) then
    raise exception 'refusing to delete an admin account; clear is_admin in SQL first';
  end if;

  delete from auth.users where id = target_id;
end $$;

revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_set_cosmetics(uuid, text, text, text) from public, anon;
revoke all on function public.admin_set_unlocks(uuid, text[]) from public, anon;
revoke all on function public.admin_reset_day(uuid, date) from public, anon;
revoke all on function public.admin_delete_player(uuid) from public, anon;

grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_set_cosmetics(uuid, text, text, text) to authenticated;
grant execute on function public.admin_set_unlocks(uuid, text[]) to authenticated;
grant execute on function public.admin_reset_day(uuid, date) to authenticated;
grant execute on function public.admin_delete_player(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. MAKE YOURSELF ADMIN — the one step you have to run by hand
-- ---------------------------------------------------------------------------
-- Deliberately not automated and deliberately not keyed to a username in any
-- policy: who is an admin is data, not code, so it never appears in the public
-- JavaScript bundle, it survives a username change, and adding a second admin
-- later needs no deploy.
--
-- Replace 'car' if your username differs, then run:
--
--     update public.profiles set is_admin = true where username = 'car';
--
-- Verify with:
--
--     select username, is_admin from public.profiles where is_admin;
