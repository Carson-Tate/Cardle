-- ---------------------------------------------------------------------------
-- 024 — The player must not choose their own hand (DESIGN.md §11am)
-- ---------------------------------------------------------------------------
-- EXPLOITED IN PRODUCTION, not theoretical. Two accounts pre-claimed every day
-- from 2026-08-28 to 2026-09-04 with seed 2316669, which deals
-- K♦ 10♦ Q♦ J♦ A♦ — a pat Royal Flush, bronze rarity on the K for an extra
-- multiplier. One of them had today's row claimed with it and unplayed.
--
-- TWO HOLES, AND THEY ARE NOT EQUALLY IMPORTANT:
--
--   #1 THE SEED WAS CHOSEN BY THE BROWSER. `daily_plays.seed` was supplied by
--      the client's INSERT and the policy constrained only WHO was inserting,
--      never WHAT. `dealHand(seed)` is pure — ranks, suits, rarity tiers and
--      wild flags all fall out of that one number — so anyone can import the
--      shipped deck.js, grind ~4.3e9 seeds for a Royal Flush (seconds), and
--      claim it. This is the vulnerability.
--
--   #2 `play_date` WAS UNBOUNDED, so one grind covered a year in one INSERT.
--      This is the amplifier, not the hole. Closing it alone leaves the
--      exploit fully working at one INSERT per night.
--
-- The bitter part: schema.sql:165-172 already carried a seven-line comment
-- explaining why `seed` must be write-once, and the column grants below it
-- genuinely deliver that. Write-once was the wrong property. The first write
-- is the only one an attacker wants. verify-run.js:7-9 calls the seed "the one
-- thing the player cannot forge" and built the entire server-authoritative
-- design (§11z) on top of that sentence.
--
-- WHY THIS ONE RUNS ITS OWN CLEANUP INSTEAD OF ASKING YOU TO. Migration 015
-- left its two `revoke` lines commented out as a deliberate second step, and
-- they were never run — which is why an arbitrary-score hole sat open for
-- months alongside this one. A step that only exists in a comment is a step
-- that does not happen. The cleanup below deletes only UNPLAYED rows, which is
-- exactly what admin_reset_day already does, so it is safe to run itself.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Mint the seed server-side
-- ---------------------------------------------------------------------------
-- `gen_random_uuid()` is v4 and CSPRNG-backed on PG13+, so its first 32 bits
-- are a better source than `random()` (per-backend, seeded, and in principle
-- predictable to anyone who can observe enough draws). Masked back down to
-- [0, 2^32) because `createRng` is mulberry32 over `seed >>> 0` — a wider
-- value would silently collapse onto a 32-bit state anyway, and matching
-- `freshSeed()`'s range keeps every stored seed the same shape as the
-- millions already in the table.
create or replace function public.mint_daily_seed()
returns bigint
language sql
volatile
set search_path = public
as $$
  select (('x' || substr(gen_random_uuid()::text, 1, 8))::bit(32)::bigint) & 4294967295;
$$;

-- A DEFAULT as well as the trigger, deliberately. If the trigger is ever
-- dropped — by a later migration, a restore, a hand-edit — the column still
-- cannot be null and still does not take a client value silently. Defence in
-- depth costs one line here.
alter table public.daily_plays
  alter column seed set default public.mint_daily_seed();

create or replace function public.enforce_server_dealt_hand()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Privileged callers are exempt. PostgREST does `SET LOCAL ROLE` per
  -- request, so `current_user` is 'authenticated'/'anon' for anything that
  -- came from a browser and 'service_role'/'postgres' for the Edge Function,
  -- the SQL editor and the admin RPCs. Without this exemption, migration
  -- 022's self-test (which inserts play_date '1999-01-01') would silently
  -- write a REAL row for today against a real account and then fail to clean
  -- it up, because its DELETE looks for the date it asked for.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- #1. Whatever the client sent is discarded. Not validated, not rejected —
  -- overwritten, so there is no shape of request that gets a chosen value
  -- through, and the client needs no change to keep working.
  new.seed := public.mint_daily_seed();

  -- #2. A ±1 day window rather than a hard pin to game_today().
  --
  -- REJECTING is right and REWRITING would be a bug: the client reads its row
  -- back with `.eq('play_date', <its own gameDayFor()>)`, so silently storing
  -- a different date than the one it asked for means the next page load finds
  -- no row, tries to claim again, collides on the primary key, and hands the
  -- player §11ak's "we could not fetch your hand" screen. Loud beats silent.
  --
  -- The window is ±1 day rather than exact because client and server compute
  -- the game day from two different clocks, and they disagree for a few
  -- seconds either side of the 19:00 New York boundary — which is the busiest
  -- moment of the day. An exact match would turn ordinary clock skew into a
  -- lockout at exactly the wrong time.
  --
  -- One day of slack is harmless now and would NOT have been before: the whole
  -- value of pre-claiming was pairing it with a chosen seed. Against a seed
  -- the player cannot influence, claiming tomorrow buys nothing — there is no
  -- reroll, so an early claim just fixes an unknown hand slightly sooner.
  if new.play_date < public.game_today() - 1
     or new.play_date > public.game_today() + 1 then
    raise exception 'play_date % is outside the claimable window (game day is %)',
      new.play_date, public.game_today()
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists enforce_server_dealt_hand on public.daily_plays;
create trigger enforce_server_dealt_hand
  before insert on public.daily_plays
  for each row execute function public.enforce_server_dealt_hand();

