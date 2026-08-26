-- ---------------------------------------------------------------------------
-- 021 — Stacked deals (DESIGN.md §11al)
-- ---------------------------------------------------------------------------
-- Lets an admin choose the exact cards a specific player is dealt on their
-- NEXT hand — the five they open with, and the first few that come back if
-- they discard. Owner request: "make a thing where i can set someones cards
-- for the next reset they do... i want to give them the exact hand that draws
-- and if they discard some, i can pick what they get from that discard."
--
-- WHY THIS IS NOT A COLUMN ON daily_plays. Migration 006 added
--   using (result is not null)
-- as a TABLE-level select policy, so every signed-in player can read every
-- column of every finished run. A `stacked_deal` column there would publish
-- "this run was rigged" to anyone who opened devtools — the exact §11ac
-- lesson ("opening a feature is not the same as opening a table", and "every
-- column added to it in future" comes along for the ride). This table's own
-- select policy is own-rows-only, so the player is dealt their cards and
-- nobody else learns anything.
--
-- WHY THE SERVER HAS TO KNOW. Scoring is server-authoritative (§11z):
-- submit-run re-deals from the seed and recomputes the total, ignoring
-- whatever the client says. So a deal that only exists in the browser would be
-- re-scored from the ORDINARY deal and the player would be paid for a hand
-- they never saw. Both halves read this table and build the deal with the same
-- pure function (`dealFromStack`, src/core/deck.js).
--
-- DEPLOY ORDER MATTERS, and it is the one thing this migration cannot enforce:
-- run this, then deploy the updated `submit-run` Edge Function, and only then
-- queue a deal. A stacked deal queued while an OLD function is live will be
-- scored from the ordinary deal.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
-- ONE TABLE, TWO STATES, and the difference is `play_date`:
--   play_date is null  → QUEUED. Waiting for this player's next claim.
--   play_date is set   → ATTACHED. These are the cards for that game day.
-- §11j's warning about a table holding two kinds of row applies, which is why
-- the state is a single nullable column rather than a status string: there is
-- no third value to get wrong, and the partial indexes below make each state's
-- uniqueness rule explicit.
create table if not exists public.stacked_deals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  play_date date,
  cards jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  attached_at timestamptz
);

-- At most one QUEUED deal per player: queueing a second one replaces the
-- first rather than stacking up a hidden pipeline of rigged days.
create unique index if not exists stacked_deals_pending_idx
  on public.stacked_deals (user_id)
  where play_date is null;

-- ...and at most one ATTACHED deal per player per day, matching daily_plays'
-- own primary key.
create unique index if not exists stacked_deals_attached_idx
  on public.stacked_deals (user_id, play_date)
  where play_date is not null;

alter table public.stacked_deals enable row level security;

