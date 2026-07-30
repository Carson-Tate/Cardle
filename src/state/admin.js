// Admin data access (DESIGN.md §11f).
//
// SECURITY NOTE, because it's easy to misread this file: nothing here is a
// permission check. Every function below just calls a Postgres function or a
// SELECT, and the DATABASE decides whether the caller is allowed. Each
// `admin_*` routine is `security definer` and re-checks `public.is_admin()`
// (which reads the caller's own row via auth.uid() and takes no arguments), and
// `is_admin` itself is not writable by ordinary players thanks to a column-level
// grant — see supabase/migrations/004-admin-foundation.sql.
//
// `isCurrentUserAdmin()` exists purely so the UI can decide whether to render
// an admin link. Bypassing it gains nothing: this is a static site whose JS is
// public, so hiding a page has never been the boundary.

import { requireSupabase } from './supabase-client.js';

/**
 * Whether the signed-in user is an admin, per the database. Resolves false
 * rather than throwing when there's no session, accounts are unavailable, or
 * the migration hasn't been run yet — the caller only wants to know whether to
 * show a link, and none of those cases should surface an error to a player.
 */
export async function isCurrentUserAdmin() {
  try {
    const client = await requireSupabase();
    const { data, error } = await client.rpc('is_admin');
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Aggregate counters for the admin dashboard. Computed in SQL — see the RPC. */
export async function fetchAdminOverview() {
  const client = await requireSupabase();
  const { data, error } = await client.rpc('admin_overview');
  if (error) throw error;
  return data;
}

const PROFILE_COLUMNS = 'id, username, equipped_badge, equipped_title, equipped_paint, admin_unlocks, is_admin, created_at';

/**
 * Finds profiles by username. `profiles` is already publicly readable (that's
 * how friend lookup works), so this needs no special permission — but
 * `admin_unlocks`/`is_admin` are only meaningful to an admin, and the actions
 * offered alongside the results are all gated server-side.
 *
 * An empty query lists the newest profiles instead, so the page opens with
 * something useful rather than a blank box.
 */
export async function searchProfiles(query, { limit = 25 } = {}) {
  const client = await requireSupabase();
  let request = client.from('profiles').select(PROFILE_COLUMNS);
  const trimmed = (query ?? '').trim();
  if (trimmed) {
    // `ilike` with the term escaped for LIKE metacharacters, so a username
    // containing % or _ searches literally instead of turning into a wildcard.
    const escaped = trimmed.replace(/[\\%_]/g, (match) => `\\${match}`);
    request = request.ilike('username', `%${escaped}%`);
  }
  const { data, error } = await request.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** A single profile plus its full run history (admins can read all rows). */
export async function fetchPlayerDetail(userId) {
  const client = await requireSupabase();
  const [{ data: profile, error: profileError }, { data: plays, error: playsError }] = await Promise.all([
    client.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle(),
    client
      .from('daily_plays')
      .select('play_date, seed, result')
      .eq('user_id', userId)
      .order('play_date', { ascending: false })
      .limit(400),
  ]);
  if (profileError) throw profileError;
  if (playsError) throw playsError;
  return {
    profile,
    history: (plays ?? []).filter((row) => row.result).map((row) => ({ playDate: row.play_date, result: row.result })),
    claimedDays: (plays ?? []).map((row) => ({ playDate: row.play_date, seed: row.seed, finished: Boolean(row.result) })),
  };
}

export async function adminSetCosmetics(targetId, { badge = null, title = null, paint = null } = {}) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_set_cosmetics', { target_id: targetId, badge, title, paint });
  if (error) throw error;
}

export async function adminSetUnlocks(targetId, unlocks) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_set_unlocks', { target_id: targetId, unlocks: unlocks ?? [] });
  if (error) throw error;
}

/**
 * Clears a player's claimed hand for a date so they can play it again. Passing
 * no date resets today.
 */
export async function adminResetDay(targetId, playDate = null) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_reset_day', { target_id: targetId, day: playDate });
  if (error) throw error;
}

export async function adminDeletePlayer(targetId) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_delete_player', { target_id: targetId });
  if (error) throw error;
}
