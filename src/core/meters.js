// Three 0-100% dials summarizing a run from different angles (owner request).
// Deliberately separate lenses on the same data, not independent random
// numbers — Skill reuses Decision Rating (the fairness metric from §3d),
// while Luck and Risk are new, derived from the EV solver's output.

import { scoreForHandId } from './hand-evaluator.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Calibration constants, not fundamental — re-tuned (DESIGN.md decision log)
// against a 1,000-hand Monte Carlo sample of solveOptimalDiscard()'s bestEV
// after HAND_RANKS was rebalanced to be odds-proportional (hand-evaluator.js
// — owner request, "royal flush... only gives 25x more points" than Pair).
// Sampled distribution: bestEV p50≈2,456, p75≈4,649, p90≈7,821, p95≈13,706
// (long tail from rare big hands); |actualScore-chosenEV| p50≈2,256,
// p75≈4,671, p90≈13,524. Ceiling set near bestEV's p90 (a genuinely strong
// deal, not just an average one) and the fortune scale near the deviation's
// p75 ("rarely swings more than a bit over this"), the same relationships
// the original ~1750-2000/~1500 constants had to the old table. See
// tools/calibrate-meters.js for the sampling script (run: solveOptimalDiscard
// is O(hand) expensive, ~150ms/hand, so it's capped at 1,000 samples rather
// than a larger run).
const DEAL_QUALITY_CEILING = 8000;
const DRAW_FORTUNE_SCALE = 5000;
const RISK_DISCARD_WEIGHT = 60;
const RISK_CHASE_WEIGHT = 40;
// What counts as "already holding something worth protecting" for the chase
// half of Risk — a Three of a Kind and up saturates it.
//
// This used to normalize against ROYAL_FLUSH (54,800,000), which made the
// entire chase component numerically inert: since real hands score in the
// hundreds to tens of thousands, every category below Straight Flush
// contributed LESS THAN ONE POINT of the 40 available (Two Pair: 0.001).
// Risk was therefore just discardedCount/maxDiscards × 60, capped at 60 —
// and "The Gambler" personality (personality.js), which needs risk >= 65,
// was unreachable without being dealt a Royal Flush and throwing it away.
// The ROYAL_FLUSH anchor was a leftover from before HAND_RANKS was rescaled
// to be odds-proportional (hand-evaluator.js), when the top of the table was
// ~5,000 rather than ~55,000,000 and dividing by it was reasonable.
const RISK_CHASE_CEILING = scoreForHandId('THREE_OF_A_KIND');

/**
 * @param {object} params
 * @param {{score: number}} params.originalHandResult - evaluateHand() on the opening hand
 * @param {number} params.actualScore - the final hand's base score (score.baseScore)
 * @param {number} params.chosenEV - EV of the discard the player actually chose
 * @param {number} params.bestEV - EV of the best possible discard for this deal
 * @param {number} params.decisionRating - from ev-solver's decisionRating()
 * @param {number} params.discardedCount
 * @param {number} params.maxDiscards
 * @returns {{luck: number, skill: number, risk: number}} each 0-100, rounded
 */
export function computeMeters({
  originalHandResult,
  actualScore,
  chosenEV,
  bestEV,
  decisionRating,
  discardedCount,
  maxDiscards,
}) {
  const skillRatio = Number.isFinite(decisionRating) ? decisionRating : 1;
  const skill = clamp(Math.round(skillRatio * 100), 0, 100);

  // Luck blends two things: how good the starting deal's ceiling was
  // (dealQuality), and whether the specific draw ran hot or cold relative
  // to its own average outcome (drawFortune) — independent of whether the
  // discard choice itself was smart (that's Skill's job).
  const dealQuality = clamp((bestEV / DEAL_QUALITY_CEILING) * 100, 0, 100);
  const drawFortune = clamp(50 + ((actualScore - chosenEV) / DRAW_FORTUNE_SCALE) * 50, 0, 100);
  const luck = clamp(Math.round((dealQuality + drawFortune) / 2), 0, 100);

  // Risk is 0 for holding pat — nothing was gambled. Otherwise it scales
  // with how much of the hand was let go, boosted by how much value was
  // already in the original hand (abandoning a decent hand to chase
  // something else is riskier than tossing a hopeless one).
  let risk = 0;
  if (discardedCount > 0 && maxDiscards > 0) {
    const baseRisk = (discardedCount / maxDiscards) * RISK_DISCARD_WEIGHT;
    const chaseBonus = clamp(originalHandResult.score / RISK_CHASE_CEILING, 0, 1) * RISK_CHASE_WEIGHT;
    risk = clamp(Math.round(baseRisk + chaseBonus), 0, 100);
  }

  return { luck, skill, risk };
}
