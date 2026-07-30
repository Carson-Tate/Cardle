-- Cardle — Supabase schema for accounts + friends (DESIGN.md §11/§8).
-- Run this once, in full, in your Supabase project's SQL Editor
-- (Project → SQL Editor → New query → paste → Run).
--
-- ALREADY RUN AN EARLIER VERSION OF THIS FILE? This file creates tables from
-- scratch, so re-running it whole will fail on the ones that already exist.
-- See supabase/migrations/ for the small, idempotent statements that bring an
-- existing project up to date — run those instead.
--
-- Two tables:
--   profiles    — one row per signed-in user, holding the public username
--                 Supabase's own auth.users table doesn't have (auth only
--                 knows email/id — a username is app-level data).
--   friendships — one row per friend relationship. Directional
--                 (requester_id -> addressee_id) so a pending request has an
--                 obvious owner; a single row's status flips from 'pending'
--                 to 'accepted' rather than creating a second reciprocal row.
--
-- Row Level Security (RLS) is enabled on both — Supabase exposes these
-- tables directly to the browser via the anon key, so the DATABASE itself
-- (not app code) must be the thing stopping a user from reading/writing
-- someone else's data. Every policy below is written from that assumption.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

-- The username CHECK enforces the SAME pattern as src/state/auth.js's
-- isValidUsername (letters, numbers, underscores, 3-20 chars) — deliberately
-- duplicated here rather than trusted to the client. The constraint used to
-- be length-only, which meant the app's character rules existed ONLY in
-- browser JavaScript: anyone could call the Supabase REST API directly with
-- the public anon key (it's not a secret — see supabase-client.js) and insert
-- a username like `<svg onload=...>`, comfortably inside 20 characters. The
-- friends panel then rendered other people's usernames into the DOM, so a
-- crafted name executed script in the browser of anyone who viewed their
-- friends list. src/ui/header.js now escapes on output too — this is the
-- other half, keeping the bad value out of the database in the first place.
create table public.profiles (
  id uuid references auth.users (id) on delete cascade primary key,
  username text unique not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Usernames need to be publicly readable — that's how a friend request
-- looks someone up, and how a friend's name renders in your friends list.
create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

-- A user can only ever create/edit THEIR OWN profile row (id must match
-- their own auth session) — this is what stops one user from claiming or
-- renaming someone else's profile.
create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.profiles (id) on delete cascade not null,
  addressee_id uuid references public.profiles (id) on delete cascade not null,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  constraint no_self_friending check (requester_id <> addressee_id),
  unique (requester_id, addressee_id)
);

alter table public.friendships enable row level security;

-- Only the two people involved in a friendship (either side) can see the row
-- at all — this is what keeps your friends list and pending requests private
-- from everyone except the other party.
create policy "Users can view their own friendships"
  on public.friendships for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Sending a request: you can only ever insert a row where YOU are the
-- requester — stops one user from forging a request "from" someone else.
create policy "Users can send friend requests"
  on public.friendships for insert
  with check (auth.uid() = requester_id);

-- Accepting/updating: either side of the friendship can update the row
-- (in practice, only the addressee accepting a pending request), but you
-- must already be part of the row to touch it at all.
create policy "Users can update friendships they're part of"
  on public.friendships for update
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Removing a friend / declining or cancelling a request: same rule — either
-- side of an existing friendship can delete it.
create policy "Users can delete friendships they're part of"
  on public.friendships for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ---------------------------------------------------------------------------
-- daily_plays
-- ---------------------------------------------------------------------------
-- One row per signed-in user per calendar day (DESIGN.md §11c) — this is what
-- makes "exactly one play per day" and "your result is actually saved to
-- your account" real, server-enforced facts instead of something a browser's
-- local storage merely remembers (which anyone can reset by clearing it).
--
-- `seed` is claimed via INSERT the moment a logged-in player's hand is first
-- dealt, before a single card's been touched — that's what locks in which
-- hand is theirs for the day even if they never finish it, and reloading
-- mid-game re-deals the identical hand from the same seed rather than a new
-- one. `result` is filled in via UPDATE once they lock in; a row with a null
-- result means "already has a hand claimed today, hasn't finished it yet."
create table public.daily_plays (
  user_id uuid references auth.users (id) on delete cascade not null,
  play_date date not null,
  seed bigint not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, play_date)
);

alter table public.daily_plays enable row level security;

create policy "Users can view their own daily plays"
  on public.daily_plays for select
  using (auth.uid() = user_id);

create policy "Users can insert their own daily plays"
  on public.daily_plays for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own daily plays"
  on public.daily_plays for update
  using (auth.uid() = user_id);

-- RLS alone only restricts which ROWS a user can touch, not which COLUMNS —
-- without this, a user could open devtools and call
-- `.update({ seed: ... })` on their own row to reroll their claimed seed
-- (the exact "get a better draw" loophole this table exists to close), since
-- the row-level policy above would happily allow it. Column-level privilege
-- closes that: authenticated users may only ever UPDATE the `result` column
-- on a row RLS already confirms is theirs — `seed`/`play_date`/`user_id` are
-- write-once, at INSERT time only.
revoke update on public.daily_plays from authenticated;
grant update (result) on public.daily_plays to authenticated;

-- ---------------------------------------------------------------------------
-- delete_own_account()
-- ---------------------------------------------------------------------------
-- Backs the profile page's "Delete Account" button (DESIGN.md §11d). See
-- supabase/migrations/002-delete-own-account.sql for the full rationale — in
-- short: the browser's anon key cannot touch auth.users, so this runs
-- `security definer`, and it is hard-scoped to auth.uid() with no parameters
-- so it can only ever delete the caller's own account. Everything else
-- cascades from the auth.users row.

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

  delete from auth.users where id = caller;
end $$;

revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;
