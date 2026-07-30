// Run rarity grade (DESIGN.md §11i) — a named tier for a finished run's total
// score, so a big score reads as an achievement rather than just a bigger
// number. Owner request: "different rarities for higher scores."
//
// Display only. Nothing here feeds back into scoring, so a grade can be
// re-tuned freely without changing what any hand is worth.
//
// Thresholds are anchored to HAND_RANKS values rather than hand-picked round
// numbers, the same pattern achievements.js and scoring.js already use. That
// matters because HAND_RANKS has been rebalanced before (§3s made it
// odds-proportional, moving the top of the table from ~5,000 to ~55,000,000) —
// bare magic numbers here would have silently stopped meaning anything, exactly
// as happened to the Risk meter's chase term (§54).

import { scoreForHandId } from './hand-evaluator.js';

// Ordered best-first so the lookup below returns the highest tier that applies.
export const SCORE_GRADES = [
  {
    id: 'mythic',
    label: 'Mythic',
    emoji: '🌟',
    // Four of a Kind territory and up — the genuinely once-in-a-long-while run.
    min: scoreForHandId('FOUR_OF_A_KIND'),
  },
  { id: 'legendary', label: 'Legendary', emoji: '👑', min: scoreForHandId('FULL_HOUSE') },
  { id: 'epic', label: 'Epic', emoji: '💜', min: scoreForHandId('STRAIGHT') },
  { id: 'rare', label: 'Rare', emoji: '💎', min: scoreForHandId('THREE_OF_A_KIND') },
  { id: 'uncommon', label: 'Uncommon', emoji: '🟢', min: scoreForHandId('TWO_PAIR') },
  // The floor: every run gets a grade, so nothing ever renders blank.
  { id: 'common', label: 'Common', emoji: '⚪', min: 0 },
];

/**
 * The grade for a finished run's total score.
 *
 * Non-finite or negative totals fall through to Common rather than throwing —
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

/**
 * How far through the current grade a score sits, and what's next — for a
 * "nearly Epic" style hint. `next` is null at the top grade.
 */
export function gradeProgress(total) {
  const score = Number.isFinite(total) ? Math.max(0, total) : 0;
  const index = SCORE_GRADES.findIndex((grade) => score >= grade.min);
  const grade = SCORE_GRADES[index] ?? SCORE_GRADES[SCORE_GRADES.length - 1];
  const next = index > 0 ? SCORE_GRADES[index - 1] : null;
  return { grade, next, pointsToNext: next ? Math.max(0, next.min - score) : null };
}
