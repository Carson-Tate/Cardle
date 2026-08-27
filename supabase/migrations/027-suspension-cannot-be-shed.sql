-- ---------------------------------------------------------------------------
-- 027 — A suspension cannot be shed by the suspended (DESIGN.md §11aq)
-- ---------------------------------------------------------------------------
-- Owner: "make sure there is no way to get around it or lift it themselves."
--
-- Audited every path. The write protections in 026 hold — `suspensions` has no
-- INSERT/UPDATE/DELETE policy and RLS is on, so those are denied regardless of
-- grants, and `admin_lift_suspension` re-checks `is_admin()` in the database
-- against a column players cannot write (§11f's column grant). The self-test at
-- the bottom now PROVES that by attempting each one as the player rather than
-- asserting it in a comment.
--
-- ONE REAL BYPASS, AND IT WAS A BUTTON IN THE PRODUCT. `delete_own_account()`
-- deletes the `auth.users` row, and `suspensions.user_id` references
-- `profiles(id) on delete cascade` — which cascades from `auth.users`. So a
-- suspended player could open their own profile page, click Delete Account, and
-- sign up again with the same email onto a clean slate. Not an exploit anyone
-- had to find: it is the most obvious button on the page they were looking at.
--
-- Deletion is refused while suspended. THE ADMIN IS THE ESCAPE HATCH — lifting
-- the suspension restores the ability to delete — so this is not a permanent
-- trap for somebody who genuinely wants their data gone, even under a permanent
-- ban. That is a deliberate choice to keep a human in the loop rather than
-- either trapping them forever or letting the ban be one click from gone.
--
-- WHAT THIS STILL DOES NOT STOP, stated rather than implied:
--   * A brand-new account on a different email. Nothing short of device or
--     payment fingerprinting stops that, and the deterrent is real anyway —
--     they start at level 1 with no history, streak or cosmetics.
--   * Playing signed OUT. That path is local-only (persistence.js), never
--     inserts a `daily_plays` row and can never reach a leaderboard, so a
--     suspended player amusing themselves offline costs nothing.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'delete_own_account() requires an authenticated session';
  end if;

  -- THE BAN EVASION GUARD (§11aq). Everything about this account cascades from
  -- the auth.users row below — including its suspension — so without this the
  -- Delete Account button is a one-click pardon.
  if public.is_suspended(caller) then
    raise exception 'account is suspended and cannot be deleted'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an admin to lift the suspension first.';
  end if;

  delete from auth.users where id = caller;
end $$;

revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Self-test: try every way out, as the player
-- ---------------------------------------------------------------------------
-- This is the migration's whole point. §11am's lesson was that a comment
-- asserting a security property is the reason nobody checks it — so each escape
-- route is ATTEMPTED here as `authenticated`, with the JWT claim RLS reads, and
-- the migration fails loudly if any of them works.
--
-- `delete_own_account()` is the dangerous one to test, because a broken guard
-- means really deleting a real account. It is called inside a PL/pgSQL
-- subtransaction that is then deliberately aborted, so the delete is rolled
-- back either way; the flag recording what happened is a plain variable, and
-- variable assignments are not transactional.
do $$
declare
  victim        uuid;
  wrote         boolean := false;
  updated_rows  int := 0;
  deleted_rows  int := 0;
  lifted        boolean := false;
  self_suspended boolean := false;
  account_gone  boolean := false;
begin
  select p.id into victim
    from public.profiles p
   where not p.is_admin
     and not exists (select 1 from public.suspensions s where s.user_id = p.id and s.lifted_at is null)
   limit 1;
  if victim is null then
    raise notice 'Migration 027 applied. No unsuspended non-admin account was available, so the bypass self-test was skipped — the guard itself is in force.';
    return;
  end if;

  insert into public.suspensions (user_id, suspended_until, reason)
  values (victim, now() + interval '1 hour', '__selftest027');

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', victim)::text, true);
    set local role authenticated;

    -- 1. Write themselves a lifted row.
    begin
      insert into public.suspensions (user_id, suspended_until, lifted_at)
      values (victim, null, now());
      wrote := true;
    exception when others then
      wrote := false;
    end;

    -- 2. Lift the one they have.
    begin
      update public.suspensions set lifted_at = now() where user_id = victim;
      get diagnostics updated_rows = row_count;
    exception when others then
      updated_rows := 0;
    end;

    -- 3. Delete it outright.
    begin
      delete from public.suspensions where user_id = victim;
      get diagnostics deleted_rows = row_count;
    exception when others then
      deleted_rows := 0;
    end;

    -- 4. Call the admin lift RPC directly, skipping the UI entirely.
    begin
      perform public.admin_lift_suspension(victim);
      lifted := true;
    exception when others then
      lifted := false;
    end;

    -- 5. Suspend somebody (here, themselves) — i.e. is the admin gate real.
    begin
      perform public.admin_suspend_player(victim, now() + interval '1 day', 'x');
      self_suspended := true;
    exception when others then
      self_suspended := false;
    end;

    -- 6. Delete the account to shed the ban. Aborted either way; see the header.
    begin
      perform public.delete_own_account();
      account_gone := true;              -- NOT refused — the guard is broken
      raise exception 'selftest027_rollback';
    exception when others then
      if sqlerrm <> 'selftest027_rollback' then
        account_gone := false;           -- refused, which is what we want
      end if;
    end;

    reset role;
  exception when others then
    reset role;
    raise;
  end;

  -- Clean up BEFORE asserting (§11al), so a failure leaves nothing behind.
  delete from public.suspensions where user_id = victim and reason = '__selftest027';
  delete from public.suspensions where user_id = victim and reason = 'x';

  if wrote then
    raise exception '027 self-test: a player INSERTED their own suspensions row.';
  end if;
  if updated_rows > 0 then
    raise exception '027 self-test: a player UPDATED their own suspension (% rows).', updated_rows;
  end if;
  if deleted_rows > 0 then
    raise exception '027 self-test: a player DELETED their own suspension (% rows).', deleted_rows;
  end if;
  if lifted then
    raise exception '027 self-test: a non-admin successfully called admin_lift_suspension.';
  end if;
  if self_suspended then
    raise exception '027 self-test: a non-admin successfully called admin_suspend_player.';
  end if;
  if account_gone then
    raise exception '027 self-test: a SUSPENDED player was able to delete their account (rolled back). Ban evasion is still open.';
  end if;

  raise notice 'Migration 027 self-test passed. A suspended player cannot insert, update, delete, lift, self-suspend, or delete their account to escape.';
end $$;
