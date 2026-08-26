-- ---------------------------------------------------------------------------
-- 022 — A stacked deal must never cost a player their hand (DESIGN.md §11al)
-- ---------------------------------------------------------------------------
-- FIXES A BUG 021 SHIPPED. `attach_stacked_deal` runs inside the INSERT that
-- claims the day's seed, so anything it raises aborts that INSERT. The client
-- sees a 409, `claimTodaySeed` throws, and the board refuses to deal at all
-- (§11ak's connection-failure screen) — a player locked out of the day by a
-- feature that is meant to be a surprise for someone else.
--
-- Reproduced exactly: queue a deal, claim a hand (the deal attaches to that
-- day), reset the day (020 or admin_reset_day), queue another deal. There is
-- now a QUEUED row and an ATTACHED row for the same player and the same date,
-- and the trigger's `set play_date = new.play_date` violates
-- `stacked_deals_attached_idx`. That is a normal admin workflow, not an abuse.
--
-- TWO INDEPENDENT FIXES, because either one alone leaves a real hole:
--
--   1. The stale attached row is REPLACED rather than collided with. When a day
--      is reset, the hand that row described no longer exists, so keeping it and
--      refusing the new one preserves the wrong thing.
--   2. The whole body FAILS OPEN. Even with (1), any future error in here —
--      a constraint added later, a column type change, a permissions surprise —
--      would once again take out the claim. A rigging feature must never be
--      able to stop somebody playing, so it now logs and gets out of the way.
--
-- (2) is the load-bearing one. (1) fixes the failure we found; (2) fixes the
-- class, including the next one nobody has thought of.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

create or replace function public.attach_stacked_deal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    -- The day being claimed is a FRESH day from the player's point of view —
    -- either they have never played it, or it was reset. Any deal still
    -- attached to it describes a hand that no longer exists, so it goes.
    delete from public.stacked_deals
     where user_id = new.user_id
       and play_date = new.play_date;

    update public.stacked_deals
       set play_date = new.play_date,
           attached_at = now()
     where user_id = new.user_id
       and play_date is null;
  exception
    when others then
      -- FAIL OPEN, LOUDLY. The player gets an ordinary hand — which the server
      -- also scores as an ordinary hand, because submit-run looks for the same
      -- attached row and will not find one either. The two halves stay in
      -- agreement, which is the property that actually matters (§11al); the
      -- only thing lost is the surprise.
      raise warning 'attach_stacked_deal skipped for user % on %: %', new.user_id, new.play_date, sqlerrm;
  end;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Clean up any rows already wedged by the 021 version
-- ---------------------------------------------------------------------------
-- Drops deals attached to a day that no longer has a claimed row — exactly the
-- state a day reset leaves behind, and the state that was blocking the claim.
-- Queued deals (play_date is null) are deliberately untouched: they have not
-- been used yet and should still land on the player's next hand.
delete from public.stacked_deals sd
 where sd.play_date is not null
   and not exists (
     select 1 from public.daily_plays dp
      where dp.user_id = sd.user_id
        and dp.play_date = sd.play_date
   );

-- ---------------------------------------------------------------------------
-- Self-test
-- ---------------------------------------------------------------------------
-- Behavioural this time, and it can be: the whole point is that the trigger
-- does not raise, so exercising it is safe as long as the rows are removed
-- afterwards. A structural check could not tell the fixed version from the
-- broken one — both are `security definer` functions with the right name.
do $$
declare
  victim uuid;
  claimed boolean;
begin
  -- Deliberately an account with NO queued deal. `stacked_deals_pending_idx`
  -- allows one queued row per player, so testing against someone who already
  -- has one would either raise here or destroy a deal the owner is waiting to
  -- spring on them. A self-test must not be able to damage real state.
  select u.id into victim
    from auth.users u
   where not exists (
     select 1 from public.stacked_deals s where s.user_id = u.id and s.play_date is null
   )
   limit 1;
  if victim is null then
    raise notice 'Migration 022 applied. No account without a queued deal was available, so the behavioural self-test was skipped — the fix itself is in force.';
    return;
  end if;

  -- Build the exact collision 021 died on: an attached row and a queued row
  -- for the same player and the same day.
  delete from public.daily_plays where user_id = victim and play_date = date '1999-01-01';
  delete from public.stacked_deals where user_id = victim and play_date = date '1999-01-01';
  delete from public.stacked_deals where user_id = victim and play_date is null and cards ? '__selftest';

  insert into public.stacked_deals (user_id, play_date, cards)
  values (victim, date '1999-01-01', '{"__selftest": true}'::jsonb);
  insert into public.stacked_deals (user_id, cards)
  values (victim, '{"__selftest": true}'::jsonb);

  -- THIS is what used to raise 23505 and abort the claim.
  begin
    insert into public.daily_plays (user_id, play_date, seed)
    values (victim, date '1999-01-01', 1);
    claimed := true;
  exception
    when others then
      claimed := false;
  end;

  -- Clean up before asserting, so a failure cannot leave test rows behind.
  delete from public.daily_plays where user_id = victim and play_date = date '1999-01-01';
  delete from public.stacked_deals where user_id = victim and cards ? '__selftest';

  if not claimed then
    raise exception 'attach_stacked_deal still blocks a claim when a deal is already attached to that day';
  end if;

  raise notice 'Migration 022 self-test passed. A claim now succeeds even with a deal already attached to that day, and the trigger fails open.';
end $$;
