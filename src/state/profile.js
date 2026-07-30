// Profile data access (DESIGN.md §11d) — reads a signed-in player's whole run
// history out of `daily_plays`, and owns the one genuinely destructive action
// in the app (delete account).
//
// No new stats table: every `daily_plays` row already stores the complete run
// result (score, final hand, personality, decision rating), so the entire
// profile is derived from rows that already exist — see
// core/player-stats.js's comment on why derived beats accumulated here.

import { requireSupabase } from './supabase-client.js';

// How far back the profile reads. One row per day played, so this is a
// hard bound on both the query and the derived stats: 400 rows covers over a
// year of perfect attendance. It exists because each `result` is a few KB of
// JSON and fetching an unbounded history would eventually be a slow download
// on mobile for no visible benefit. If the game ever outlives this window,
// the move is a Postgres aggregate/RPC rather than a bigger limit.
export const HISTORY_LIMIT = 400;

/**
 * Every completed run for `userId`, newest first.
 * @returns {Promise<Array<{playDate: string, result: object}>>}
 */
export async function fetchPlayHistory(userId, { limit = HISTORY_LIMIT } = {}) {
  const client = await requireSupabase();
  const { data, error } = await client
    .from('daily_plays')
    .select('play_date, result')
    .eq('user_id', userId)
    // A claimed-but-unfinished row (seed reserved, hand not locked in yet —
    // see daily-play.js) has a null result and isn't a completed run, so it
    // must not count toward games played, streaks, or averages.
    .not('result', 'is', null)
    .order('play_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({ playDate: row.play_date, result: row.result }));
}

/**
 * Saves the player's equipped cosmetics (DESIGN.md §11e). Null clears a slot.
 *
 * Only ever called for the signed-in user's own row, and RLS enforces that
 * independently — `profiles`'s update policy is `auth.uid() = id`, so this
 * can't be repointed at someone else's profile.
 *
 * @param {string} userId
 * @param {{badge?: string|null, title?: string|null, paint?: string|null}} equipped
 */
export async function saveEquippedCosmetics(userId, { badge = null, title = null, paint = null } = {}) {
  const client = await requireSupabase();
  const { error } = await client
    .from('profiles')
    .update({ equipped_badge: badge, equipped_title: title, equipped_paint: paint })
    .eq('id', userId);
  if (error) throw error;
}

/**
 * Permanently deletes the signed-in player's account and everything attached
 * to it. Calls the `delete_own_account` Postgres function
 * (supabase/migrations/002-delete-own-account.sql) rather than deleting rows
 * from here, for two reasons:
 *
 *  1. Removing the underlying `auth.users` row is impossible from the browser
 *     — it needs privileges the public anon key deliberately doesn't have.
 *     Deleting only `profiles`/`daily_plays` from the client would leave a
 *     stranded auth user that could still sign in to a broken half-account.
 *  2. That function is `security definer` and scoped to `auth.uid()`, so it
 *     can only ever delete the caller's OWN account — the privilege never
 *     becomes a way to delete somebody else's.
 *
 * `profiles`, `daily_plays` and `friendships` all cascade from `auth.users`,
 * so that single delete removes the profile, every stored run, and every
 * friendship in both directions.
 */
export async function deleteOwnAccount() {
  const client = await requireSupabase();
  const { error } = await client.rpc('delete_own_account');
  if (error) throw error;
  // The local session is now backed by a user that no longer exists; sign out
  // so the app doesn't keep presenting a stale logged-in header.
  await client.auth.signOut().catch(() => {});
}
