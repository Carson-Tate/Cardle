-- Migration: let a signed-OUT visitor see the leaderboards, other players'
-- profiles, and the breakdown of any finished hand (DESIGN.md §11ac).
--
-- Owner request: "i want to make the leaderboard public and able to see without
-- signing in, take into account clicking on profile and what the add friend
-- button should do when not signed in."
--
-- ── WHY THIS IS NOT JUST `to anon` ON THE EXISTING POLICY ────────────────────
-- The obvious change is to widen migration 006's policy from `to authenticated`
-- to include `anon`. That would work, and it would also publish the whole
-- daily_plays TABLE to the internet through PostgREST: with the anon key that
-- ships in every page, `GET /rest/v1/daily_plays?select=*` would return every
-- column of every finished row — including `seed`, and including every column
-- this table ever gains in future. Nobody would have to remember to re-check
-- that when adding one.
--
-- So the table stays closed to anon and the READS ARE ELEVATED INSTEAD. Each
-- function below is `security definer` and enumerates its own output columns,
-- which is the entire public surface: a leaderboard row, a player's finished
-- runs, one run's stored result. `seed` is not among them and cannot be asked
-- for.
--
-- This reverses §11j's choice of `security invoker` for the board functions,
-- and reverses it for the reason §11j gave. Its rule was: elevate when the
-- function must do something the caller cannot, don't when it reads exactly
-- what the caller may already read. The second case was true while every caller
-- was signed in. It is false now — an anonymous caller may read none of this
-- directly, which is precisely the condition the rule names for elevating.
--
-- ── WHAT EVERY FUNCTION HERE MUST STILL ENFORCE ─────────────────────────────
-- `result is not null`. A null-result row holds the SEED for a hand its owner
-- has not locked in yet (§11c), so exposing one would let anyone deal that
-- player's hand before they do. Migration 006 wrote its policy narrowly around
-- exactly this; a `security definer` function bypasses RLS entirely, so the
-- clause has to be repeated in the body of each one rather than inherited.
-- That is the trade elevation makes: the check moves from the policy into the
-- function, so it has to be written and kept correct in both places.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The boards
-- ---------------------------------------------------------------------------
-- Body is unchanged from migration 011 — only the volatility marker gains
-- `security definer` and the grant gains `anon`. Restated in full rather than
-- ALTERed so this file is the whole current definition, the same convention
-- 008/010/011 follow.

