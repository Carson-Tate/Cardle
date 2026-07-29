-- Cardle — Supabase schema for accounts + friends (DESIGN.md §11/§8).
-- Run this once, in full, in your Supabase project's SQL Editor
-- (Project → SQL Editor → New query → paste → Run).
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

create table public.profiles (
  id uuid references auth.users (id) on delete cascade primary key,
  username text unique not null check (char_length(username) between 3 and 20),
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
