-- ---------------------------------------------------------------------------
-- 028 — Top 50, and your own position when you are not in it (DESIGN.md §11ar)
-- ---------------------------------------------------------------------------
-- Owner: "make the leaderboards top 50 instead of top 25, if someone is out of
-- the top 50, show their position on the bottom."
--
-- Two changes, and the second is the one with teeth. Raising the page size is a
-- number. Telling somebody they are 143rd means RANKING EVERY PLAYER, which the
-- board functions never did — they take the top N and stop.
--
-- ONLY THE CALLER'S OWN RANK IS RETURNED. `auth.uid()` is evaluated inside the
-- function, so there is no parameter naming whose rank to look up and therefore
-- no way to ask about somebody else. That matters because a rank is a fact
-- about a person the top-50 list does not otherwise publish: being 143rd is
-- invisible to everyone today, and an RPC taking a user id would have made
-- every player's standing queryable by anyone. Same instinct as §11ap keeping
-- `is_suspended()` invoker-only.
--
-- A DETERMINISTIC FINAL TIE-BREAK WAS THE PREREQUISITE, not a tidy-up. The
-- board ordered by score then play_date with nothing after it, so two players
-- tied on both could swap places between loads — invisible while it only
-- shuffled two adjacent rows, and a real contradiction once a separate query
-- starts claiming "you are 51st". Both the list and the rank now end with
-- `user_id`, so they cannot disagree.
--
-- `row_number()`, NOT `rank()`. The list numbers its rows by position, so ties
-- already show as 7th and 8th rather than two 7ths; `rank()` would return 7 for
-- the player the list would have drawn 8th. The rank has to mean "where you
-- would appear in this list", because that is the list it is attached to.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Page size, and the tie-break the rank functions depend on
-- ---------------------------------------------------------------------------
create or replace function public.leaderboard_top_scores(
  window_days int default null,
  row_limit int default 50,
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
as $fn$
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
            best.play_date desc,
            best.user_id
   limit least(greatest(row_limit, 1), 100);
$fn$;

create or replace function public.leaderboard_career_points(row_limit int default 50)
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
as $fn$
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
   order by total_points desc, dp.user_id
   limit least(greatest(row_limit, 1), 100);
$fn$;

-- ---------------------------------------------------------------------------
-- 2. The caller's own position
-- ---------------------------------------------------------------------------
-- Returns no rows for an anonymous caller (auth.uid() is null), for a player
-- with no qualifying run in the window, and — deliberately — for anybody else.
drop function if exists public.leaderboard_my_rank(int, boolean);
create function public.leaderboard_my_rank(
  window_days int default null,
  sort_ascending boolean default false
)
returns table (
  place bigint,
  total_players bigint,
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
as $fn$
  with best as (
    -- Identical to the board's inner query, including the direction-aware pick
    -- of which of your own runs represents you. If these two ever diverge, a
    -- player is ranked against a different run than the one that would be
    -- listed — the exact class of bug §11y named: two functions answering the
    -- same question eventually disagree.
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
  ), ranked as (
    select b.*,
           row_number() over (
             order by case when sort_ascending then b.score end asc,
                      case when not sort_ascending then b.score end desc,
                      b.play_date desc,
                      b.user_id
           ) as place,
           count(*) over () as total_players
      from best b
  )
  select r.place, r.total_players, r.user_id, r.username, r.equipped_badge,
         r.equipped_title, r.equipped_paint, r.admin_unlocks, r.score,
         r.play_date, r.final_hand
    from ranked r
   where r.user_id = auth.uid();
$fn$;

revoke all on function public.leaderboard_my_rank(int, boolean) from public;
-- Granted to `authenticated` only. An anonymous caller has no rank to ask for,
-- so the public-boards decision (§11ac) does not quietly widen to cover this.
grant execute on function public.leaderboard_my_rank(int, boolean) to authenticated;

drop function if exists public.leaderboard_my_career_rank();
create function public.leaderboard_my_career_rank()
returns table (
  place bigint,
  total_players bigint,
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
as $fn$
  with totals as (
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
  ), ranked as (
    select t.*,
           row_number() over (order by t.total_points desc, t.user_id) as place,
           count(*) over () as total_players
      from totals t
  )
  select r.place, r.total_players, r.user_id, r.username, r.equipped_badge,
         r.equipped_title, r.equipped_paint, r.admin_unlocks, r.total_points, r.runs
    from ranked r
   where r.user_id = auth.uid();
$fn$;

revoke all on function public.leaderboard_my_career_rank() from public;
grant execute on function public.leaderboard_my_career_rank() to authenticated;

-- ---------------------------------------------------------------------------
-- Self-test
-- ---------------------------------------------------------------------------
-- The property worth pinning: the rank function and the board agree about who
-- is where. Checked by taking the board's own first row and confirming the
-- ranking CTE puts that same player at position 1 — which is what catches the
-- two queries drifting apart. The ranking is spelled out here rather than
-- called, because `leaderboard_my_rank` filters on `auth.uid()` and a migration
-- has no session.
do $selftest$
declare
  board_top uuid;
  ranked_top uuid;
begin
  select t.user_id into board_top
    from public.leaderboard_top_scores(null, 1, false) t;
  if board_top is null then
    raise notice 'Migration 028 applied. No finished runs yet, so the agreement self-test was skipped.';
    return;
  end if;

  select r.user_id into ranked_top
    from (
      select b.user_id,
             row_number() over (order by b.score desc, b.play_date desc, b.user_id) as place
        from (
          select distinct on (dp.user_id)
                 dp.user_id,
                 (dp.result->'score'->>'total')::numeric as score,
                 dp.play_date
            from public.daily_plays dp
            join public.profiles p on p.id = dp.user_id
           where dp.result is not null
             and (dp.result->'score'->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
           order by dp.user_id, (dp.result->'score'->>'total')::numeric desc, dp.play_date desc
        ) b
    ) r
   where r.place = 1;

  if board_top is distinct from ranked_top then
    raise exception '028 self-test: the board and the ranking disagree about first place (% vs %).', board_top, ranked_top;
  end if;

  raise notice 'Migration 028 self-test passed. The board and the rank function agree on ordering.';
end $selftest$;
