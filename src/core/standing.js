// Where today's run placed against everyone else's (DESIGN.md §11aa).
//
// Owner request, modelled on RNGDLE's "TOP 49%" chip: a one-glance answer to
// "was that actually any good?", which the score alone cannot give. A 3,157 is
// meaningless in isolation — the grade ladder (score-grade.js) says how good the
// HAND was in the abstract, this says how you did against the people who played
// the same day.
//
// PURE. The rank and the field size are fetched by state/standing.js and passed
// in; nothing here knows the database exists.

/**
 * Below this many finished runs, no standing is shown at all.
 *
 * Percentages of a tiny field are noise dressed as information: first of three
 * is "TOP 33%", and the same run an hour later might be "TOP 12%" purely because
 * more people showed up. Worse, with two players the loser is always BOTTOM 100%,
 * which reads as a verdict on them rather than on a two-person sample. Waiting
 * for a real field costs an early player nothing — the chip simply appears later
 * in the day, and the result panel already recomputes it on every view.
 */
export const MIN_STANDING_FIELD = 5;

/**
 * Colour tiers, keyed on percentile FROM THE TOP (1 = best in the field).
 *
 * Deliberately not the nine-tier score ladder's colours: that ladder grades the
 * hand against every hand that could exist, this grades it against the hands
 * that actually turned up today. Reusing its palette would suggest the two are
 * the same measurement, and they routinely disagree — a modest hand can top a
 * quiet day.
 */
const TIERS = [
  { id: 'elite', maxTopPercent: 10 },
  { id: 'strong', maxTopPercent: 30 },
  { id: 'middling', maxTopPercent: 70 },
  { id: 'weak', maxTopPercent: 90 },
  { id: 'poor', maxTopPercent: 100 },
];

function tierFor(topPercent) {
  return (TIERS.find((tier) => topPercent <= tier.maxTopPercent) ?? TIERS[TIERS.length - 1]).id;
}

/**
 * Turns a raw placing into everything the chip needs.
 *
 * @param {{rank: number, total: number}} standing - `rank` is 1-based with 1 as
 *   the best score of the day; ties share the better rank (standard competition
 *   ranking), so two players on the same score are both "1st" and the next is 3rd.
 * @returns {{side: 'top'|'bottom', percent: number, label: string, tier: string,
 *   rank: number, total: number}|null} null when the field is too small to say
 *   anything honest, or the input is unusable.
 */
export function describeStanding(standing) {
  const rank = Number(standing?.rank);
  const total = Number(standing?.total);
  if (!Number.isInteger(rank) || !Number.isInteger(total)) return null;
  if (total < MIN_STANDING_FIELD || rank < 1 || rank > total) return null;

  // Percentile from the top: rank 1 of 100 is the top 1%.
  const topPercent = Math.max(1, Math.min(100, Math.ceil((rank / total) * 100)));

  // BOTTOM for the worse half, because "TOP 90%" is a euphemism nobody reads as
  // bad news — and the owner asked for both words. The two are the same fact
  // stated from whichever end is shorter to say.
  const side = topPercent <= 50 ? 'top' : 'bottom';
  const percent =
    side === 'top' ? topPercent : Math.max(1, Math.min(100, Math.ceil(((total - rank + 1) / total) * 100)));

  return {
    side,
    percent,
    label: `${side === 'top' ? 'TOP' : 'BOTTOM'} ${percent}%`,
    tier: tierFor(topPercent),
    rank,
    total,
  };
}