-- ---------------------------------------------------------------------------
-- 2. Behavioural self-test
-- ---------------------------------------------------------------------------
-- §11al's lesson, applied: a structural check ("does the trigger exist") is
-- true of both the fixed version and the broken one. The only assertion worth
-- making is that a client-shaped INSERT does not get the seed it asked for —
-- so this actually becomes `authenticated`, sets the JWT claim RLS reads, and
-- tries the exploit.
do $$
declare
  victim      uuid;
  probe_date  date := public.game_today() + 1;
  stored_seed bigint;
  rigged      constant bigint := 2316669;  -- the real one: K♦ 10♦ Q♦ J♦ A♦
  far_ok      boolean;
begin
  select id into victim from auth.users limit 1;
  if victim is null then
    raise notice 'Migration 024 applied. No accounts exist yet, so the behavioural self-test was skipped — the trigger itself is in force.';
    return;
  end if;

  delete from public.daily_plays where user_id = victim and play_date = probe_date;

  begin
    -- Become a browser: the role PostgREST switches to, plus the claim
    -- `auth.uid()` reads. Without both, the insert policy refuses and the test
    -- would pass for the wrong reason.
    perform set_config('request.jwt.claims', json_build_object('sub', victim)::text, true);
    set local role authenticated;

    insert into public.daily_plays (user_id, play_date, seed)
    values (victim, probe_date, rigged);

    select seed into stored_seed
      from public.daily_plays
     where user_id = victim and play_date = probe_date;

    -- The 365-day batch, which is what actually happened.
    begin
      insert into public.daily_plays (user_id, play_date, seed)
      values (victim, public.game_today() + 30, rigged);
      far_ok := true;
    exception when others then
      far_ok := false;
    end;

    reset role;
  exception when others then
    reset role;
    raise;
  end;

  -- Clean up BEFORE asserting, so a failure cannot leave rows behind (§11al).
  delete from public.daily_plays
   where user_id = victim
     and play_date in (probe_date, public.game_today() + 30);

  if stored_seed is null then
    raise exception '024 self-test: the claim did not land at all — check the insert policy, not the trigger';
  end if;
  if stored_seed = rigged then
    raise exception '024 self-test: the client-supplied seed WAS STORED. The trigger is not firing for role authenticated.';
  end if;
  if far_ok then
    raise exception '024 self-test: a claim 30 days out was accepted. The play_date window is not being enforced.';
  end if;

  raise notice 'Migration 024 self-test passed. A browser-shaped claim had its seed replaced (asked for %, stored %) and a 30-day-out claim was refused.', rigged, stored_seed;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Remove the rigged claims
-- ---------------------------------------------------------------------------
-- ONLY unplayed rows (`result is null`). A finished run is somebody's real
-- score and is not ours to delete here; §11ak also established that a null
-- result can mean "submission in flight", but that window is seconds and these
-- rows are days old, so a claim for a FUTURE day cannot be one.
--
-- Deleting an unplayed row is not a punishment — the player simply re-claims
-- and is dealt an honest hand by the trigger above. That is why this runs
-- before anyone can grind a new seed rather than being left as a manual step.
do $$
declare
  future_gone int;
  dupes_gone  int;
begin
  -- (a) Every future-dated claim. The client only ever claims its own game
  -- day, so a row beyond tomorrow was placed by hand, without exception.
  delete from public.daily_plays
   where result is null
     and play_date > public.game_today() + 1;
  get diagnostics future_gone = row_count;

  -- (b) Repeated seeds. Honest seeds are 32-bit random, so across a table this
  -- size a collision is vanishingly unlikely — a duplicate IS the signature of
  -- a hand-picked value. Scoped to unplayed rows, so a genuine 1-in-millions
  -- collision costs somebody a re-deal at worst, never a recorded score.
  delete from public.daily_plays
   where result is null
     and seed in (
       select seed from public.daily_plays group by seed having count(*) > 1
     );
  get diagnostics dupes_gone = row_count;

  raise notice 'Migration 024 cleanup: % future-dated claim(s) and % duplicate-seed claim(s) removed.', future_gone, dupes_gone;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Afterwards: confirm nothing rigged survived, and check what already paid
-- ---------------------------------------------------------------------------
-- Should return no rows.
select user_id, play_date, seed, created_at
  from public.daily_plays
 where play_date > public.game_today() + 1
 order by play_date;

-- Should return no rows.
select seed, count(*) as claims, array_agg(distinct user_id) as accounts
  from public.daily_plays
 group by seed having count(*) > 1
 order by claims desc;

-- A Royal Flush scores around 54,800,000. Anything in that range that was
-- stored BEFORE this migration ran needs looking at by hand — the fix stops
-- new rigging, it cannot un-rig a run that already banked.
select user_id, play_date, seed,
       (result->'score'->>'total')::numeric as total,
       (result->>'verified')::boolean       as server_scored,
       created_at
  from public.daily_plays
 where result is not null
 order by total desc nulls last
 limit 20;
