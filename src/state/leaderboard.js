// Leaderboard queries (DESIGN.md §11j).
//
// Four boards, per the owner's spec: today's top scores, this week's, all-time
// top scores, and all-time career points — each with a friends-only toggle.
//
// The first three are one SQL function with a different window, rather than
// three functions: the only difference is a date cutoff, and duplicating the
// query three times in SQL would mean fixing any future bug three times.
//
// Friends-only filtering happens HERE rather than in SQL. The friendship rows
// are already readable only to the two people involved (§11a's RLS), so the
// client can fetch its own friend ids cheaply and filter — whereas doing it in
// SQL would mean either passing an id list into every board or duplicating the
// friendship join inside each function. Filtering client-side does mean asking
// for a bigger page and trimming it, which is why FRIENDS_FETCH_LIMIT is larger
// than the display size.

import { requireSupabase } from './supabase-client.js';
import { getFriends } from './friends.js';

export const BOARD_SIZE = 25;
// Friends-only boards filter a global page down, so they ask for more rows to
// begin with. Capped by the SQL function at 100 regardless.
const FRIENDS_FETCH_LIMIT = 100;

export const BOARDS = [
  { id: 'daily', label: 'Today', windowDays: 0 },
  { id: 'weekly', label: 'This Week', windowDays: 7 },
  { id: 'allTime', label: 'All-Time', windowDays: null },
  { id: 'career', label: 'Career Points', windowDays: null, career: true },
];

/** The signed-in player's accepted-friend ids, plus themselves. */
async function friendCircle(userId) {
  const friends = await getFriends(userId).catch(() => []);
  const ids = new Set([userId]);
  for (const row of friends) {
    ids.add(row.requester_id === userId ? row.addressee_id : row.requester_id);
  }
  return ids;
}

/**
 * @param {object} options
 * @param {string} options.boardId - one of BOARDS' ids
 * @param {boolean} [options.friendsOnly]
 * @param {string} [options.userId] - required when friendsOnly is set
 * @returns {Promise<Array<{userId: string, profile: object, value: number, playDate?: string, runs?: number}>>}
 *   `profile` is shaped for ui/nameplate.js so a leaderboard row shows the same
 *   badge/title/paint as everywhere else.
 */
export async function fetchLeaderboard({ boardId, friendsOnly = false, userId = null, ascending = false }) {
  const board = BOARDS.find((b) => b.id === boardId) ?? BOARDS[0];
  const client = await requireSupabase();
  const limit = friendsOnly ? FRIENDS_FETCH_LIMIT : BOARD_SIZE;

  // Ascending is only ever meaningful on the TODAY board (§4f's Upside Down):
  // the modifier belongs to one game day, so flipping This Week or All-Time
  // would let a single day's rule reorder scores from days it has nothing to do
  // with. Enforced here rather than trusted from the caller, so no future caller
  // can flip a window board by passing the flag.
  const sortAscending = ascending && board.id === 'daily';

  const { data, error } = board.career
    ? await client.rpc('leaderboard_career_points', { row_limit: limit })
    : await client.rpc('leaderboard_top_scores', {
        window_days: board.windowDays,
        row_limit: limit,
        sort_ascending: sortAscending,
      });
  if (error) throw error;

  let rows = (data ?? []).map((row) => ({
    userId: row.user_id,
    // Exactly the columns nameplateHtml reads, so a leaderboard row renders
    // identically to a profile header or a friends-list entry.
    profile: {
      username: row.username,
      equipped_badge: row.equipped_badge,
      equipped_title: row.equipped_title,
      equipped_paint: row.equipped_paint,
      // Required, not decorative: resolveEquipped() hides a grant-only custom
      // cosmetic unless the row proves the grant (§11h), so without this an
      // admin-granted badge or title vanished on the boards alone. Defaulted to
      // [] so a pre-migration-008 response degrades to "no grants" rather than
      // throwing.
      admin_unlocks: Array.isArray(row.admin_unlocks) ? row.admin_unlocks : [],
    },
    value: Number(board.career ? row.total_points : row.score),
    playDate: row.play_date ?? null,
    runs: row.runs != null ? Number(row.runs) : null,
    // The hand they won with (owner request). Only the score boards have one —
    // a career total isn't a single hand. Comes straight out of the stored
    // result, so nothing extra is recorded.
    finalHand: Array.isArray(row.final_hand) ? row.final_hand : null,
  }));

  if (friendsOnly) {
    if (!userId) return [];
    const circle = await friendCircle(userId);
    rows = rows.filter((row) => circle.has(row.userId));
  }

  return rows.slice(0, BOARD_SIZE);
}
