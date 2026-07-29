// Classifies a completed run into a personality archetype (owner request).
// Ordered rule list, first match wins — same registry pattern as
// bonus-registry.js. The last entry (Grinder) is a guaranteed catch-all, so
// classifyPersonality() always returns something.
//
// To add a new archetype: insert it wherever its specificity belongs in the
// order (more specific / rarer conditions first) — everything before
// Grinder.

import { handStrengthIndex } from './hand-evaluator.js';
import { OPTIMAL_DISCARD_MAX_BONUS } from './scoring.js';

// "At least Flush-strength"/"at least Straight-strength" compared by
// CATEGORY (handStrengthIndex), not raw score — hand-evaluator.js's
// rank-scaling means two hands in the same category no longer share one
// flat score (a low-rank Flush can score less than a high-rank Straight
// would need to beat it), so a score comparison would give inconsistent
// results depending on which specific ranks formed the hand.
const SHARK_INDEX = handStrengthIndex('FLUSH');
const ARCHITECT_INDEX = handStrengthIndex('STRAIGHT');
// The Statistician requires (near-)literally the best possible discard, not
// just a better-than-average one (owner bug report: "statistician shows up
// too often, like i just got a decision rating of 27% and still got it").
// optimalDiscardBonus() (scoring.js) is chosenEV's PERCENTILE among that
// day's legal discards (0-OPTIMAL_DISCARD_MAX_BONUS), a different measure
// from Decision Rating (actual score ÷ best EV) — picking the objectively
// best discard scores the literal max here regardless of what the draw then
// did, which is the correct signal for "found the mathematically optimal
// discard." The bug was the threshold, not the measure: `>= 35` (17.5% of
// the max) only required beating roughly the bottom sixth of that day's
// choices — an ordinary/mediocre pick, not an optimal one — so it fired on
// runs nowhere near "found the best play." A tiny buffer under the literal
// max (rather than requiring exact equality) absorbs any future rounding
// changes to optimalDiscardBonus() without this threshold silently going
// stale.
const STATISTICIAN_MIN_OPTIMAL_DISCARD_BONUS = OPTIMAL_DISCARD_MAX_BONUS - 5;

export const PERSONALITIES = [
  {
    id: 'shark',
    emoji: '🦈',
    label: 'The Shark',
    description: 'Calculated, precise, and rewarded for it.',
    matches: (ctx) => ctx.meters.skill >= 90 && handStrengthIndex(ctx.finalHandResult.id) >= SHARK_INDEX,
  },
  {
    id: 'statistician',
    emoji: '🧮',
    label: 'The Statistician',
    description: 'Found the mathematically optimal discard and took it.',
    // optimalDiscard is scored on the *choice* (its EV, decided before the
    // draw) and can be maxed out even if the draw itself then whiffed —
    // that's a real, mathematically correct case (great decision, bad
    // luck), but pairing "The Statistician" with a hand that scored
    // nothing reads as contradictory. Requiring some actual points keeps
    // the label from firing on a total whiff; a bad-luck-despite-perfect-
    // play run falls through to Dreamer or Ghost instead, which fit better.
    matches: (ctx) =>
      ctx.discardedCount > 0 &&
      ctx.skillBonuses.optimalDiscard >= STATISTICIAN_MIN_OPTIMAL_DISCARD_BONUS &&
      ctx.finalHandResult.score > 0,
  },
  {
    id: 'maniac',
    emoji: '🔥',
    label: 'The Maniac',
    description: 'Went all-in on chaos, and the deck rewarded it.',
    matches: (ctx) => ctx.discardedCount === ctx.maxDiscards && ctx.skillBonuses.longShot > 0,
  },
  {
    id: 'dreamer',
    emoji: '💭',
    label: 'The Dreamer',
    description: 'Chased something bigger and came up short.',
    matches: (ctx) => ctx.discardedCount >= 2 && ctx.finalHandResult.score <= ctx.originalHandResult.score,
  },
  {
    id: 'gambler',
    emoji: '🎰',
    label: 'The Gambler',
    description: 'Bet big on the deck coming through.',
    matches: (ctx) => ctx.meters.risk >= 65,
  },
  {
    id: 'optimist',
    emoji: '🌈',
    label: 'The Optimist',
    description: 'Trusted a weak hand purely on faith.',
    matches: (ctx) => ctx.discardedCount === 0 && ctx.originalHandResult.score === 0,
  },
  {
    id: 'hoarder',
    emoji: '✋',
    label: 'The Hoarder',
    description: "Wouldn't let go of a single card.",
    matches: (ctx) => ctx.discardedCount === 0,
  },
  {
    id: 'perfectionist',
    emoji: '💎',
    label: 'The Perfectionist',
    description: 'Left nothing wasted in the final hand.',
    matches: (ctx) => ctx.skillBonuses.cleanFinish > 0 && ctx.meters.skill >= 80,
  },
  {
    id: 'wildcard',
    emoji: '🎭',
    label: 'The Wildcard',
    description: 'A little bit of everything happened at once.',
    matches: (ctx) => ctx.extraBonuses.length >= 4,
  },
  {
    id: 'architect',
    emoji: '🏛️',
    label: 'The Architect',
    description: 'Built something strong, methodically.',
    matches: (ctx) => ctx.meters.skill >= 75 && handStrengthIndex(ctx.finalHandResult.id) >= ARCHITECT_INDEX,
  },
  {
    id: 'ghost',
    emoji: '👻',
    label: 'The Ghost',
    description: 'A quiet run. Nothing much to report.',
    matches: (ctx) => ctx.finalHandResult.id === 'HIGH_CARD' && ctx.extraBonuses.length === 0,
  },
  {
    id: 'grinder',
    emoji: '⚙️',
    label: 'The Grinder',
    description: 'Steady, workmanlike, gets it done.',
    matches: () => true, // guaranteed fallback — must stay last
  },
];

/**
 * @param {object} ctx
 * @param {{luck: number, skill: number, risk: number}} ctx.meters
 * @param {number} ctx.discardedCount
 * @param {number} ctx.maxDiscards
 * @param {{id: string, score: number}} ctx.originalHandResult
 * @param {{id: string, score: number}} ctx.finalHandResult
 * @param {object} ctx.skillBonuses - score.skillBonuses from scoreRun()
 * @param {Array} ctx.extraBonuses - score.extraBonuses from scoreRun()
 */
export function classifyPersonality(ctx) {
  return PERSONALITIES.find((p) => p.matches(ctx));
}
