-- Migration: reset the whole current game day for every player (DESIGN.md §11aj).
--
-- WHAT THIS IS FOR. `admin_reset_day(target_id, day)` (migration 004) clears ONE
-- player's claimed hand. When something is wrong with the day itself — a broken
-- modifier pin, a scoring bug that landed mid-day, a deal nobody should have to
-- keep — the only remedy was to search every affected player and reset them one
-- at a time, which is not a remedy at all once more than a handful of people
-- have played. This clears the day in one statement.
--
-- ── THE DAY IS NOT A PARAMETER ──────────────────────────────────────────────
-- The day deleted is always `public.game_today()`, computed here. The admin page
-- offers a single "today" button, but the page is public JavaScript and has
-- never been the boundary (see 004-admin-foundation.sql's note, and
-- src/ui/admin.js's header comment) — a patched bundle could call any RPC it
-- likes with any argument it likes. A date in the signature that SELECTED the
-- day would mean the "today only" decision lived in the one place that cannot
-- enforce it.
--
-- `expected_day` is therefore a GUARD, not a selector, and the distinction is
-- the whole design: it can only ever cause the function to REFUSE. Passing last
-- Tuesday does not delete last Tuesday, it aborts. Passing null skips the check.
--
-- It exists for one race that is otherwise silent. The admin page computes the
-- day when it renders the confirmation; the server computes it when the delete
-- runs. Those are different instants, and at 19:00 New York they straddle a
-- rollover — so an admin can read "2026-08-06", type "2026-08-06" to confirm,
-- and have the server clear 2026-08-07. Nothing about that failure is visible:
-- the button works, a row count comes back, and the notice names the day the
-- admin was looking at. Sending the confirmed day back turns it into an error
-- instead. It is a seconds-wide window, but §11ag was a seconds-wide window too,
-- and the cost of closing it is five lines.
--
-- That restriction is not squeamishness. Resetting a PAST day silently rewrites
-- the weekly and all-time leaderboards, and rolls back the XP, level, streak and
-- achievements of everyone who played it — all of which are derived from
-- `daily_plays` rows (src/core/player-stats.js) and so move the instant the rows
-- do. Today is the only day where "play it again" is what a reset actually
-- means; for anything older, `admin_reset_day` still exists and at least scopes
-- the damage to one person who asked for it.
--
-- Also, per 019's rule: this is a NEW name with zero arguments, not an overload
-- of admin_reset_day. PostgREST resolves an RPC by the JSON keys in the request
-- body, so two functions that can both accept the same body return PGRST203
-- instead of picking one.
--
-- ── WHY IT DELETES RATHER THAN BLANKS ───────────────────────────────────────
-- Same reason 004 gives for the per-player version: a row with a null `result`
-- means "seed claimed, not finished", so blanking `result` would leave everyone
-- stuck on the same hand they were already unhappy with. Deleting the row
-- releases the seed, and the next claim rolls a fresh one.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The reset itself
-- ---------------------------------------------------------------------------
-- Returns the number of rows removed, so the page can report what actually
-- happened rather than a fixed "done." — the count includes UNFINISHED claims
-- (people mid-hand right now), which is exactly the number nothing else on the
-- admin page was showing.
--
-- Dropped first, then created. `create or replace` cannot change an argument
-- list — it would leave the old signature installed alongside the new one, which
-- is the PGRST203 trap 019 spent a whole migration undoing. Nothing shipped
-- without `expected_day`, so this is only insurance against a draft having been
-- run by hand; the self-test at the bottom would catch it either way, but a
-- migration that heals is better than one that only complains.
drop function if exists public.admin_reset_today_for_everyone();
create or replace function public.admin_reset_today_for_everyone(expected_day date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := public.game_today();
  removed integer;
begin
  if not public.is_admin() then
    raise exception 'admin_reset_today_for_everyone() requires an admin account';
  end if;

  -- The guard, not a selector: `today` above is what gets deleted no matter what
  -- arrives here. All this can do is stop the delete happening at all.
  if expected_day is not null and expected_day <> today then
    raise exception 'the game day rolled over to % while you were confirming %; nothing was deleted', today, expected_day;
  end if;

  delete from public.daily_plays where play_date = today;
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke all on function public.admin_reset_today_for_everyone(date) from public, anon;
grant execute on function public.admin_reset_today_for_everyone(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Overview: count CLAIMS today, not just finished runs
-- ---------------------------------------------------------------------------
-- `runs_today` has always been `result is not null` — finished runs. That is the
-- right number for "how much play happened", and the WRONG number to put in
-- front of a delete, because the reset also removes rows for people who are part
-- way through a hand. Showing "this will clear 47 runs" and then clearing 51 is
-- the §11ag failure exactly: a plausible number sitting under the wrong thing.
--
-- `claimed_today` is that honest figure. Added to the existing json rather than
-- given its own RPC so the page still makes one round trip; the return type is
-- `json`, so `create or replace` can add a key without a signature change and an
-- older bundle simply ignores it.
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
    -- Every row for today, finished or not — what a full day reset will delete.
    'claimed_today', (select count(*) from public.daily_plays
                       where play_date = public.game_today()),
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
-- 3. Self-test
-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT A BEHAVIOURAL TEST, and it is worth saying why rather than
-- leaving it looking like an oversight. Every other migration's self-test can
-- exercise the real thing because reading is free; the only way to prove this
-- function deletes is to let it delete every run of the live day. A self-test
-- that destroys the data it is checking is not a test, it is the incident.
--
-- So this asserts the properties that would actually be wrong if this migration
-- were mis-applied — the ones that are silent failures rather than loud ones:
-- an overload sneaking in (019's PGRST203), the function landing as `security
-- invoker` (RLS would then quietly delete only the ADMIN'S OWN row and report
-- "1 hand cleared", which looks like a working button), `anon` keeping execute,
-- or the guard argument having since been turned into a day selector.
--
-- NOTHING BELOW EXERCISES THE DELETE, and no test anywhere else does either —
-- the JS side can only assert what reaches the wire (tests/admin.test.js, plus
-- the stubbed-client run recorded in §11aj). The first real proof that the
-- predicate is right is the row count the button reports the first time an admin
-- presses it. That is a known gap, stated rather than papered over.
do $$
declare
  sig_count integer;
  is_definer boolean;
  arg_count integer;
begin
  select count(*) into sig_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_reset_today_for_everyone';
  if sig_count <> 1 then
    raise exception 'expected exactly 1 admin_reset_today_for_everyone signature, found %', sig_count;
  end if;

  select p.prosecdef, p.pronargs into is_definer, arg_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_reset_today_for_everyone';
  if not is_definer then
    raise exception 'admin_reset_today_for_everyone must be security definer';
  end if;

  -- Exactly one argument, and it must be defaulted. More than one means somebody
  -- has started passing the day in, which is the change this whole design exists
  -- to prevent; zero means the rollover guard was dropped.
  if arg_count <> 1 then
    raise exception 'admin_reset_today_for_everyone must take exactly 1 argument (the rollover guard), found %', arg_count;
  end if;

  if has_function_privilege('anon', 'public.admin_reset_today_for_everyone(date)', 'execute') then
    raise exception 'anon must not be able to execute admin_reset_today_for_everyone';
  end if;

  -- Read from the stored definition rather than by CALLING admin_overview():
  -- the SQL Editor runs with no JWT, so auth.uid() is null, is_admin() is false,
  -- and the call would raise for the very admin applying this migration.
  if (select pg_get_functiondef(p.oid) not like '%claimed_today%'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_overview') then
    raise exception 'admin_overview() is missing claimed_today';
  end if;

  raise notice 'Migration 020 self-test passed. Reset function is definer-only, single-signature, anon-denied; overview reports claimed_today.';
end $$;
