-- 010 — Two independent sources of "the same name twice" (DESIGN.md §11p).
--
-- Owner bug report: "bug where theres multiple of the same name". There turned
-- out to be two causes, in different features, so both are fixed here.
--
-- Safe to re-run: every statement is idempotent or guarded.

-- ---------------------------------------------------------------------------
-- 1. The leaderboard ranked PLAYS, not PLAYERS
-- ---------------------------------------------------------------------------
-- `leaderboard_top_scores` selected straight from `daily_plays` ordered by
-- score, with nothing collapsing a player's rows. On "Today" that is invisible
-- — one play per player per day — but on "This Week" and "All-Time" anybody
-- with two good days occupied two rows, and a player with a great week could
-- fill most of the board alone. That is not a leaderboard; a board of 25 should
-- be 25 different people.
--
-- `distinct on (user_id)` keeps each player's single best row (its `order by`
-- must lead with user_id, which is why the ranking sort has to happen in the
-- outer query). play_date breaks a tie between two identical scores so the
-- result is deterministic rather than whichever row Postgres reached first.
--
-- The `limit` also moves outward, which fixes a second-order bug: applied
-- inside, it would take the top N *plays* and then collapse them, returning
-- fewer than N players whenever anyone appeared twice.
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
         -- Windows are measured from the GAME day, so "Today" means the day
         -- players are actually on. window_days = 0 is exactly today; null is
         -- all-time.
         and (window_days is null or dp.play_date >= public.game_today() - window_days)
       order by dp.user_id, score desc, dp.play_date desc
    ) best
   order by best.score desc, best.play_date desc
   limit least(greatest(row_limit, 1), 100);
$$;

-- security invoker (the default) is deliberate and unchanged: this reads
-- exactly what the caller is already allowed to read, so not elevating keeps it
-- correct if the underlying policies ever tighten.
revoke all on function public.leaderboard_top_scores(int, int) from public, anon;
grant execute on function public.leaderboard_top_scores(int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. A friendship could exist twice, once in each direction
-- ---------------------------------------------------------------------------
-- `friendships` has `unique (requester_id, addressee_id)`, which is
-- DIRECTIONAL: it stops A asking B twice, but not A→B and B→A both existing. If
-- two players happened to add each other before either accepted, they ended up
-- with two rows for one friendship — so the friends list showed the same person
-- twice, and the panel could show them under "Sent" and "Requests" at once.
--
-- Cleaned before the index is added, because creating a unique index over
-- existing violations would fail. Of each duplicated pair keep exactly one row,
-- preferring an accepted friendship over a pending request (never silently
-- downgrade a real friendship), then the oldest.
with ranked as (
  select id,
         row_number() over (
           partition by least(requester_id, addressee_id), greatest(requester_id, addressee_id)
           order by (status = 'accepted') desc, created_at asc, id asc
         ) as rn
    from public.friendships
)
delete from public.friendships f
 using ranked r
 where f.id = r.id
   and r.rn > 1;

-- The real fix. An expression index on the normalized pair makes the constraint
-- non-directional, so the duplicate cannot be recreated — including by a caller
-- going straight at the REST API rather than through the app, which is why this
-- belongs in the database and not only in friends.js.
create unique index if not exists friendships_unique_pair
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- ---------------------------------------------------------------------------
-- 3. Username search for the friend picker
-- ---------------------------------------------------------------------------
-- The add-friend flow now searches before sending (owner request), which means
-- prefix-matching `username`. `profiles` is already publicly readable — that is
-- how friend lookup and profile viewing have always worked — so this grants no
-- new visibility; it only makes the lookup fast. text_pattern_ops is what lets
-- a `like 'ABC%'` prefix scan use an index at all.
create index if not exists profiles_username_prefix
  on public.profiles (username text_pattern_ops);
