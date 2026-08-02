-- Migration: where the caller's run placed among today's, for the result
-- panel's TOP/BOTTOM % chip (DESIGN.md §11aa).
--
-- Run this in your project's SQL Editor. Safe to run more than once.
-- Nothing breaks if you skip it — the chip simply never appears.
--
-- WHY THIS IS A FUNCTION AND NOT A CLIENT QUERY. The obvious version is
-- "fetch today's rows and count locally", and it is wrong for two reasons.
-- Every row carries the full stored `result` — the hands, every bonus, the
-- meters, a few KB each — so a browser would download the entire day's play to
-- compute one integer, and the cost grows with the player count forever. And it
-- would hand every player a complete dump of everyone else's hands, which is a
-- good deal more than "how did I do". This returns two integers.
--
-- SECURITY INVOKER (the default), matching the leaderboard functions: it reads
-- exactly what the caller may already read under daily_plays' own SELECT policy
-- ("Completed runs are readable by signed-in players", migration 006). There is
-- nothing to elevate, and not elevating means a future policy change applies
-- here automatically.

create or replace function public.daily_standing(day date default null)
returns table (rank int, total int)
language sql
stable
set search_path = public
as $$
  with target as (
    -- The GAME day (19:00 America/New_York), never the UTC date — game_today()
    -- is the SQL mirror of core/game-day.js. Passing a day is for the profile
    -- page looking at an older run.
    select coalesce(day, public.game_today()) as play_date
  ),
  finished as (
    select dp.user_id,
           (dp.result->'score'->>'total')::numeric as score
      from public.daily_plays dp, target t
     where dp.play_date = t.play_date
       and dp.result is not null
       -- Guarded before the cast. `result` is jsonb and rows written before
       -- migration 015 came from the client, so a malformed total is possible;
       -- without this the whole query would error on one bad row rather than
       -- ignoring it.
       and dp.result->'score'->>'total' ~ '^[0-9]+(\.[0-9]+)?$'
  ),
  mine as (
    select score from finished where user_id = auth.uid()
  )
  select
    -- Standard competition ranking: ties share the better rank, so two players
    -- on the same score are both 1st and the next is 3rd. Counting STRICTLY
    -- greater scores is what produces that.
    (select count(*) + 1 from finished where score > (select score from mine))::int as rank,
    (select count(*) from finished)::int as total
  where exists (select 1 from mine);
$$;

-- Anonymous visitors cannot read daily_plays at all, so this would only ever
-- return an empty row for them — and the chip is meaningless without a run of
-- your own anyway.
revoke all on function public.daily_standing(date) from public, anon;
grant execute on function public.daily_standing(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-test — run it and read it
-- ---------------------------------------------------------------------------
-- In the SQL Editor `auth.uid()` is null, so daily_standing() itself returns no
-- rows there (that is correct, not a failure). This shows the field it would be
-- ranking against, so you can sanity-check the numbers by eye.
select count(*)                                          as finished_today,
       min((result->'score'->>'total')::numeric)         as lowest,
       max((result->'score'->>'total')::numeric)         as highest
  from public.daily_plays
 where play_date = public.game_today()
   and result is not null
   and result->'score'->>'total' ~ '^[0-9]+(\.[0-9]+)?$';
