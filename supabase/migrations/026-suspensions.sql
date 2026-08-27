-- ---------------------------------------------------------------------------
-- 026 — Temporary suspensions (DESIGN.md §11ap)
-- ---------------------------------------------------------------------------
-- Owner request: suspend a player from playing for a chosen length of time,
-- lift it early, and show them a red banner saying when it ends.
--
-- NOT A COLUMN ON `profiles`, and that is the whole privacy decision. That
-- table's select policy is `using (true)` — world-readable to every signed-in
-- player — so a `suspended_until` column there would publish who is banned to
-- anyone who opened devtools. §11ac's lesson, met for the third time: opening a
-- feature is not the same as opening a table, and every column added to a
-- permissive one comes along for free. Its own table with an own-rows-only
-- select policy means the suspended player is told, and nobody else learns
-- anything.
--
-- ENFORCED IN THE DATABASE, NOT THE CLIENT. Claiming a hand is a plain browser
-- INSERT into `daily_plays`, so a client-side check is bypassable by precisely
-- the person being suspended. The check goes in `enforce_server_dealt_hand` —
-- the before-insert trigger that already guards that path — and again in
-- `submit-run`, so a player who claimed before the ban landed cannot bank the
-- run afterwards. The client check that renders the banner is presentation.
--
-- HISTORY IS KEPT. Lifting sets `lifted_at` rather than deleting, and issuing a
-- new suspension lifts the previous one first, so "has this person been
-- suspended before" stays answerable. `suspensions_active_idx` makes the rule
-- explicit: at most one un-lifted row per player.
--
-- `suspended_until is null` means PERMANENT — a row with no end date. That is
-- distinct from having no row at all, which is the normal state.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

create table if not exists public.suspensions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade not null,
  -- null = permanent. Checked against now() at read time, never by a job, so a
  -- suspension expires on its own with nothing to run and nothing to go wrong.
  suspended_until timestamptz,
  -- Rendered in the suspended player's browser, so it is length-capped here as
  -- well as escaped there. §11y's rule: admin-authored content is untrusted
  -- content, not because admins are hostile but because "one compromised admin
  -- becomes markup in a session" is a real path.
  reason text check (reason is null or length(reason) <= 200),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  lifted_at timestamptz
);

alter table public.suspensions enable row level security;

-- The suspended player reads their own row and nothing else. Admin reads go
-- through the security-definer function below, not through this policy.
drop policy if exists "Players can read their own suspension" on public.suspensions;
create policy "Players can read their own suspension"
  on public.suspensions for select
  using (auth.uid() = user_id);

-- No write policy of any kind, plus the grants revoked: §11g's discipline of
-- leaving exactly one authorised write path (the definer functions) rather than
-- two that could drift apart.
revoke insert, update, delete on public.suspensions from authenticated, anon;

create unique index if not exists suspensions_active_idx
  on public.suspensions (user_id)
  where lifted_at is null;

-- ---------------------------------------------------------------------------
-- is_suspended()
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER ON PURPOSE, which is the opposite of most helpers here.
-- `security definer` would let any signed-in player call
-- `is_suspended('<somebody-else>')` over PostgREST and get a truthful answer —
-- handing back exactly the private fact the separate table exists to protect.
-- As invoker, RLS applies: a player can only ever learn about themselves, which
-- is the only question they are entitled to ask. The trigger below runs as the
-- inserting player checking their OWN id, so invoker is sufficient there; and
-- `submit-run` uses the service role, which bypasses RLS and sees everything.
--
-- §11j established when NOT to elevate: elevate only where the caller must do
-- something they cannot. Here they must not.
create or replace function public.is_suspended(target uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.suspensions
     where user_id = target
       and lifted_at is null
       and (suspended_until is null or suspended_until > now())
  );
$$;

