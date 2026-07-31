-- Migration: refuse slurs and profanity as usernames, and give admins a way to
-- fix a bad name that is already stored.
--
-- WHY THIS IS IN THE DATABASE AND NOT IN JAVASCRIPT. `profiles` is exposed
-- straight to the browser and the anon key is public by design, so a client-side
-- word check is bypassed by one `curl` against the REST endpoint. This is the
-- same lesson migration 001 already learned about the character pattern: the
-- client check is UX, the database is the rule. Both halves are kept.
--
-- WHY A TRIGGER RATHER THAN A CHECK CONSTRAINT. A CHECK cannot run a subquery,
-- so it could only hold a hardcoded regex — which would mean a code deploy for
-- every word added, and would bake the list into the schema where anyone with
-- read access could recite it. A trigger can consult a table.
--
-- WHY THE LIST HAS NO READ POLICY. `game_config` was the obvious home and is
-- exactly wrong: it is world-readable on purpose (migration 005), so storing
-- the list there would publish it. `username_blocklist` has RLS enabled and NO
-- policies at all, so it is unreachable over REST by anyone, admins included.
-- Only the `security definer` functions below can see it.
--
-- IMPORTANT: `username` is user-updatable on their own row (migration 004
-- grants UPDATE on that column), so the trigger fires on UPDATE as well as
-- INSERT. Checking only INSERT would let anyone sign up with a clean name and
-- rename themselves to a slur a second later.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The list
-- ---------------------------------------------------------------------------
create table if not exists public.username_blocklist (
  id uuid primary key default gen_random_uuid(),
  -- Stored ALREADY NORMALIZED (uppercase, letters only) so matching is a plain
  -- comparison at check time rather than a transform of every row.
  pattern text not null check (pattern ~ '^[A-Z]{2,40}$'),
  -- 'substring' — blocked anywhere in the name. For terms no innocent word
  --              contains; this is what catches padding like X_SLUR_X.
  -- 'exact'     — blocked only as the whole name. For milder words that DO
  --              appear inside legitimate ones, where substring matching would
  --              cause the Scunthorpe problem (blocking "CLASSIC" for "ASS").
  -- 'allow'     — an explicit exemption, checked FIRST and winning outright.
  --              The escape hatch for a real false positive, so an appeal is an
  --              admin action rather than a code change.
  match_type text not null default 'substring'
    check (match_type in ('substring', 'exact', 'allow')),
  note text,
  created_at timestamptz not null default now()
);

create unique index if not exists username_blocklist_pattern_type
  on public.username_blocklist (pattern, match_type);

alter table public.username_blocklist enable row level security;
-- Deliberately NO policies. With RLS on and nothing granted, every direct REST
-- read and write is refused, for every role. The functions below are the only
-- way in, and they are `security definer` so they bypass this by design.

-- ---------------------------------------------------------------------------
-- 2. Normalisation — the part that actually decides how hard this is to evade
-- ---------------------------------------------------------------------------
-- Folds the tricks people use to smuggle a word past a naive matcher:
-- case, leetspeak digit/symbol substitutions, and separator padding.
--   "5L_UR"  -> "SLUR"      "b0b"  -> "BOB"      "N__A__M__E" -> "NAME"
--
-- Note this deliberately DELETES leftover digits rather than keeping them, so
-- "A55" folds to "ASS". The cost is that normalisation is lossy and can create
-- a match that the literal text does not contain — which is exactly why the
-- 'exact' tier and the 'allow' escape hatch both exist.
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

