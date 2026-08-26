-- ---------------------------------------------------------------------------
-- 023 — Pinned replacements are per SLOT, not a draw order (DESIGN.md §11al)
-- ---------------------------------------------------------------------------
-- Owner: "picking what the outcome is when they discard a card is not working
-- like i wanted it to... so if it was a 2, 3, Q, 5, 6, they would want to
-- discard the Q to try and get a straight, so instead of me listing the draw
-- pile as in the order they get discarded, i pick the third slot as what i want
-- it because they will discard the third slot."
--
-- 021 stored `draws` as an ORDERED pile: the first pinned card went to whoever
-- discarded first, the second to the next, and so on. That only lands the card
-- you meant if you can predict how many cards they throw and in what order —
-- which is the one thing you cannot know. The shape is now `slotDraws`, a
-- sparse array indexed by HAND SLOT: `slotDraws[2]` is dealt if and only if
-- slot 2 is the card thrown away.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

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
  -- `slotDraws` is positional, so its length is bounded by the hand rather than
  -- being a free-length list. Entries may be null — that is a slot the admin
  -- deliberately left to roll normally, and it must stay a hole rather than
  -- being compacted away.
  if deal ? 'slotDraws' and jsonb_typeof(deal -> 'slotDraws') is distinct from 'array' then
    raise exception '"slotDraws" must be an array when present';
  end if;
  if deal ? 'slotDraws' and jsonb_array_length(deal -> 'slotDraws') > 5 then
    raise exception 'there are only 5 slots to pin a replacement for';
  end if;

  delete from public.stacked_deals where user_id = target_id and play_date is null;

  insert into public.stacked_deals (user_id, cards, created_by)
  values (target_id, deal, auth.uid());
end $$;

revoke all on function public.admin_queue_stacked_deal(uuid, jsonb) from public, anon;
grant execute on function public.admin_queue_stacked_deal(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Retire deals written in the 021 shape
-- ---------------------------------------------------------------------------
-- REINTERPRETING THEM WOULD BE WORSE THAN DROPPING THEM. An ordered pile and a
-- slot map are both "an array of cards", so an old row would parse cleanly and
-- deal the right cards to the WRONG SLOTS — a silent, plausible, completely
-- wrong result. `normalizeStackedDeal` ignores `draws` for the same reason.
--
-- Only QUEUED rows are touched. An attached row belongs to a day already in
-- play, and deleting it would leave the board and the server building different
-- deals — the failure the whole design exists to prevent.
delete from public.stacked_deals
 where play_date is null
   and not (cards ? 'slotDraws');

-- ---------------------------------------------------------------------------
-- Self-test
-- ---------------------------------------------------------------------------
do $$
declare
  arg_count integer;
  sig_count integer;
begin
  select count(*), max(p.pronargs) into sig_count, arg_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_queue_stacked_deal';
  if sig_count <> 1 then
    raise exception 'expected exactly 1 admin_queue_stacked_deal signature, found %', sig_count;
  end if;
  if arg_count <> 2 then
    raise exception 'admin_queue_stacked_deal must take exactly (target_id, deal)';
  end if;

  -- The old validator named "draws"; the new one must not, or a stale copy is
  -- still installed and will happily accept the shape this migration retires.
  if (select pg_get_functiondef(p.oid) not like '%slotDraws%'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_queue_stacked_deal') then
    raise exception 'admin_queue_stacked_deal is still validating the old "draws" shape';
  end if;

  if exists (select 1 from public.stacked_deals where play_date is null and not (cards ? 'slotDraws')) then
    raise exception 'a queued deal in the retired shape survived the cleanup';
  end if;

  raise notice 'Migration 023 self-test passed. Pinned replacements are per slot; any queued deal in the old shape has been retired.';
end $$;
