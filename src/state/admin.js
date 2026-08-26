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

/**
 * Clears TODAY's claimed hand for every player, so the whole site replays the
 * day with fresh deals (§11aj). Resolves to the number of rows removed.
 *
 * `expectedDay` DOES NOT CHOOSE THE DAY — `game_today()` decides that inside the
 * function, and passing an older date aborts rather than reaching it. It is a
 * rollover guard: the page computes the day when it draws the confirmation and
 * the server computes it when the delete runs, so at 19:00 New York an admin can
 * confirm one date and have the server clear the next one, with a row count and
 * a success notice to match. Sending back the day that was actually confirmed
 * turns that into an error. See migration 020 for why the restriction has to
 * live there rather than here: this file is public JavaScript, so a date that
 * SELECTED the day would put the "today only" rule in the one place that cannot
 * enforce it.
 *
 * No deploy-order fallback (§11z), because there is no older path to fall back
 * to — before 020 this feature did not exist. What it does instead is name the
 * missing migration, since "Could not find the function" is otherwise the kind
 * of error that reads like an outage.
 */
export async function adminResetTodayForEveryone(expectedDay = null) {
  const client = await requireSupabase();
  const { data, error } = await client.rpc('admin_reset_today_for_everyone', { expected_day: expectedDay });
  if (error) {
    // PGRST202: PostgREST could not find a function by that name.
    if (error.code === 'PGRST202') {
      throw new Error('Run supabase/migrations/020-full-day-reset.sql first — this function is not installed yet.');
    }
    throw error;
  }
  // The RPC returns an integer. Coerced rather than trusted, so a null from an
  // unexpected shape reports "0 runs" instead of "null runs".
  const removed = Number(data);
  return Number.isFinite(removed) ? removed : 0;
}

/**
 * Queues the exact cards a player will be dealt on their NEXT hand (§11al).
 *
 * `deal` is `{ hand: [5 cards], draws: [0-5 cards] }`, each card
 * `{ rank, suit, rarity, wild }`. Validated by `normalizeStackedDeal`
 * (core/deck.js) before it gets here and again by the database, because the
 * same JSON is later read by the Edge Function that scores the run.
 *
 * REPLACES anything still queued, so saving twice is not a hidden pipeline of
 * rigged days. It cannot touch a deal already ATTACHED to a claimed day —
 * rewriting those cards would leave the player's board and the server's scorer
 * building different deals, which is the one failure this design exists to
 * prevent.
 */
export async function adminQueueStackedDeal(targetId, deal) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_queue_stacked_deal', { target_id: targetId, deal });
  if (error) {
    if (error.code === 'PGRST202') {
      throw new Error('Run supabase/migrations/021-stacked-deals.sql first — this function is not installed yet.');
    }
    throw error;
  }
}

/** Cancels a queued (not yet claimed) stacked deal. Returns how many were removed. */
export async function adminClearStackedDeal(targetId) {
  const client = await requireSupabase();
  const { data, error } = await client.rpc('admin_clear_stacked_deal', { target_id: targetId });
  if (error) {
    if (error.code === 'PGRST202') {
      throw new Error('Run supabase/migrations/021-stacked-deals.sql first — this function is not installed yet.');
    }
    throw error;
  }
  const removed = Number(data);
  return Number.isFinite(removed) ? removed : 0;
}

/**
 * Every stacked deal for one player — the queued one, plus the days that have
 * already been dealt from one. The second half is the "⚑ stacked" marker: it
 * is the only record that a given run was rigged, since nothing is written to
 * `daily_plays` itself (see migration 021 for why not).
 *
 * RESOLVES TO AN EMPTY LIST when the table does not exist yet, so the admin
 * page still renders in full before migration 021 has been applied — the panel
 * says so rather than the whole page failing.
 */
export async function fetchStackedDeals(targetId) {
  const client = await requireSupabase();
  const { data, error } = await client
    .from('stacked_deals')
    .select('id, play_date, cards, created_at, attached_at')
    .eq('user_id', targetId)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('Could not read stacked deals:', error?.message ?? error);
    return [];
  }
  return data ?? [];
}

export async function adminDeletePlayer(targetId) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_delete_player', { target_id: targetId });
  if (error) throw error;
}

/**
 * Renames a player in place (§11x).
 *
 * The remedy that was missing: until this existed, the only response to an
 * offensive username already in the table was adminDeletePlayer, which also
 * destroys that player's entire history — wildly out of proportion to a name.
 * The blocklist trigger fires on this UPDATE too, so an admin cannot rename
 * someone INTO a blocked name.
 */
export async function adminRenamePlayer(targetId, newUsername) {
  const client = await requireSupabase();
  const { data, error } = await client.rpc('admin_rename_player', {
    target_id: targetId,
    new_username: newUsername,
  });
  if (error) throw error;
  return data;
}

// --- The username blocklist (§11x) -----------------------------------------
// The table itself has NO read policy, so none of these can be replaced by a
// plain `.from('username_blocklist')` — every one goes through a
// `security definer` function that checks is_admin() first.

export async function adminListBlockedWords() {
  const client = await requireSupabase();
  const { data, error } = await client.rpc('admin_list_blocked_words');
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {string[]} words - stored normalized (uppercased, letters only), so
 *   what is typed and what is stored can differ; the editor shows the stored form.
 * @returns {number} how many were actually new
 */
export async function adminAddBlockedWords(words, matchType = 'substring', note = null) {
  const client = await requireSupabase();
  const { data, error } = await client.rpc('admin_add_blocked_words', {
    words,
    word_match_type: matchType,
    word_note: note,
  });
  if (error) throw error;
  return data ?? 0;
}

export async function adminRemoveBlockedWord(wordId) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_remove_blocked_word', { word_id: wordId });
  if (error) throw error;
}
