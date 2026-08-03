-- Migration: let daily_standing rank a SCORE, not only the caller's saved row
-- (DESIGN.md §11ag).
--
-- Owner bug report: "i had a run in the test panel that was billions of points
-- and it said it was top 25%".
--
-- ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
-- Nothing, and that was the problem. Migration 016 ranks whatever sits in the
-- caller's own `daily_plays` row for the day:
--
--     mine as (select score from finished where user_id = auth.uid())
--
-- Test mode deliberately never persists (`persist: false`, state/test-mode.js),
-- so a test run is not in that table at all. The chip was faithfully reporting
-- where the player's REAL run placed, next to a test score it had never seen.
-- Accurate, and about the wrong run — which is worse than a visibly broken
-- number, because there is nothing to notice.
--
-- board.js made the same mistake readable in the code: `renderStanding` has
-- taken a `total` argument since §11aa and never passed it anywhere. A
-- parameter that is accepted and ignored looks exactly like a parameter that
-- works.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- An optional `for_score`. Given one, the function answers "where would this
-- score place among today's runs"; given nothing, it behaves exactly as before
-- and ranks the caller's saved row. Existing callers are unaffected — the new
-- argument defaults to null — so this is additive, not a replacement.
--
-- The field is unchanged and remains EVERYONE who finished today, with no
-- limit. Worth stating because "TOP 25%" reads to some people as "the top 25";
-- it is a percentage of the whole day's play.
--
-- ── ON RANKING AN ARBITRARY NUMBER ──────────────────────────────────────────
-- This lets a signed-in caller probe the distribution: pass a score, learn how
-- many people beat it. That is a small and deliberate widening. The boards
-- already publish the top 25 scores of every window, `total` was already
-- returned by this function, and nothing here exposes another player's identity
-- or hand. Still `security invoker` and still `authenticated` only, so an
-- anonymous visitor learns nothing.
--
-- Run this in your project's SQL Editor. Safe to run more than once.

create or replace function public.daily_standing(
  day date default null,
  for_score numeric default null
)
returns table (rank int, total int)
language sql
stable
set search_path = public
as $$
  with target as (
    -- The GAME day (19:00 America/New_York), never the UTC date.
    select coalesce(day, public.game_today()) as play_date
  ),
  finished as (
    select dp.user_id,
           (dp.result->'score'->>'total')::numeric as score
      from public.daily_plays dp, target t
     where dp.play_date = t.play_date
       and dp.result is not null
       -- Guarded before the cast: `result` is jsonb and pre-migration-015 rows
       -- came from the client, so one malformed total must not error the query.
       and dp.result->'score'->>'total' ~ '^[0-9]+(\.[0-9]+)?$'
  ),
  mine as (
    -- An explicit score wins; otherwise fall back to the caller's own finished
    -- run, which is migration 016's behaviour unchanged.
    select coalesce(for_score, (select f.score from finished f where f.user_id = auth.uid())) as score
  )
  select
    -- Standard competition ranking: ties share the better rank, so two players
    -- on the same score are both 1st and the next is 3rd. Counting STRICTLY
    -- greater scores is what produces that.
    (select count(*) + 1 from finished where score > (select score from mine))::int as rank,
    -- EVERY finished run of the day. No limit, and never the leaderboard's 25.
    (select count(*) from finished)::int as total
  where (select score from mine) is not null;
$$;

revoke all on function public.daily_standing(date, numeric) from public, anon;
grant execute on function public.daily_standing(date, numeric) to authenticated;

-- ⚠️ THIS PARAGRAPH WAS WRONG — SEE MIGRATION 019, WHICH FIXES IT.
--
-- It said: "The one-argument form from migration 016 is left in place rather
-- than dropped. A browser running the previous bundle keeps working through a
-- deploy, and Postgres resolves the two by arity with no ambiguity."
--
-- Postgres does. PostgREST does not — it matches an RPC on the JSON keys in the
-- body, so `{"day": null}` matches BOTH signatures and it returns PGRST203
-- rather than choosing. The shim broke the exact call it existed to protect.
-- Run 019, which drops the one-argument form; a single signature with a
-- defaulted `for_score` serves both call shapes.

-- ---------------------------------------------------------------------------
-- Self-test — run it and read it (§11y: put the test where the code runs)
-- ---------------------------------------------------------------------------
do $$
declare
  field_size int;
  top_rank int;
  bottom_rank int;
begin
  select count(*) into field_size
    from public.daily_plays
   where play_date = public.game_today()
     and result is not null
     and result->'score'->>'total' ~ '^[0-9]+(\.[0-9]+)?$';

  if field_size = 0 then
    raise notice 'No finished runs today yet — nothing to rank against. Function installed.';
    return;
  end if;

  -- A score nobody can beat must rank 1st; a score below everyone must rank
  -- last. `auth.uid()` is null in the SQL editor, which is exactly why the
  -- explicit-score path is the one testable here.
  select rank into top_rank from public.daily_standing(null, 1e30::numeric);
  select rank into bottom_rank from public.daily_standing(null, -1::numeric);

  if top_rank is null or top_rank <> 1 then
    raise exception 'an unbeatable score ranked % , expected 1', top_rank;
  end if;
  if bottom_rank is null or bottom_rank <> field_size + 1 then
    raise exception 'a last-place score ranked %, expected %', bottom_rank, field_size + 1;
  end if;

  raise notice 'Migration 018 self-test passed. Field today: % runs. Unbeatable ranks 1, worst ranks %.',
    field_size, bottom_rank;
end $$;
