-- Migration: fold digits differently for the two matching tiers.
--
-- THE BUG (found by probing the live function after 012 was run):
--
--   Card_le_42  -> allowed
--   CARDLE_1    -> allowed
--   Card_le_99  -> BLOCKED
--
-- 012's normaliser TRANSLATED the digits it has leetspeak mappings for
-- (4->A, 1->I, ...) and DELETED the ones it doesn't (2, 6, 9). So `Card_le_99`
-- collapsed to exactly `CARDLE` and hit the impersonation entry, while
-- `Card_le_42` became `CARDLEA` and did not. No player could infer that rule,
-- and it contradicted what the `exact` tier is documented to mean — "blocked
-- only as the WHOLE name". `ASS9` is not the whole name; deleting the 9 made it
-- look like it was.
--
-- WHY NOT SIMPLY KEEP ALL DIGITS EVERYWHERE. That was the obvious fix and it
-- opens an evasion hole: `N9I9G9G9E9R` would stop folding to `NIGGER` and would
-- sail past the substring tier. Digit-stripping is load-bearing for substring
-- matching and harmful for exact matching.
--
-- THE FIX: two normalisers, one per tier — which is what the tiers already
-- meant.
--
--   substring — "this word appears in here, however disguised".
--               Strip everything that is not a letter. Maximum folding.
--   exact     — "the whole name IS this word".
--               Keep leftover digits, because a name with extra characters in
--               it is BY DEFINITION not the whole word.
--
-- Result:
--   Card_le_99   -> CARDLE99  allowed      (exact tier, no longer collapses)
--   cardle       -> CARDLE    blocked      (still impersonation)
--   ASS9         -> ASS9      allowed      (not the whole name)
--   A_S_S        -> ASS       blocked      (separators still stripped)
--   4SS          -> ASS       blocked      (real leet spelling)
--   N9I9G9G9E9R  -> NIGGER    blocked      (substring tier, still aggressive)
--
-- Run this in your project's SQL Editor. Safe to run more than once.
-- Requires 012 to have been run first.

-- ---------------------------------------------------------------------------
-- 1. Allow digits in a stored pattern
-- ---------------------------------------------------------------------------
-- Only meaningful for 'allow' entries, which exempt a specific NAME rather than
-- a word — an admin clearing a false positive may well need to name something
-- with a digit in it. Every pattern 012 stored is letters-only and stays valid.
alter table public.username_blocklist
  drop constraint if exists username_blocklist_pattern_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'username_blocklist_pattern_chars'
  ) then
    alter table public.username_blocklist
      add constraint username_blocklist_pattern_chars
      check (pattern ~ '^[A-Z0-9]{2,40}$');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The two normalisers
-- ---------------------------------------------------------------------------
-- Unchanged from 012 — still the aggressive one, still what substring matching
-- needs. Restated here so this file is readable on its own.
create or replace function public.normalize_username_for_matching(raw text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           translate(upper(coalesce(raw, '')),
                     '0134578@$!|+',
                     'OIEASTBASIIT'),
           '[^A-Z]', '', 'g'
         );
$$;

-- New. Same leetspeak translation and the same stripping of separators and
-- symbols, but digits that survive translation (2, 6, 9) are KEPT, so a name
-- carrying them is not mistaken for the bare word.
create or replace function public.normalize_username_for_exact(raw text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           translate(upper(coalesce(raw, '')),
                     '0134578@$!|+',
                     'OIEASTBASIIT'),
           '[^A-Z0-9]', '', 'g'
         );
$$;

-- ---------------------------------------------------------------------------
-- 3. Match each tier with its own folding
-- ---------------------------------------------------------------------------
create or replace function public.username_is_blocked(raw text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  folded_loose text := public.normalize_username_for_matching(raw); -- letters only
  folded_exact text := public.normalize_username_for_exact(raw);    -- digits kept
begin
  if folded_exact = '' then
    return false;
  end if;

  -- An explicit exemption still wins outright. Compared on the exact folding,
  -- so an admin can exempt a specific name including its digits.
  if exists (
    select 1 from public.username_blocklist
    where match_type = 'allow' and pattern = folded_exact
  ) then
    return false;
  end if;

  return exists (
    select 1 from public.username_blocklist
    where (match_type = 'exact' and pattern = folded_exact)
       or (match_type = 'substring' and strpos(folded_loose, pattern) > 0)
  );
end $$;

-- ---------------------------------------------------------------------------
-- 4. Store new words with the folding their own tier will match against
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_blocked_words(
  words text[],
  word_match_type text default 'substring',
  word_note text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer := 0;
  w text;
  folded text;
begin
  if not public.is_admin() then
    raise exception 'admin_add_blocked_words() requires an admin account';
  end if;
  if word_match_type not in ('substring', 'exact', 'allow') then
    raise exception 'match type must be substring, exact or allow';
  end if;

  foreach w in array coalesce(words, '{}') loop
    -- MUST match how username_is_blocked will fold a candidate for this tier,
    -- or a stored pattern could never be hit.
    folded := case
                when word_match_type = 'substring' then public.normalize_username_for_matching(w)
                else public.normalize_username_for_exact(w)
              end;
    continue when folded !~ '^[A-Z0-9]{2,40}$';
    -- A substring pattern containing a digit could never match, since the loose
    -- folding deletes every digit before comparing. Refused rather than stored
    -- as something that silently does nothing.
    continue when word_match_type = 'substring' and folded ~ '[0-9]';
    insert into public.username_blocklist (pattern, match_type, note)
         values (folded, word_match_type, word_note)
    on conflict (pattern, match_type) do nothing;
    if found then
      inserted := inserted + 1;
    end if;
  end loop;

  return inserted;
end $$;

revoke all on function public.normalize_username_for_exact(text) from public, anon;

-- ---------------------------------------------------------------------------
-- 5. Self-test — RUN THIS AND READ IT. Every row must say `ok`.
-- ---------------------------------------------------------------------------
with cases (candidate, expected, why) as (values
  -- The regression this migration exists for.
  ('Card_le_99',    false, 'REGRESSION: digits no longer collapse into CARDLE'),
  ('Card_le_42',    false, 'was already fine, must stay fine'),
  ('CARDLE_1',      false, 'was already fine, must stay fine'),
  ('cardle_fan',    false, 'ordinary fan name'),
  ('cardle',        true,  'the bare site name is still impersonation'),
  ('C4RDLE',        true,  'leet spelling of the bare name still blocked'),
  -- The evasion hole the naive fix would have opened.
  ('N9I9G9G9E9R',   true,  'substring tier still strips ALL digits'),
  ('n1gger9',       true,  'leet plus a trailing digit'),
  ('xxfuckxx',      true,  'substring, embedded'),
  -- Exact tier now means the WHOLE name, as documented.
  ('ASS9',          false, 'not the whole name, so not blocked'),
  ('A_S_S',         true,  'separators still stripped; this IS the whole name'),
  ('4SS',           true,  'real leet spelling of the whole name'),
  ('shit',          true,  'exact tier, bare'),
  -- Scunthorpe guard, unchanged.
  ('classic',       false, 'ASS is exact-tier'),
  ('raccoon',       false, 'COON is exact-tier'),
  ('grapevine',     false, 'RAPE is exact-tier'),
  ('assistant',     false, 'ASS is exact-tier'),
  ('carson',        false, 'ordinary name')
)
select
  candidate,
  expected,
  public.username_is_blocked(candidate) as actual,
  case when public.username_is_blocked(candidate) = expected then 'ok' else 'FAIL' end as result,
  why
from cases
order by result desc, candidate;