drop function if exists public.leaderboard_top_scores(int, int);
drop function if exists public.leaderboard_top_scores(int, int, boolean);
create function public.leaderboard_top_scores(
  window_days int default null,
  row_limit int default 25,
  sort_ascending boolean default false
)
returns table (
  user_id uuid,
  username text,
  equipped_badge text,
  equipped_title text,
  equipped_paint text,
  admin_unlocks text[],
  score numeric,
  play_date date,
  final_hand jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select best.user_id,
         best.username,
         best.equipped_badge,
         best.equipped_title,
         best.equipped_paint,
         best.admin_unlocks,
         best.score,
         best.play_date,
         best.final_hand
    from (
      -- One row per player (migration 010). The per-player pick follows the same
      -- direction as the board: on an ascending day "your best result" is your
      -- LOWEST score, so a player is represented by the row that would actually
      -- rank them.
      select distinct on (dp.user_id)
             dp.user_id,
             p.username,
             p.equipped_badge,
             p.equipped_title,
             p.equipped_paint,
             p.admin_unlocks,
             (dp.result->'score'->>'total')::numeric as score,
             dp.play_date,
             dp.result->'finalHand' as final_hand
        from public.daily_plays dp
        join public.profiles p on p.id = dp.user_id
       where dp.result is not null
         and (dp.result->'score'->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
         and (window_days is null or dp.play_date >= public.game_today() - window_days)
       order by dp.user_id,
                case when sort_ascending then (dp.result->'score'->>'total')::numeric end asc,
                case when not sort_ascending then (dp.result->'score'->>'total')::numeric end desc,
                dp.play_date desc
    ) best
   order by case when sort_ascending then best.score end asc,
            case when not sort_ascending then best.score end desc,
            best.play_date desc
   limit least(greatest(row_limit, 1), 100);
$$;

revoke all on function public.leaderboard_top_scores(int, int, boolean) from public;
grant execute on function public.leaderboard_top_scores(int, int, boolean) to anon, authenticated;

drop function if exists public.leaderboard_career_points(int);
create function public.leaderboard_career_points(row_limit int default 25)
returns table (
  user_id uuid,
  username text,
  equipped_badge text,
  equipped_title text,
  equipped_paint text,
  admin_unlocks text[],
  total_points numeric,
  runs bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select dp.user_id,
         p.username,
         p.equipped_badge,
         p.equipped_title,
         p.equipped_paint,
         p.admin_unlocks,
         sum((dp.result->'score'->>'total')::numeric) as total_points,
         count(*) as runs
    from public.daily_plays dp
    join public.profiles p on p.id = dp.user_id
   where dp.result is not null
     and (dp.result->'score'->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
   group by dp.user_id, p.username, p.equipped_badge, p.equipped_title, p.equipped_paint, p.admin_unlocks
   order by total_points desc
   limit least(greatest(row_limit, 1), 100);
$$;

revoke all on function public.leaderboard_career_points(int) from public;
grant execute on function public.leaderboard_career_points(int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. One player's finished runs — the profile page
-- ---------------------------------------------------------------------------
-- Everything the profile page derives (stats, level, achievements, recent
-- hands, best hand) comes from these rows and nothing else, because §11d chose
-- to DERIVE rather than accumulate. So this one function is the whole of a
-- public profile; there is no separate stats endpoint to keep in step with it.
--
-- Returns only play_date and result. A caller cannot ask for `seed` or
-- `user_id` here the way `select=` would let them against the table.

create or replace function public.public_player_runs(
  target_user_id uuid,
  row_limit int default 400
)
returns table (
  play_date date,
  result jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select dp.play_date, dp.result
    from public.daily_plays dp
   where dp.user_id = target_user_id
     and dp.result is not null
   order by dp.play_date desc
   limit least(greatest(row_limit, 1), 400);
$$;

revoke all on function public.public_player_runs(uuid, int) from public;
grant execute on function public.public_player_runs(uuid, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A single run — the hand-breakdown modal (§11ab)
-- ---------------------------------------------------------------------------
-- The leaderboard holds only a score and a final hand, so opening a breakdown
-- is a second read. Scoped to one run rather than reusing public_player_runs,
-- which would pull a player's entire history to render one modal.

create or replace function public.public_run_result(
  target_user_id uuid,
  target_play_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select dp.result
    from public.daily_plays dp
   where dp.user_id = target_user_id
     and dp.play_date = target_play_date
     and dp.result is not null;
$$;

revoke all on function public.public_run_result(uuid, date) from public;
grant execute on function public.public_run_result(uuid, date) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Stop publishing is_admin to the whole internet
-- ---------------------------------------------------------------------------
-- Found while auditing what a signed-out visitor can already reach, and NOT
-- introduced by this migration — `profiles`' select policy has been
-- `using (true)` with no role restriction since the first schema, so
-- `GET /rest/v1/profiles?select=username,is_admin&is_admin=eq.true` has always
-- named the admin to anyone who asked.
--
-- That matters because §11f's threat model is "one compromised admin becomes
-- JavaScript in every session": knowing WHICH account to go after is the first
-- step, and there is no reason to hand it over. Usernames and cosmetics are
-- meant to be public — is_admin never was.
--
-- Column-level, because the fix has to keep the rest of the row readable: a
-- nameplate renders for anyone. Nothing in the client reads this column from
-- the table (state/admin.js asks the is_admin() FUNCTION, and the admin page's
-- player list comes from admin_overview(), which is `security definer` and so
-- unaffected by these grants), so nothing breaks.
--
-- `authenticated` keeps its existing access deliberately. Narrowing that too is
-- a separate question with its own blast radius — it would need getProfile()'s
-- `select('*')` rewritten first — and leaving it as-is means this migration
-- cannot regress a signed-in path. The exposure that gets closed here is the
-- one that needs no account at all.
revoke select on public.profiles from anon;
grant select (id, username, equipped_badge, equipped_title, equipped_paint, admin_unlocks, created_at)
  on public.profiles to anon;

-- ---------------------------------------------------------------------------
-- 5. Self-test
-- ---------------------------------------------------------------------------
-- Put the test where the code runs (§11y): these grants are the whole point of
-- the migration and cannot be exercised from Node.
do $$
declare
  admin_readable boolean;
begin
  -- is_admin must NOT be selectable by anon; username must still be.
  select has_column_privilege('anon', 'public.profiles', 'is_admin', 'select') into admin_readable;
  if admin_readable then
    raise exception 'anon can still read profiles.is_admin — the revoke did not take';
  end if;

  if not has_column_privilege('anon', 'public.profiles', 'username', 'select') then
    raise exception 'anon lost read access to profiles.username — nameplates will break';
  end if;

  -- The four public functions must be callable by a signed-out visitor.
  if not has_function_privilege('anon', 'public.leaderboard_top_scores(int, int, boolean)', 'execute')
     or not has_function_privilege('anon', 'public.leaderboard_career_points(int)', 'execute')
     or not has_function_privilege('anon', 'public.public_player_runs(uuid, int)', 'execute')
     or not has_function_privilege('anon', 'public.public_run_result(uuid, date)', 'execute') then
    raise exception 'a public read function is not executable by anon';
  end if;

  -- And the table itself must stay shut to anon, or the elevation bought
  -- nothing. daily_plays has no anon-facing policy; this asserts the grant
  -- situation that backs that up has not drifted.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'daily_plays'
       and 'anon' = any(roles)
  ) then
    raise exception 'daily_plays has a policy naming anon — the table is exposed directly';
  end if;

  raise notice 'Migration 017 self-test passed.';
end $$;
