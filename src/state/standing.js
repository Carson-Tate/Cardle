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
export async function fetchDailyStanding(playDate = null) {
  try {
    const client = await getSupabase();
    if (!client) return null;
    const { data, error } = await client.rpc('daily_standing', { day: playDate });
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
