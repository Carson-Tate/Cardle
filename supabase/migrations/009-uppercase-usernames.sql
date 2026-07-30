-- Migration: store every username in UPPERCASE, now and in future
-- (DESIGN.md §11n, owner: "i would like to change all names to all caps and all
-- future names to be all caps").
--
-- This one REWRITES EXISTING DATA, so it is written to refuse rather than to
-- guess. Read the two guards below before running it.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once: uppercasing is idempotent, and the constraint is
-- added conditionally.

-- ---------------------------------------------------------------------------
-- GUARD 1: case-insensitive collisions
-- ---------------------------------------------------------------------------
-- `username` is unique but CASE-SENSITIVELY, so 'Card' and 'card' can both
-- exist today and would both become 'CARD'. There is no correct automatic
-- answer to that — renaming somebody's account without asking is worse than
-- stopping — so this raises with the offending names and changes nothing.
-- If it fires, rename one of each pair by hand (the admin page can do it), then
-- re-run.
do $$
declare
  clashes text;
begin
  select string_agg(names, '; ')
    into clashes
    from (
      select upper(username) || ' <- ' || string_agg(username, ', ' order by username) as names
        from public.profiles
       group by upper(username)
      having count(*) > 1
    ) dupes;

  if clashes is not null then
    raise exception
      'Uppercasing would collide for: %. Rename one of each group first, then re-run.', clashes;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The rewrite
-- ---------------------------------------------------------------------------
-- No swap cycles are possible (upper() is idempotent and never maps two
-- already-uppercase names together), so a per-row unique check cannot produce a
-- spurious conflict once guard 1 has passed. `where username <> upper(username)`
-- keeps a re-run from touching any row.
update public.profiles
   set username = upper(username)
 where username <> upper(username);

-- ---------------------------------------------------------------------------
-- GUARD 2: keep it true going forward
-- ---------------------------------------------------------------------------
-- The client uppercases before writing (state/auth.js normalizeUsername), but
-- the column-level grant from migration 004 lets a player PATCH `username`
-- directly through the REST API, so the client is not the last word. This is the
-- same reasoning as the existing pattern CHECK: the app owns the vocabulary, the
-- database enforces it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_username_uppercase'
  ) then
    alter table public.profiles
      add constraint profiles_username_uppercase check (username = upper(username));
  end if;
end $$;
