-- ---------------------------------------------------------------------------
-- 025 — A claim is for TODAY, exactly (DESIGN.md §11ao)
-- ---------------------------------------------------------------------------
-- TIGHTENS 024, WHICH WAS MINE AND WAS TOO LOOSE. 024 allowed `play_date`
-- within a day either side of `game_today()`, reasoning that the client derives
-- the game day from the BROWSER's clock (`gameDayFor(new Date())`) and would
-- disagree with the server for a few seconds around the 19:00 New York
-- boundary — the busiest moment of the day — so an exact match would turn
-- ordinary clock skew into a lockout.
--
-- That reasoning was sound and the remedy was wrong. It bought skew tolerance
-- by leaving a day of pre-claiming open, and a player promptly walked into it:
-- the seeds are server-minted now (024 works — they came out random), but he
-- could still sit on tomorrow's row. Harmless in scoring terms, since there is
-- no reroll and knowing a seed early buys nothing the in-game EV solver does
-- not already tell you. It is still the schema letting somebody do a thing the
-- game does not mean to offer, and "not exploitable yet" is a bad place to
-- leave a boundary.
--
-- THE FIX IS TO REMOVE THE SKEW, NOT TO PICK A SIDE OF IT. The date is pinned
-- exactly here, and `claimTodaySeed` now catches this specific rejection, asks
-- the server what day it is via the `game_today()` RPC, and retries once. The
-- normal path is unchanged and costs no extra round trip; only a client whose
-- clock actually disagrees pays for one, and it self-heals instead of failing.
--
-- Still REJECT rather than rewrite, for the reason 024 gave: the client reads
-- its row back with `.eq('play_date', <its own answer>)`, so silently storing a
-- different date than the one asked for means the next load finds nothing,
-- claims again, collides on the primary key, and serves §11ak's "we could not
-- fetch your hand" screen. Loud and recoverable beats silent and wrong.
--
-- DEPLOY ORDER. Run this AFTER the client carrying the retry is live, or a
-- player whose clock is off has no recovery path — they simply cannot claim.
-- The old client fails closed rather than dangerously, so the order is about
-- avoiding a bad few minutes, not about correctness.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

create or replace function public.enforce_server_dealt_hand()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Unchanged from 024: PostgREST sets the role per request, so this
  -- distinguishes a browser from the Edge Function, the SQL editor and the
  -- admin RPCs. Migration 022's self-test inserts a 1999 date and cleans up by
  -- it; without the exemption it would write a live row for today against a
  -- real account and then lose track of it.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Whatever the client sent is discarded, not validated. There is no request
  -- shape that gets a chosen seed through.
  new.seed := public.mint_daily_seed();

  -- EXACTLY today. See the header for why this is no longer a window.
  if new.play_date <> public.game_today() then
    raise exception 'play_date % is not the current game day (%)',
      new.play_date, public.game_today()
      using errcode = 'check_violation',
            hint = 'The client should re-read game_today() and retry.';
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Behavioural self-test
-- ---------------------------------------------------------------------------
-- The assertion that matters is the one 024 could not make: tomorrow is now
-- refused. Becomes `authenticated` and sets the JWT claim RLS reads, because a
-- test that never reaches the trigger passes for the wrong reason.
do $$
declare
  victim     uuid;
  today_ok   boolean;
  tomorrow_ok boolean;
  had_today  boolean;
begin
  select id into victim from auth.users limit 1;
  if victim is null then
    raise notice 'Migration 025 applied. No accounts exist yet, so the behavioural self-test was skipped — the pin itself is in force.';
    return;
  end if;

  -- NEVER touch a real claimed row. If this account already has today's hand,
  -- the today-half of the test would either collide or destroy their run, so
  -- it is skipped and only the tomorrow-half runs.
  select exists (
    select 1 from public.daily_plays
     where user_id = victim and play_date = public.game_today()
  ) into had_today;

  delete from public.daily_plays
   where user_id = victim and play_date = public.game_today() + 1;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', victim)::text, true);
    set local role authenticated;

    begin
      insert into public.daily_plays (user_id, play_date, seed)
      values (victim, public.game_today() + 1, 2316669);
      tomorrow_ok := true;
    exception when others then
      tomorrow_ok := false;
    end;

    if had_today then
      today_ok := true;  -- not exercised; see above
    else
      begin
        insert into public.daily_plays (user_id, play_date, seed)
        values (victim, public.game_today(), 2316669);
        today_ok := true;
      exception when others then
        today_ok := false;
      end;
    end if;

    reset role;
  exception when others then
    reset role;
    raise;
  end;

  -- Clean up BEFORE asserting, so a failure cannot leave rows behind. Today's
  -- row is only removed if this test is what created it.
  delete from public.daily_plays
   where user_id = victim and play_date = public.game_today() + 1;
  if not had_today then
    delete from public.daily_plays
     where user_id = victim and play_date = public.game_today();
  end if;

  if tomorrow_ok then
    raise exception '025 self-test: a claim for TOMORROW was accepted. The pin is not being enforced.';
  end if;
  if not today_ok then
    raise exception '025 self-test: a claim for TODAY was refused. The pin is too tight and nobody can play.';
  end if;

  raise notice 'Migration 025 self-test passed. Today is claimable, tomorrow is refused.';
end $$;

-- ---------------------------------------------------------------------------
-- Remove the rows already parked on future days
-- ---------------------------------------------------------------------------
-- Unplayed only, exactly as 024. A player simply re-claims on the day and is
-- dealt an honest hand; nobody's recorded score is touched.
do $$
declare gone int;
begin
  delete from public.daily_plays
   where result is null
     and play_date > public.game_today();
  get diagnostics gone = row_count;
  raise notice 'Migration 025 cleanup: % future-dated claim(s) removed.', gone;
end $$;

-- ---------------------------------------------------------------------------
-- Afterwards: should return no rows, now and from here on
-- ---------------------------------------------------------------------------
select user_id, play_date, seed, created_at
  from public.daily_plays
 where play_date > public.game_today()
 order by play_date;
