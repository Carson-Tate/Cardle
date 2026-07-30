-- Migration: add the three equipped-cosmetic columns to profiles, backing the
-- badge / title / name-paint pickers on the profile page (DESIGN.md §11e).
--
-- All three are nullable: null means "nothing equipped" for a badge or title,
-- and the default paint for a name paint. No backfill needed — existing rows
-- read as a plain unstyled nameplate, exactly as they did before.
--
-- The CHECK constraints validate the SHAPE of the id, not whether the player
-- actually unlocked it. That split is deliberate:
--
--   * Shape is enforced here because these values are read back and rendered
--     next to a username, including in other people's friends lists. Pinning
--     them to `^[A-Za-z0-9_]{1,40}$` means nothing needing HTML escaping can
--     ever be stored, which is the same lesson as migration 001 (the username
--     pattern) — the app's rules must exist in the database too, since the
--     anon key lets anyone call the REST API directly.
--   * A PATTERN rather than a hardcoded list of ids, so adding a cosmetic
--     doesn't require a migration. src/core/cosmetics.js owns the vocabulary
--     and resolves any unrecognized id to nothing, so an id that isn't in a
--     registry simply doesn't render.
--   * Unlock status is NOT enforced here because it would require replaying
--     achievements and recomputing XP in SQL — the derivation that
--     core/player-stats.js does over a player's whole daily_plays history.
--     Duplicating that in Postgres would be a large amount of logic kept in
--     sync by hand, for a purely cosmetic stake: the worst a determined user
--     achieves by writing directly to their own row is displaying a badge they
--     didn't earn. They cannot affect anyone else's data (RLS still restricts
--     writes to their own row), their score, or their level.
--
-- Run this in your project's SQL Editor (Project → SQL Editor → New query).
-- Safe to run more than once.

alter table public.profiles
  add column if not exists equipped_badge text,
  add column if not exists equipped_title text,
  add column if not exists equipped_paint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_equipped_badge_shape'
  ) then
    alter table public.profiles
      add constraint profiles_equipped_badge_shape
      check (equipped_badge is null or equipped_badge ~ '^[A-Za-z0-9_]{1,40}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_equipped_title_shape'
  ) then
    alter table public.profiles
      add constraint profiles_equipped_title_shape
      check (equipped_title is null or equipped_title ~ '^[A-Za-z0-9_]{1,40}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_equipped_paint_shape'
  ) then
    alter table public.profiles
      add constraint profiles_equipped_paint_shape
      check (equipped_paint is null or equipped_paint ~ '^[A-Za-z0-9_]{1,40}$');
  end if;
end $$;
