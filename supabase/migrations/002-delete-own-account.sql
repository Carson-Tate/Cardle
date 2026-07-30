-- Migration: add the delete_own_account() function backing the profile
-- page's "Delete Account" button (DESIGN.md §11d).
--
-- WHY A FUNCTION AT ALL: the browser holds only the public anon key, which
-- deliberately cannot touch `auth.users`. Deleting just the app's own tables
-- from the client would leave a stranded auth user who could still sign in to
-- a half-deleted account. This function runs `security definer` (i.e. with
-- the owner's privileges, not the caller's) so it CAN remove the auth row.
--
-- WHY THAT IS SAFE: it takes no arguments and is hard-scoped to auth.uid() —
-- the id of whoever is calling. There is no parameter to tamper with, so an
-- authenticated user can only ever delete their OWN account. `set search_path`
-- is pinned so a caller can't shadow `auth` or `public` with their own schema
-- and redirect what the function touches. EXECUTE is granted only to
-- `authenticated`, never to `anon`.
--
-- Because public.profiles, public.daily_plays and public.friendships all
-- reference auth.users (directly, or via profiles) with ON DELETE CASCADE,
-- this one statement removes the profile, every stored run, and every
-- friendship in both directions.
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
  -- Refuse rather than silently no-op when there's no session: an
  -- unauthenticated call is a bug (or an attempt), and it should be loud.
  if caller is null then
    raise exception 'delete_own_account() requires an authenticated session';
  end if;

  delete from auth.users where id = caller;
end $$;

-- Lock the function down to signed-in callers only.
revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;
