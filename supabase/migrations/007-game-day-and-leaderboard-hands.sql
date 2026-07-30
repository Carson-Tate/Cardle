-- Migration: teach the database the 7pm-New-York game day, and return the
-- winning hand on the leaderboards (DESIGN.md §11l).
--
-- WHY THE DATABASE HAS TO KNOW. The client now decides which game day it is
-- from a 7pm America/New_York boundary (core/game-day.js) and sends that as
-- `play_date`. Any SQL that says `current_date` is still on the UTC calendar, so
-- for the hours between the reset and midnight UTC the two disagree — the daily
-- leaderboard would show yesterday's board while players were already on today's
-- hand, and the admin overview would miscount "runs today". `game_today()` below
-- is the single shared definition so that can't drift.
--
-- The rule matches gameDayFor() exactly: take the New York local date, and add a
-- day once the local hour reaches 19. In winter 19:00 EST is midnight UTC, so
-- this returns the same date the old `current_date` did — which is why no stored
-- row needed rewriting.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

create or replace function public.game_today()
returns date
language sql
stable
set search_path = public
as $$
  select case
           when extract(hour from (now() at time zone 'America/New_York')) >= 19
             then ((now() at time zone 'America/New_York')::date + 1)
           else (now() at time zone 'America/New_York')::date
         end;
$$;

grant execute on function public.game_today() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Leaderboards: game-day windows, plus the winning hand
-- ---------------------------------------------------------------------------
-- `final_hand` is added so a board can show WHAT the player won with, not just
-- the number (owner request). It comes straight out of the stored result jsonb,
-- so nothing new is recorded — the hand was always there.
--
-- Dropped rather than replaced: the return type changes, and Postgres will not
-- let `create or replace` alter a function's signature.
drop function if exists public.leaderboard_top_scores(int, int);
create function public.leaderboard_top_scores(window_days int default null, row_limit int default 25)
returns table (
  user_id uuid,
  username text,
  equipped_badge text,
  equipped_title text,
  equipped_paint text,
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
         (dp.result->'score'->>'total')::numeric as score,
         dp.play_date,
         dp.result->'finalHand' as final_hand
    from public.daily_plays dp
    join public.profiles p on p.id = dp.user_id
   where dp.result is not null
     and (dp.result->'score'->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
     -- Windows are measured from the GAME day, so "Today" means the day players
     -- are actually on. window_days = 0 is exactly today; null is all-time.
     and (window_days is null or dp.play_date >= public.game_today() - window_days)
   order by score desc, dp.play_date desc
   limit least(greatest(row_limit, 1), 100);
$$;

revoke all on function public.leaderboard_top_scores(int, int) from public, anon;
grant execute on function public.leaderboard_top_scores(int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin overview: count against the game day too
-- ---------------------------------------------------------------------------
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
    'runs_today', (select count(*) from public.daily_plays
                    where result is not null and play_date = public.game_today()),
    'active_24h', (select count(distinct user_id) from public.daily_plays
                    where result is not null and play_date >= public.game_today() - 1),
    'active_7d', (select count(distinct user_id) from public.daily_plays
                    where result is not null and play_date >= public.game_today() - 7),
    'active_30d', (select count(distinct user_id) from public.daily_plays
                    where result is not null and play_date >= public.game_today() - 30),
    'admins', (select count(*) from public.profiles where is_admin)
  );
end $$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- admin_reset_day: default to the game day, not the UTC date
-- ---------------------------------------------------------------------------
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

  delete from public.daily_plays
   where user_id = target_id
     and play_date = coalesce(day, public.game_today());
end $$;

revoke all on function public.admin_reset_day(uuid, date) from public, anon;
grant execute on function public.admin_reset_day(uuid, date) to authenticated;
