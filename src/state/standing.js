// Fetches where the signed-in player's run placed today (DESIGN.md §11aa).
//
// The counting happens in Postgres (`daily_standing`, migration 016) and comes
// back as two integers. Doing it here instead would mean downloading every
// finished run of the day — full result blobs, several KB each, growing with the
// player count — to compute one number, and handing every player a copy of
// everyone else's hands on the way.

import { getSupabase } from './supabase-client.js';
import { describeStanding } from '../core/standing.js';

/**
 * @param {string} [playDate] - a game-day label (YYYY-MM-DD) for an older run;
 *   defaults to today on the server side, which is where the game-day boundary
 *   is authoritative.
 * @returns {Promise<object|null>} the shape core/standing.js describes, or null
 *   when there is no standing to show.
 *
 * RESOLVES NULL ON EVERY FAILURE, deliberately. This is a decoration on a result
 * the player has already been given: an unrun migration, a blocked CDN, a
 * logged-out visitor or a field too small to be meaningful should all cost the
 * chip and nothing else. It is the same rule the XP bar follows.
 */
export async function fetchDailyStanding(playDate = null, score = null) {
  try {
    const client = await getSupabase();
    if (!client) return null;

    // `for_score` ranks the run actually on screen (§11ag). Without it the
    // function ranks whatever is in the caller's SAVED row, which is a
    // different run entirely in test mode — where nothing is ever persisted —
    // and produced a chip that described a real earlier run while sitting under
    // a test score.
    const args = Number.isFinite(score) ? { day: playDate, for_score: score } : { day: playDate };
    let { data, error } = await client.rpc('daily_standing', args);

    // Migration 018 may not have been run yet, in which case the two-argument
    // form does not exist. Retrying without the score restores exactly the old
    // behaviour rather than dropping the chip, so the bundle and the SQL can be
    // deployed in either order (§11z's rule).
    if (error && Number.isFinite(score)) {
      ({ data, error } = await client.rpc('daily_standing', { day: playDate }));
    }
    if (error) throw error;
    // A set-returning function comes back as an array, and an empty one is the
    // normal answer for "you have not finished today".
    const row = Array.isArray(data) ? data[0] : data;
    return describeStanding(row);
  } catch (error) {
    console.warn('Daily standing unavailable:', error?.message ?? error);
    return null;
  }
}
