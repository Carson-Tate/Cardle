// XP and levels (DESIGN.md §11d). Pure functions of a run's stored result —
// no storage of its own, so a player's level is always recomputed from their
// actual history and can never drift out of sync with it.
//
// XP is deliberately its OWN scale rather than a function of points scored.
// HAND_RANKS is odds-proportional (score ∝ 1/probability, hand-evaluator.js),
// so a Royal Flush is worth 54,800,000 against a Pair's 200 — a level curve
// driven by raw points would jump a single lucky player hundreds of levels
// ahead of everyone and make an ordinary day feel like it earned nothing.
// Levels should reward showing up and playing well, which is what the terms
// below actually measure.

import { handStrengthIndex, HAND_RANKS } from './hand-evaluator.js';

// Every run earns the base, just for playing the day — a daily game's
// progression should never stall on bad luck.
export const XP_BASE_PER_RUN = 100;
// Scaled by hand category (0 = High Card ... 11 = Royal Flush), so a better
// hand is worth more without the 274,000x spread the point table has.
export const XP_PER_HAND_STRENGTH = 25;
// Decision Rating (§3d) is the game's own "did you play this well" measure,
// and it's the one term here that rewards skill over luck. Clamped to 0-1
// even though the rating itself can exceed 1 on a lucky draw — the excess is
// luck, which the hand-strength term already pays for.
export const XP_PER_DECISION_RATING = 100;
// Small per-bonus nudge so a run stacked with named bonuses (§3f) feels like
// it did something, even when the hand itself was modest.
export const XP_PER_BONUS = 10;
export const XP_PER_ACHIEVEMENT = 50;

// Cumulative XP needed to REACH a level grows by this much more each level:
// level 2 costs 300, level 3 a further 600, level 4 a further 900. That's a
// triangular curve, chosen because a typical run earns roughly 250-350 XP, so
// early levels land every run or two (immediately rewarding) while level 10
// takes ~45 days and level 20 most of a year (a long-term goal that can't be
// rushed, since there's only one run per day by design, §9.2).
export const XP_PER_LEVEL_STEP = 300;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const MAX_HAND_STRENGTH = HAND_RANKS.length - 1;

/**
 * XP earned by a single completed run.
 *
 * Every field is read defensively: this runs over STORED results, including
 * rows written by older versions of the game that may predate a field (e.g.
 * `maxDiscards`, added alongside this module). A missing field must degrade
 * to "earned nothing extra for that term", never throw — one unreadable old
 * row would otherwise take out the whole profile page.
 *
 * @param {object} result - a stored run result (see board.js's lockIn)
 * @returns {number} XP, always a non-negative integer
 */
export function xpForRun(result) {
  if (!result || typeof result !== 'object') return 0;

  const handId = result.score?.handResult?.id;
  const strength = handId ? clamp(handStrengthIndex(handId), 0, MAX_HAND_STRENGTH) : 0;

  // Number.isFinite rejects both Infinity (decisionRating's documented value
  // for a zero-EV hand) and undefined/null from an older row.
  const rating = Number.isFinite(result.decisionRating) ? clamp(result.decisionRating, 0, 1) : 0;

  const bonusCount = Array.isArray(result.score?.extraBonuses) ? result.score.extraBonuses.length : 0;
  const achievementCount = Array.isArray(result.newlyUnlocked) ? result.newlyUnlocked.length : 0;

  return Math.round(
    XP_BASE_PER_RUN +
      strength * XP_PER_HAND_STRENGTH +
      rating * XP_PER_DECISION_RATING +
      bonusCount * XP_PER_BONUS +
      achievementCount * XP_PER_ACHIEVEMENT,
  );
}

/**
 * Total XP required to reach `level`. Level 1 is the starting point and costs
 * nothing. Triangular: XP_PER_LEVEL_STEP * (level-1) * level / 2.
 */
export function totalXpForLevel(level) {
  if (level <= 1) return 0;
  return (XP_PER_LEVEL_STEP * (level - 1) * level) / 2;
}

/**
 * The level a given lifetime XP total corresponds to. Closed form (the
 * positive root of the triangular formula above) rather than a loop, so this
 * stays O(1) no matter how far a player progresses.
 */
export function levelForXp(totalXp) {
  const xp = Math.max(0, Number.isFinite(totalXp) ? totalXp : 0);
  return Math.floor((1 + Math.sqrt(1 + (8 * xp) / XP_PER_LEVEL_STEP)) / 2);
}

/**
 * Everything a level display / progress bar needs, derived from lifetime XP.
 *
 * @returns {{level: number, totalXp: number, xpIntoLevel: number, xpForNextLevel: number, progress: number}}
 *   `progress` is 0-1 through the current level; `xpForNextLevel` is the size
 *   of the current level's band, not a cumulative total.
 */
export function levelProgress(totalXp) {
  const xp = Math.max(0, Number.isFinite(totalXp) ? totalXp : 0);
  const level = levelForXp(xp);
  const floorXp = totalXpForLevel(level);
  const ceilingXp = totalXpForLevel(level + 1);
  const band = ceilingXp - floorXp;
  const into = xp - floorXp;
  return {
    level,
    totalXp: xp,
    xpIntoLevel: into,
    xpForNextLevel: band,
    progress: band > 0 ? clamp(into / band, 0, 1) : 0,
  };
}