grant execute on function public.is_suspended(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Refuse the claim while suspended
-- ---------------------------------------------------------------------------
-- Extends 025's trigger rather than adding a second one, so there is a single
-- place that decides whether a row may be claimed and no ordering question
-- between two triggers.
create or replace function public.enforce_server_dealt_hand()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- CHECKED BEFORE ANYTHING ELSE. A suspended player should be told they are
  -- suspended, not told their clock is wrong.
  if public.is_suspended(new.user_id) then
    raise exception 'account is suspended'
      using errcode = 'insufficient_privilege',
            hint = 'The client should read its own suspensions row and show the banner.';
  end if;

  new.seed := public.mint_daily_seed();

  if new.play_date <> public.game_today() then
    raise exception 'play_date % is not the current game day (%)',
      new.play_date, public.game_today()
      using errcode = 'check_violation',
            hint = 'The client should re-read game_today() and retry.';
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Admin: suspend, lift, and read
-- ---------------------------------------------------------------------------
create or replace function public.admin_suspend_player(
  target_id uuid,
  until timestamptz default null,
  reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text := nullif(btrim(coalesce(reason, '')), '');
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = target_id) then
    raise exception 'no such player';
  end if;
  -- NOBODY CAN SUSPEND AN ADMIN, which includes you suspending yourself. A
  -- suspended admin can still reach this function (it only blocks playing), so
  -- this is a footgun guard rather than a security boundary — but locking
  -- yourself out of your own game is a bad afternoon either way.
  if exists (select 1 from public.profiles where id = target_id and is_admin) then
    raise exception 'admins cannot be suspended';
  end if;
  -- A past end date is silently no suspension at all, which would look exactly
  -- like the feature being broken. Refuse it (§11al: refusal beats repair).
  if until is not null and until <= now() then
    raise exception 'the suspension end must be in the future';
  end if;
  if cleaned is not null and length(cleaned) > 200 then
    raise exception 'the reason must be 200 characters or fewer';
  end if;

  -- Replace rather than collide: re-suspending someone already suspended is a
  -- normal admin action (extending, or correcting a mistake), and the partial
  -- unique index would otherwise reject it.
  update public.suspensions
     set lifted_at = now()
   where user_id = target_id and lifted_at is null;

  insert into public.suspensions (user_id, suspended_until, reason, created_by)
  values (target_id, until, cleaned, auth.uid());
end $$;

create or replace function public.admin_lift_suspension(target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.suspensions
     set lifted_at = now()
   where user_id = target_id and lifted_at is null;
end $$;

-- The admin panel needs to see somebody else's suspension, which the select
-- policy deliberately forbids — so this is the elevated path, and it enumerates
-- its own output columns rather than returning the row, per §11ac.
create or replace function public.admin_player_suspension(target_id uuid)
returns table (
  suspended_until timestamptz,
  reason text,
  created_at timestamptz,
  is_active boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.suspended_until,
         s.reason,
         s.created_at,
         (s.suspended_until is null or s.suspended_until > now()) as is_active
    from public.suspensions s
   where s.user_id = target_id
     and s.lifted_at is null
     and public.is_admin()
   limit 1;
$$;

grant execute on function public.admin_suspend_player(uuid, timestamptz, text) to authenticated;
grant execute on function public.admin_lift_suspension(uuid) to authenticated;
grant execute on function public.admin_player_suspension(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Behavioural self-test
-- ---------------------------------------------------------------------------
-- Asserts the thing that matters and its opposite: a suspended player cannot
-- claim, and an unsuspended one still can. A test that only checked the first
-- would pass against a trigger that blocks everybody.
do $$
declare
  victim      uuid;
  claimed_while_banned boolean;
  claimed_after_lift   boolean;
  had_today   boolean;
begin
  select p.id into victim
    from public.profiles p
   where not p.is_admin
     and not exists (select 1 from public.suspensions s where s.user_id = p.id and s.lifted_at is null)
   limit 1;
  if victim is null then
    raise notice 'Migration 026 applied. No unsuspended non-admin account was available, so the behavioural self-test was skipped — the trigger itself is in force.';
    return;
  end if;

  select exists (
    select 1 from public.daily_plays where user_id = victim and play_date = public.game_today()
  ) into had_today;
  if had_today then
    raise notice 'Migration 026 applied. The sample account already has today''s hand, so the self-test was skipped rather than risk their run.';
    return;
  end if;

  insert into public.suspensions (user_id, suspended_until, reason)
  values (victim, now() + interval '1 hour', '__selftest');

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', victim)::text, true);
    set local role authenticated;

    begin
      insert into public.daily_plays (user_id, play_date, seed) values (victim, public.game_today(), 1);
      claimed_while_banned := true;
    exception when others then
      claimed_while_banned := false;
    end;

    reset role;
  exception when others then
    reset role;
    raise;
  end;

  -- Lift it, then prove play comes back.
  update public.suspensions set lifted_at = now()
   where user_id = victim and reason = '__selftest' and lifted_at is null;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', victim)::text, true);
    set local role authenticated;

    begin
      insert into public.daily_plays (user_id, play_date, seed) values (victim, public.game_today(), 1);
      claimed_after_lift := true;
    exception when others then
      claimed_after_lift := false;
    end;

    reset role;
  exception when others then
    reset role;
    raise;
  end;

  -- Clean up BEFORE asserting (§11al), so a failure leaves nothing behind.
  delete from public.daily_plays where user_id = victim and play_date = public.game_today();
  delete from public.suspensions where user_id = victim and reason = '__selftest';

  if claimed_while_banned then
    raise exception '026 self-test: a SUSPENDED player was able to claim a hand. The trigger is not enforcing.';
  end if;
  if not claimed_after_lift then
    raise exception '026 self-test: an UNSUSPENDED player could not claim a hand. The trigger is blocking everybody.';
  end if;

  raise notice 'Migration 026 self-test passed. A suspended player is refused, and lifting it restores play.';
end $$;
