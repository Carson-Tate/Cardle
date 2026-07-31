// Profile data access (DESIGN.md §11d) — reads a signed-in player's whole run
// history out of `daily_plays`, and owns the one genuinely destructive action
// in the app (delete account).
//
// No new stats table: every `daily_plays` row already stores the complete run
// result (score, final hand, personality, decision rating), so the entire
// profile is derived from rows that already exist — see
// core/player-stats.js's comment on why derived beats accumulated here.

import { requireSupabase } from './supabase-client.js';
// Reused rather than duplicated: one definition of what a legal username is.
import { isValidUsername, normalizeUsername } from './auth.js';

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

// Shared, per-page-load cache of the signed-in player's own history.
//
// The header's XP bar and the profile page both need lifetime XP, and XP is
// DERIVED from every stored run (progression.js) rather than kept as a running
// total — the same "derived, not accumulated" rule as the rest of the career
// stats, which is what stops a level ever drifting out of step with the runs
// behind it. The cost of that is a real fetch, and without this both surfaces
// would pay it separately on the profile page.
//
// Keyed by user id so it can never serve one account's history to another, and
// caching the PROMISE rather than the result so two callers racing on load share
// one request instead of firing two.
let ownHistory = null;

/**
 * `fetchPlayHistory` for the signed-in player, fetched at most once per page
 * load. Use `fetchPlayHistory` directly for anyone else's profile.
 */
export function loadOwnHistory(userId, options) {
  if (ownHistory?.userId === userId) return ownHistory.promise;
  // Cleared on failure so a transient error doesn't disable the XP bar for the
  // rest of the session — the same reasoning as supabase-client.js's client
  // promise.
  const promise = fetchPlayHistory(userId, options).catch((error) => {
    if (ownHistory?.promise === promise) ownHistory = null;
    throw error;
  });
  ownHistory = { userId, promise };
  return promise;
}

/** Drops the cache — call after writing a new run, which changes lifetime XP. */
export function invalidateOwnHistory() {
  ownHistory = null;
}

/**
 * Fired on `window` when the signed-in player's lifetime XP has changed — i.e.
 * a run was just scored and saved. The header listens and refreshes its bar.
 *
 * An event rather than a direct call, for the same reason as
 * `PROFILE_UPDATED_EVENT` (ui/nameplate.js): board.js and header.js are
 * siblings wired up separately by main.js, and neither should have to import
 * the other just to say "something you display has changed".
 */
export const XP_UPDATED_EVENT = 'cardle:xp-updated';

/** Announces that a run was saved, so any XP display can catch up. */
export function announceXpUpdate() {
  invalidateOwnHistory();
  window.dispatchEvent(new CustomEvent(XP_UPDATED_EVENT));
}

/**
 * Every column `ui/nameplate.js` needs to render a player correctly — shared so
 * the several places that fetch "a profile to draw a name with" cannot drift
 * apart.
 *
 * `admin_unlocks` is the one that is easy to forget and silent when missing, and
 * it has already caused a bug (§11m). `resolveEquipped` drops a grant-only
 * custom cosmetic unless the row proves the player was granted it — that check
 * is what makes re-locking an over-permissive cosmetic actually take effect
 * (§11h). Fetch a row without this column and the check sees no grants, so the
 * cosmetic silently vanishes from that one surface while working everywhere
 * else. Selecting a constant rather than a hand-written list is the fix.
 */
export const NAMEPLATE_COLUMNS = 'id, username, equipped_badge, equipped_title, equipped_paint, admin_unlocks';

/**
 * Looks up a profile by username, for viewing someone else's profile
 * (`?profile=<username>`, §11j). `profiles` has always been publicly readable —
 * that's how friend lookup works — so this needs no special permission; reading
 * their RUNS does, which migration 006 grants for completed runs only.
 */
export async function fetchProfileByUsername(username) {
  const client = await requireSupabase();
  const { data, error } = await client
    .from('profiles')
    .select(`${NAMEPLATE_COLUMNS}, created_at`)
    // Normalized, because stored names are uppercase (§11n) and a `?profile=car`
    // link shared before that change must still resolve to CAR.
    .eq('username', normalizeUsername(username))
    .maybeSingle();
  if (error) throw error;
  return data;
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
 * Renames the signed-in player (owner request: "i also would like the option to
 * change my name").
 *
 * Validation and collision handling deliberately mirror `createProfile` rather
 * than being reinvented: the same `USERNAME_PATTERN`, and the same treatment of
 * Postgres 23505. The difference is which constraint can realistically fire
 * here. On an UPDATE the primary key isn't changing, so a 23505 can only be the
 * `username` unique index — meaning "taken" is a safe conclusion here, where on
 * INSERT it was not (see the long note in auth.js's createProfile).
 *
 * One extra case worth handling explicitly: renaming to the name you already
 * have. Postgres would accept that as a no-op update, but reporting it plainly
 * is better than a silent success that looks like nothing happened.
 *
 * @returns {Promise<string>} the saved username, trimmed
 */
export async function updateUsername(userId, rawUsername) {
  const typed = String(rawUsername ?? '').trim();
  if (!isValidUsername(typed)) {
    throw new Error('Usernames must be 3-20 characters: letters, numbers, and underscores only.');
  }
  // Stored uppercase (§11n). Note the consequence for callers: comparing the
  // returned name against what the player typed will differ in case, so
  // "is this the same name?" checks must compare normalized forms.
  const username = normalizeUsername(typed);

  const client = await requireSupabase();
  // Only `username` is written, and RLS restricts updates to `auth.uid() = id`,
  // so this cannot be repointed at another player's row. The column-level grant
  // from migration 004 already permits exactly this column.
  const { error } = await client.from('profiles').update({ username }).eq('id', userId);
  if (!error) return username;

  if (error.code === '23505') {
    throw new Error(`"${username}" is already taken — try another.`);
  }
  throw error;
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
