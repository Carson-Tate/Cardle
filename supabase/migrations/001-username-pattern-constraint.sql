-- Migration: tighten the profiles.username CHECK from length-only to the
-- actual allowed character pattern.
--
-- WHY: src/state/auth.js's isValidUsername has always enforced
-- ^[A-Za-z0-9_]{3,20}$, but the database only checked LENGTH. Since Supabase
-- exposes these tables straight to the browser and the anon key is public by
-- design, the character rules existed only in client JavaScript — a caller
-- hitting the REST API directly could insert e.g. `<svg onload=...>`, which
-- fits well inside 20 characters. src/ui/header.js rendered other people's
-- usernames into the friends list, so such a name executed script in the
-- browser of anyone who viewed it. header.js now escapes on output; this
-- closes the other half by refusing to store the value at all.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

-- 1. Find any existing rows that would violate the new rule. If this returns
--    anything, those usernames must be changed first — step 3 will fail
--    otherwise. (A fresh project will return nothing.)
select id, username
from public.profiles
where username !~ '^[A-Za-z0-9_]{3,20}$';

-- 2. Drop the old length-only constraint if it's still there. Postgres named
--    it automatically, so this looks it up rather than guessing the name.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'profiles'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%char_length(username)%'
  loop
    execute format('alter table public.profiles drop constraint %I', constraint_name);
  end loop;
end $$;

-- 3. Add the pattern constraint (idempotent — skips if already present).
do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'profiles'
      and con.conname = 'profiles_username_pattern'
  ) then
    alter table public.profiles
      add constraint profiles_username_pattern
      check (username ~ '^[A-Za-z0-9_]{3,20}$');
  end if;
end $$;
