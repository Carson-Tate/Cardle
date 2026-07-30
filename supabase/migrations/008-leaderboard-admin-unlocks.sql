-- Migration: return `admin_unlocks` from the leaderboard functions, so an
-- admin-granted cosmetic renders on a leaderboard row (DESIGN.md §11m).
--
-- WHY THIS COLUMN. A grant-only custom cosmetic (§11h) is deliberately dropped
-- by the client's resolveEquipped() unless the profile row proves the player was
-- actually granted it — that check is what makes re-locking an over-permissive
-- cosmetic take effect for people who already equipped it. The leaderboard
-- functions returned the three `equipped_*` columns but not the grant list, so
-- the check saw no grants and hid those cosmetics on the boards only, while they
-- rendered correctly on the profile page. Returning the column fixes the whole
-- class of bug rather than special-casing the boards.
--
-- Not sensitive: `admin_unlocks` is a list of cosmetic ids, and `profiles` has
-- always been readable to signed-in players (that is how friend lookup works).
-- Contrast `daily_plays.seed`, which is genuinely sensitive and is why migration
-- 006's read policy is scoped to completed runs only.
--
-- Both functions are dropped and recreated because their return type changes;
-- Postgres will not let `create or replace` alter a signature.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

drop function if exists public.leaderboard_top_scores(int, int);
create function public.leaderboard_top_scores(window_days int default null, row_limit int default 25)
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
set search_path = public
as $$
  select dp.user_id,
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
     -- Windows are measured from the GAME day (§11l), so "Today" means the day
     -- players are actually on. window_days = 0 is exactly today; null is all-time.
     and (window_days is null or dp.play_date >= public.game_today() - window_days)
   order by score desc, dp.play_date desc
   limit least(greatest(row_limit, 1), 100);
$$;

revoke all on function public.leaderboard_top_scores(int, int) from public, anon;
grant execute on function public.leaderboard_top_scores(int, int) to authenticated;

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

revoke all on function public.leaderboard_career_points(int) from public, anon;
grant execute on function public.leaderboard_career_points(int) to authenticated;