-- ---------------------------------------------------------------------------
-- 3. The check
-- ---------------------------------------------------------------------------
-- `strpos` rather than LIKE, so a pattern is never interpreted as a wildcard
-- expression. Patterns are constrained to [A-Z] anyway; this makes it structural.
create or replace function public.username_is_blocked(raw text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  folded text := public.normalize_username_for_matching(raw);
begin
  if folded = '' then
    return false; -- nothing to match; the character pattern rejects these anyway
  end if;

  -- An explicit exemption wins outright, before anything else is considered.
  if exists (
    select 1 from public.username_blocklist
    where match_type = 'allow' and pattern = folded
  ) then
    return false;
  end if;

  return exists (
    select 1 from public.username_blocklist
    where (match_type = 'exact' and pattern = folded)
       or (match_type = 'substring' and strpos(folded, pattern) > 0)
  );
end $$;

-- ---------------------------------------------------------------------------
-- 4. Enforcement
-- ---------------------------------------------------------------------------
-- A custom SQLSTATE, so the client can recognise this specific refusal without
-- pattern-matching an error STRING. Postgres reserves nothing in class 'CR', and
-- PostgREST passes SQLSTATE through as the error's `code` field.
create or replace function public.enforce_username_blocklist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.username_is_blocked(new.username) then
    raise exception 'username not allowed'
      using errcode = 'CRDL1';
  end if;
  return new;
end $$;

drop trigger if exists profiles_username_blocklist on public.profiles;
create trigger profiles_username_blocklist
  before insert or update of username on public.profiles
  for each row execute function public.enforce_username_blocklist();

-- ---------------------------------------------------------------------------
-- 5. Availability check for the sign-up form
-- ---------------------------------------------------------------------------
-- Lets the username prompt say "that one won't work" BEFORE submitting, without
-- ever revealing WHY — a caller cannot tell "blocked" from "already taken", so
-- the list is not enumerable through this. Whether a name is taken is already
-- public (the leaderboard shows every name), so this leaks nothing new.
create or replace function public.username_available(candidate text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if candidate !~ '^[A-Za-z0-9_]{3,20}$' then
    return false;
  end if;
  if public.username_is_blocked(candidate) then
    return false;
  end if;
  return not exists (
    select 1 from public.profiles where username = upper(trim(candidate))
  );
end $$;

-- ---------------------------------------------------------------------------
-- 6. Admin management
-- ---------------------------------------------------------------------------
-- Adding words is an admin action rather than a migration, so the owner can
-- extend the list without a deploy AND without committing further terms to a
-- public repository.
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
    folded := public.normalize_username_for_matching(w);
    -- Silently skipped rather than raising: a bulk paste with a stray blank
    -- line or a two-character fragment should not lose the whole batch.
    continue when folded !~ '^[A-Z]{2,40}$';
    insert into public.username_blocklist (pattern, match_type, note)
         values (folded, word_match_type, word_note)
    on conflict (pattern, match_type) do nothing;
    if found then
      inserted := inserted + 1;
    end if;
  end loop;

  return inserted;
end $$;

create or replace function public.admin_remove_blocked_word(word_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_remove_blocked_word() requires an admin account';
  end if;
  delete from public.username_blocklist where id = word_id;
end $$;

create or replace function public.admin_list_blocked_words()
returns table (id uuid, pattern text, match_type text, note text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_list_blocked_words() requires an admin account';
  end if;
  return query
    select b.id, b.pattern, b.match_type, b.note, b.created_at
      from public.username_blocklist b
     order by b.match_type, b.pattern;
end $$;

-- The missing remedy. Until now the only way to deal with an offensive name
-- already in the table was admin_delete_player(), which also destroys that
-- player's entire history — a punishment wildly out of proportion to a name.
-- This renames in place and leaves everything else intact.
--
-- The blocklist trigger fires on this UPDATE too, so an admin cannot rename
-- someone INTO a blocked name by accident.
create or replace function public.admin_rename_player(target_id uuid, new_username text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := upper(trim(coalesce(new_username, '')));
  updated public.profiles;
begin
  if not public.is_admin() then
    raise exception 'admin_rename_player() requires an admin account';
  end if;
  if normalized !~ '^[A-Z0-9_]{3,20}$' then
    raise exception 'username must be 3-20 characters: letters, numbers and underscores';
  end if;
  if exists (select 1 from public.profiles where username = normalized and id <> target_id) then
    raise exception '"%" is already taken', normalized;
  end if;

  update public.profiles
     set username = normalized
   where id = target_id
  returning * into updated;

  if updated is null then
    raise exception 'no such player';
  end if;
  return updated;
end $$;

revoke all on function public.normalize_username_for_matching(text) from public, anon;
revoke all on function public.username_is_blocked(text) from public, anon;
revoke all on function public.username_available(text) from public;
revoke all on function public.admin_add_blocked_words(text[], text, text) from public, anon;
revoke all on function public.admin_remove_blocked_word(uuid) from public, anon;
revoke all on function public.admin_list_blocked_words() from public, anon;
revoke all on function public.admin_rename_player(uuid, text) from public, anon;

-- username_available is reachable before sign-in on purpose: the username
-- prompt runs for a brand-new user whose session exists but whose profile does
-- not, and a signed-out visitor checking a name costs nothing.
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.admin_add_blocked_words(text[], text, text) to authenticated;
grant execute on function public.admin_remove_blocked_word(uuid) to authenticated;
grant execute on function public.admin_list_blocked_words() to authenticated;
grant execute on function public.admin_rename_player(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Starter list
-- ---------------------------------------------------------------------------
-- Deliberately SHORT, and deliberately not a comprehensive slur dictionary.
--
-- Two reasons. First, this file is committed to a public repository, and a long
-- catalogue of slurs sitting in the repo is both unpleasant and pointless —
-- anyone determined can probe the live form regardless. Second, the useful list
-- is the one that grows in response to what people actually try, which is what
-- the admin editor is for: words added there never touch the repo.
--
-- What follows is the unambiguous core — terms with no innocent English usage,
-- so they are safe as SUBSTRING matches. Extend it from the admin page.
--
-- Wrapped in a function so it can run with definer rights during a manual SQL
-- Editor session and be dropped immediately afterwards, leaving no permanently
-- callable seeding entry point behind.
create or replace function public.seed_username_blocklist()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.username_blocklist (pattern, match_type, note) values
    -- Racial and ethnic slurs.
    ('NIGGER',   'substring', 'racial slur'),
    ('NIGGA',    'substring', 'racial slur'),
    ('CHINK',    'substring', 'ethnic slur'),
    ('SPIC',     'substring', 'ethnic slur'),
    ('KIKE',     'substring', 'ethnic slur'),
    ('WETBACK',  'substring', 'ethnic slur'),
    ('COON',     'exact',     'racial slur; exact only — appears in RACCOON, TYCOON'),
    -- Homophobic and transphobic slurs.
    ('FAGGOT',   'substring', 'homophobic slur'),
    ('TRANNY',   'substring', 'transphobic slur'),
    ('DYKE',     'exact',     'slur; exact only — is also a surname and a landform'),
    -- Ableist slurs.
    ('RETARD',   'substring', 'ableist slur'),
    -- Hate symbols and movements.
    ('HITLER',   'substring', 'hate reference'),
    ('NAZI',     'substring', 'hate reference'),
    ('KKK',      'substring', 'hate group'),
    -- Sexual content and strong profanity. Mostly 'exact', because these are
    -- the ones with innocent superstrings.
    ('CUNT',     'substring', 'strong profanity'),
    ('FUCK',     'substring', 'profanity'),
    ('SHIT',     'exact',     'profanity; exact only — appears in place names'),
    ('ASS',      'exact',     'profanity; exact only — CLASSIC, BASS, PASS'),
    ('BITCH',    'substring', 'profanity'),
    ('RAPE',     'exact',     'exact only — appears in GRAPE, DRAPE, SCRAPE'),
    ('PEDO',     'substring', 'sexual abuse reference'),
    ('WHORE',    'substring', 'profanity'),
    -- Impersonation of site staff.
    ('ADMIN',    'exact',     'impersonation'),
    ('MODERATOR','exact',     'impersonation'),
    ('CARDLE',   'exact',     'impersonation of the site itself')
  on conflict (pattern, match_type) do nothing;
end $$;

select public.seed_username_blocklist();
drop function public.seed_username_blocklist();

-- ---------------------------------------------------------------------------
-- 8. Self-test — RUN THIS AND READ IT
-- ---------------------------------------------------------------------------
-- The matching rules are the part most likely to be subtly wrong, and they
-- cannot be exercised by `npm test` (there is no Postgres in that environment).
-- So the migration checks itself. Every row below must report `ok`. If any says
-- FAIL, stop and fix it before trusting the filter.
with cases (candidate, expected, why) as (values
  -- Plain hits.
  ('nigger',        true,  'plain slur'),
  ('FUCKER',        true,  'substring match, any case'),
  -- Evasion the normaliser is supposed to fold.
  ('n1gger',        true,  'leetspeak 1 -> I'),
  ('N_I_G_G_E_R',   true,  'underscore padding stripped'),
  ('f4gg0t',        true,  'leetspeak 4 -> A, 0 -> O'),
  ('xxfuckxx',      true,  'embedded in padding'),
  ('5HIT',          true,  'leetspeak 5 -> S, exact tier still matches'),
  -- The Scunthorpe guard: these must NOT be blocked.
  ('classic',       false, 'ASS is exact-tier, so CLASSIC survives'),
  ('bass_player',   false, 'ASS is exact-tier'),
  ('grapevine',     false, 'RAPE is exact-tier'),
  ('raccoon',       false, 'COON is exact-tier'),
  ('Assistant',     false, 'ASS is exact-tier'),
  -- Ordinary names must be unaffected.
  ('carson',        false, 'ordinary name'),
  ('Card_le_42',    false, 'ordinary name with digits and underscores'),
  ('POKERFACE',     false, 'ordinary name')
)
select
  candidate,
  expected,
  public.username_is_blocked(candidate) as actual,
  case when public.username_is_blocked(candidate) = expected then 'ok' else 'FAIL' end as result,
  why
from cases
order by result desc, candidate;

-- ---------------------------------------------------------------------------
-- 9. Existing rows
-- ---------------------------------------------------------------------------
-- Reported, NOT auto-renamed. Choosing someone's name for them is a judgement
-- call, and the trigger only guards future writes — anything already stored
-- predates it. Use admin_rename_player() on whatever this returns, from the
-- admin page's Rename box.
select id, username
  from public.profiles
 where public.username_is_blocked(username);
