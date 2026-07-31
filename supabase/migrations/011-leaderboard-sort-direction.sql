-- 011 — Let the daily board rank lowest-first (DESIGN.md §4f/§11r).
--
-- The "Upside Down" modifier makes the DAILY leaderboard show the true bottom
-- 25, lowest on top (owner request: "flipped leaderboard day, normal draw but
-- lowest score is on top for that day").
--
-- WHY THIS CANNOT BE DONE IN THE CLIENT. The function returns the top N by score
-- DESC and the client only ever sees those rows, so reversing them client-side
-- gives the BOTTOM OF THE TOP 25 — the opposite board from the one asked for.
-- The 25 genuinely lowest scores are rows the client was never sent. The sort
-- has to happen before the limit, which means it has to happen here.
--
-- Scoring is untouched by all of this: a player's score, its grade, and the
-- career points it contributes are identical to any other day. Only the ordering
-- of one board changes, which is what keeps achievements, personality, the
-- decision rating and the EV solver — all of which assume higher is better —
-- out of it entirely.
--
-- Run this in your project's SQL Editor. Safe to run more than once.

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
      -- rank them. On the daily board this is academic — one play per player per
      -- day — but leaving it inconsistent would quietly break the moment this
      -- direction is ever used with a wider window.
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
         -- Windows are measured from the GAME day, so "Today" means the day
         -- players are actually on. window_days = 0 is exactly today; null is
         -- all-time.
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

-- security invoker (the default) is deliberate and unchanged: this reads exactly
-- what the caller may already read, so not elevating keeps it correct if the
-- underlying policies ever tighten.
revoke all on function public.leaderboard_top_scores(int, int, boolean) from public, anon;
grant execute on function public.leaderboard_top_scores(int, int, boolean) to authenticated;
