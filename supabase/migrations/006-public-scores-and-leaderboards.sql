-- Migration: make COMPLETED runs readable by any signed-in player, and add the
-- leaderboard queries (DESIGN.md §11j).
--
-- Two features need the same thing and so share one migration: leaderboards
-- (which must read everyone's scores) and clickable friend profiles (which must
-- read one other player's history). The owner chose "completed runs readable by
-- anyone" over friends-only, because friends-only would have forced the
-- leaderboards to be friends-only too.
--
-- WHAT THIS DOES AND DOESN'T EXPOSE. It exposes finished runs: a score, the
-- hand that was already played, and a public username. It deliberately does NOT
-- expose a claimed-but-unfinished row — the `result is not null` clause below is
-- the whole point of the policy, because a row with a null result carries the
-- SEED for a hand the player hasn't locked in yet (§11c). Without that clause,
-- anyone could read another player's seed, deal it themselves, and see today's
-- hand before them. That's the one genuinely sensitive thing in this table, so
-- the policy is written narrowly around it rather than as a blanket
-- `using (true)`.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

drop policy if exists "Completed runs are readable by signed-in players" on public.daily_plays;
create policy "Completed runs are readable by signed-in players"
  on public.daily_plays for select
  to authenticated
  using (result is not null);

-- Index the columns the leaderboards sort and filter on. Without this every
-- board is a full scan plus a sort, which is fine at launch and not fine later.
create index if not exists daily_plays_play_date_idx
  on public.daily_plays (play_date desc)
  where result is not null;

-- ---------------------------------------------------------------------------
-- Leaderboards
-- ---------------------------------------------------------------------------
-- Computed in SQL rather than by shipping every row to the browser and sorting
-- there: the payload stays a fixed handful of rows no matter how many players
-- exist, and the score extraction/ranking logic lives in one place.
--
-- `(result->'score'->>'total')::numeric` — the run result is stored as jsonb
-- (§11c), so the score is dug out of it. numeric rather than bigint because
-- these totals reach into the hundreds of millions once multipliers stack, and
-- a malformed row could hold anything; numeric won't overflow on a surprise.
--
-- SECURITY INVOKER (the default), not `security definer` — these read exactly
-- what the caller is allowed to read under the policy above. There is no reason
-- to elevate, and not elevating means a future policy change automatically
-- applies here too.

-- Top single scores in a window. `window_days` of null means all-time.
create or replace function public.leaderboard_top_scores(window_days int default null, row_limit int default 25)
returns table (
  user_id uuid,
  username text,
  equipped_badge text,
  equipped_title text,
  equipped_paint text,
  score numeric,
  play_date date
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
         dp.play_date
    from public.daily_plays dp
    join public.profiles p on p.id = dp.user_id
   where dp.result is not null
     and (dp.result->'score'->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
     and (window_days is null or dp.play_date >= current_date - window_days)
   order by score desc, dp.play_date desc
   limit least(greatest(row_limit, 1), 100);
$$;

-- Career totals: every completed run a player has, added up.
create or replace function public.leaderboard_career_points(row_limit int default 25)
returns table (
  user_id uuid,
  username text,
  equipped_badge text,
  equipped_title text,
  equipped_paint text,
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
         sum((dp.result->'score'->>'total')::numeric) as total_points,
         count(*) as runs
    from public.daily_plays dp
    join public.profiles p on p.id = dp.user_id
   where dp.result is not null
     and (dp.result->'score'->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
   group by dp.user_id, p.username, p.equipped_badge, p.equipped_title, p.equipped_paint
   order by total_points desc
   limit least(greatest(row_limit, 1), 100);
$$;

revoke all on function public.leaderboard_top_scores(int, int) from public, anon;
revoke all on function public.leaderboard_career_points(int) from public, anon;
grant execute on function public.leaderboard_top_scores(int, int) to authenticated;
grant execute on function public.leaderboard_career_points(int) to authenticated;
