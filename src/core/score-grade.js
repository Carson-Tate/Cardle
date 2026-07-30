// Run rarity grade (DESIGN.md §11i) — a named tier for a finished run's total
// score, so a big score reads as an achievement rather than just a bigger
// number. Owner request: "different rarities for higher scores", with the ladder
// named by the owner (§11k): Busted → Average → Hot → Blessed → High Roller →
// Whale → Casino Legend → Impossible → ???
//
// Display only in itself. Nothing here feeds back into scoring, so a grade can
// be re-tuned freely without changing what any hand is worth — but each grade
// DOES gate an achievement (achievements.js), which in turn grants a badge and a
// title (cosmetics.js), so the thresholds are the real difficulty curve for
// those rewards.
//
// Thresholds are anchored to HAND_RANKS values rather than hand-picked round
// numbers, the same pattern achievements.js and scoring.js already use. That
// matters because HAND_RANKS has been rebalanced before (§3s made it
// odds-proportional, moving the top of the table from ~5,000 to ~55,000,000) —
// bare magic numbers here would have silently stopped meaning anything, exactly
// as happened to the Risk meter's chase term (§54).

import { scoreForHandId } from './hand-evaluator.js';

const ROYAL = scoreForHandId('ROYAL_FLUSH');

// Ordered BEST-FIRST so the lookup below returns the highest tier that applies.
// `min` is inclusive.
export const SCORE_GRADES = [
  {
    id: 'unknown',
    label: '???',
    emoji: '🕳️',
    // Beyond a Royal Flush on its own — this needs the Royal AND a multiplier
    // stacking on top of it (a rare card in the winning combo, or a scoring
    // modifier). Reachable, but only when several rare things happen at once,
    // which is exactly what a grade called "???" should mean.
    min: ROYAL * 4,
  },
  { id: 'impossible', label: 'Impossible', emoji: '🌌', min: ROYAL },
  { id: 'casinoLegend', label: 'Casino Legend', emoji: '👑', min: scoreForHandId('STRAIGHT_FLUSH') },
  { id: 'whale', label: 'Whale', emoji: '🐋', min: scoreForHandId('FOUR_OF_A_KIND') },
  { id: 'highRoller', label: 'High Roller', emoji: '🎩', min: scoreForHandId('FULL_HOUSE') },
  { id: 'blessed', label: 'Blessed', emoji: '✨', min: scoreForHandId('STRAIGHT') },
  { id: 'hot', label: 'Hot', emoji: '🔥', min: scoreForHandId('FOUR_STRAIGHT') },
  { id: 'average', label: 'Average', emoji: '😐', min: scoreForHandId('THREE_STRAIGHT') },
  // The floor, so every run gets a grade and nothing ever renders blank.
  { id: 'busted', label: 'Busted', emoji: '💀', min: 0 },
];

// Worst-first, which is the order a progression ladder should read in for a UI.
export const SCORE_GRADES_ASCENDING = [...SCORE_GRADES].reverse();

const INDEX_BY_ID = new Map(SCORE_GRADES_ASCENDING.map((grade, index) => [grade.id, index]));

/**
 * The grade for a finished run's total score.
 *
 * Non-finite or negative totals fall through to the floor rather than throwing —
 * this runs over STORED results too (the profile's history), including rows
 * written before this existed, and a single odd row must not take out a page.
 *
 * @param {number} total
 * @returns {{id: string, label: string, emoji: string, min: number}}
 */
export function gradeForScore(total) {
  const score = Number.isFinite(total) ? total : 0;
  return SCORE_GRADES.find((grade) => score >= grade.min) ?? SCORE_GRADES[SCORE_GRADES.length - 1];
}

/** 0 for Busted up to 8 for ???, for "is this grade at least X" comparisons. */
export function gradeRank(gradeId) {
  return INDEX_BY_ID.get(gradeId) ?? 0;
}

/** Whether `total` reaches `gradeId` or anything above it. */
export function reachesGrade(total, gradeId) {
  return gradeRank(gradeForScore(total).id) >= gradeRank(gradeId);
}

/**
 * How far through the current grade a score sits, and what's next — for a
 * "nearly Blessed" style hint. `next` is null at the top grade.
 */
export function gradeProgress(total) {
  const score = Number.isFinite(total) ? Math.max(0, total) : 0;
  const index = SCORE_GRADES.findIndex((grade) => score >= grade.min);
  const grade = SCORE_GRADES[index] ?? SCORE_GRADES[SCORE_GRADES.length - 1];
  const next = index > 0 ? SCORE_GRADES[index - 1] : null;
  return { grade, next, pointsToNext: next ? Math.max(0, next.min - score) : null };
}
