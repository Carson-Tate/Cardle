// Leaderboard positions (DESIGN.md §11ar) — the pure half.
//
// "If someone is out of the top 50, show their position on the bottom" has two
// different answers depending on which board is on screen, and the split is not
// arbitrary:
//
//   GLOBAL boards ask the server (`leaderboard_my_rank`), because the page only
//   holds 50 rows and the answer might be 143.
//
//   FRIENDS boards answer from the rows already fetched. Friends filtering is
//   client-side (§11j), so a *friend* rank cannot be derived from a global one —
//   being 143rd overall says nothing about being 3rd among your friends. The
//   fetched page is filtered down, and the viewer's index in THAT array is the
//   friends rank, exactly.
//
// `viewerPositionIn` is the friends half, and it is here rather than in
// state/leaderboard.js so the off-by-one has a test instead of a browser.

/**
 * The viewer's position in an already-ordered, already-filtered list — but only
 * when they fall OUTSIDE the visible page.
 *
 * Returns null when they are on the page (the list already shows them, and
 * repeating a row that is six inches higher is noise) and when they are absent
 * entirely (we genuinely do not know their rank, and inventing one is worse
 * than saying nothing).
 *
 * @param {Array<{userId: string}>} rows - full ordered list, before slicing
 * @param {string|null} userId
 * @param {number} displaySize - how many of those rows are actually shown
 * @returns {{position: number, total: number, row: object}|null}
 */
export function viewerPositionIn(rows, userId, displaySize) {
  if (!userId || !Array.isArray(rows)) return null;
  const index = rows.findIndex((row) => row.userId === userId);
  if (index === -1) return null;
  if (index < displaySize) return null;
  return { position: index + 1, total: rows.length, row: rows[index] };
}

/**
 * "1st", "2nd", "3rd", "143rd".
 *
 * The teens are the whole reason this is a function and not a lookup on the
 * last digit: 11th, 12th and 13th break the pattern that 1/2/3 otherwise set,
 * and 111th breaks it again. Checked against 100 rather than 10.
 */
export function ordinal(n) {
  if (!Number.isFinite(n)) return '';
  const value = Math.trunc(n);
  const lastTwo = Math.abs(value) % 100;
  const lastOne = Math.abs(value) % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13 ? 'th' : lastOne === 1 ? 'st' : lastOne === 2 ? 'nd' : lastOne === 3 ? 'rd' : 'th';
  return `${value.toLocaleString()}${suffix}`;
}

/**
 * The sentence under the boards, which changes in three independent ways and so
 * is built rather than written out four times.
 *
 * `ascending` flips "Top" to "Bottom" — on an Upside Down day (§4f) these are
 * the 50 LOWEST scores, and calling that a Top 50 is simply false.
 */
export function boardSummary({ size, ascending = false, friendsOnly = false }) {
  return `${ascending ? 'Bottom' : 'Top'} ${size}${friendsOnly ? ' among you and your friends' : ''}`;
}