-- The player may read their OWN deal, because their browser has to draw the
-- cards. Deliberately no insert/update/delete policy for anyone: every write
-- goes through the `security definer` functions below, which leaves exactly
-- one authorized write path instead of a policy and a function that could
-- drift apart (§11g's rule for game_config).
drop policy if exists "Players can read their own stacked deal" on public.stacked_deals;
create policy "Players can read their own stacked deal"
  on public.stacked_deals for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Admins can read every stacked deal" on public.stacked_deals;
create policy "Admins can read every stacked deal"
  on public.stacked_deals for select
  using (public.is_admin());

-- Belt and braces on the write path: even a future permissive policy cannot
-- turn into a write, because the role has no table privilege to exercise.
revoke insert, update, delete on public.stacked_deals from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. Attaching a queued deal to the day the player actually claims
-- ---------------------------------------------------------------------------
-- A TRIGGER, not client code, because the claim is a plain client INSERT into
-- daily_plays (state/daily-play.js) and a browser cannot be trusted to consume
-- its own rigging — a patched page would simply skip it. This fires inside the
-- same statement that claims the seed, so the two can never disagree about
-- which day the cards belong to.
--
-- `security definer` because the queued row is unreachable to the inserting
-- player: they have select on their own rows but no update privilege at all.
create or replace function public.attach_stacked_deal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.stacked_deals
     set play_date = new.play_date,
         attached_at = now()
   where user_id = new.user_id
     and play_date is null;
  return new;
end $$;

drop trigger if exists attach_stacked_deal_on_claim on public.daily_plays;
create trigger attach_stacked_deal_on_claim
  after insert on public.daily_plays
  for each row
  execute function public.attach_stacked_deal();

-- ---------------------------------------------------------------------------
-- 3. Admin actions
-- ---------------------------------------------------------------------------
-- Queues a deal for a player's next hand. Replaces any deal still queued, so
-- the button is idempotent from the admin's point of view: what you last saved
-- is what they get.
--
-- THE SHAPE IS VALIDATED HERE AS WELL AS IN THE CLIENT, for the reason §11x
-- restated: a validation rule the client owns is not a rule. The full
-- rank/suit/rarity check lives in JavaScript (`normalizeStackedDeal`, which
-- both the board and the Edge Function run), but the structural floor — five
-- cards in the hand, at most five draws — is cheap to assert in SQL and stops
-- a malformed row from ever reaching either of them.
create or replace function public.admin_queue_stacked_deal(target_id uuid, deal jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_queue_stacked_deal() requires an admin account';
  end if;

  if deal is null or jsonb_typeof(deal -> 'hand') is distinct from 'array' then
    raise exception 'a stacked deal needs a "hand" array';
  end if;
  if jsonb_array_length(deal -> 'hand') <> 5 then
    raise exception 'the opening hand must be exactly 5 cards';
  end if;
  if deal ? 'draws' and jsonb_typeof(deal -> 'draws') is distinct from 'array' then
    raise exception '"draws" must be an array when present';
  end if;
  if deal ? 'draws' and jsonb_array_length(deal -> 'draws') > 5 then
    raise exception 'at most 5 draw cards can be pinned';
  end if;

  -- Only a QUEUED deal is replaceable. An attached one belongs to a day that
  -- has already been claimed, and rewriting it would change the cards under a
  -- player who may be looking at them right now.
  delete from public.stacked_deals where user_id = target_id and play_date is null;

  insert into public.stacked_deals (user_id, cards, created_by)
  values (target_id, deal, auth.uid());
end $$;

revoke all on function public.admin_queue_stacked_deal(uuid, jsonb) from public, anon;
grant execute on function public.admin_queue_stacked_deal(uuid, jsonb) to authenticated;

-- Cancels a QUEUED deal. Deliberately cannot touch an attached one, for the
-- same reason the queue function cannot rewrite it — and because removing the
-- cards mid-hand would leave the player's board and the server's scorer
-- building different deals, which is the one failure this whole design exists
-- to prevent.
create or replace function public.admin_clear_stacked_deal(target_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if not public.is_admin() then
    raise exception 'admin_clear_stacked_deal() requires an admin account';
  end if;

  delete from public.stacked_deals where user_id = target_id and play_date is null;
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke all on function public.admin_clear_stacked_deal(uuid) from public, anon;
grant execute on function public.admin_clear_stacked_deal(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Self-test
-- ---------------------------------------------------------------------------
-- Structural rather than behavioural, for 020's reason: the behavioural half
-- would mean queueing and attaching real deals on live rows. What is asserted
-- here is everything whose failure would be SILENT — a function that forgot to
-- elevate would quietly write nothing under RLS and still report success, and
-- an exposed table would leak which runs were rigged with no visible symptom.
do $$
declare
  policy_names text[];
  is_definer boolean;
  sig_count integer;
begin
  -- Exactly one signature each: 019's PGRST203 lesson. PostgREST resolves an
  -- RPC by the JSON keys in the body, so an overload is an outage.
  for sig_count in
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('admin_queue_stacked_deal', 'admin_clear_stacked_deal')
     group by p.proname
  loop
    if sig_count <> 1 then
      raise exception 'stacked-deal admin functions must have exactly one signature each, found %', sig_count;
    end if;
  end loop;

  select p.prosecdef into is_definer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attach_stacked_deal';
  if not is_definer then
    raise exception 'attach_stacked_deal() must be security definer, or the trigger silently attaches nothing';
  end if;

  if has_function_privilege('anon', 'public.admin_queue_stacked_deal(uuid, jsonb)', 'execute') then
    raise exception 'anon must not be able to queue a stacked deal';
  end if;

  -- THE LEAK CHECK. A policy naming anon, or one whose USING clause is not
  -- scoped to the caller, would publish which players were dealt rigged hands.
  select array_agg(polname) into policy_names
    from pg_policy where polrelid = 'public.stacked_deals'::regclass
     and 'anon' = any (select rolname from pg_roles where oid = any (polroles));
  if policy_names is not null then
    raise exception 'stacked_deals has a policy naming anon: %', policy_names;
  end if;

  if (select count(*) from pg_policy where polrelid = 'public.stacked_deals'::regclass and polcmd <> 'r') > 0 then
    raise exception 'stacked_deals must have SELECT policies only — every write goes through a definer function';
  end if;

  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.daily_plays'::regclass
     and tgname = 'attach_stacked_deal_on_claim'
  ) then
    raise exception 'the attach trigger is missing from daily_plays';
  end if;

  raise notice 'Migration 021 self-test passed. Stacked deals are definer-written, select-only, anon-denied, and the attach trigger is live. NEXT: deploy the updated submit-run function BEFORE queueing a deal.';
end $$;
