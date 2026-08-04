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
//
// SCORE DOES COUNT NOW (owner: "increase the xp gained for the more points you
// get"), but through the score-grade LADDER rather than the raw total — see
// XP_PER_SCORE_GRADE. That keeps the paragraph above true: the ladder is nine
// bounded tiers, so the best possible run out-earns the worst by a fixed
// multiple instead of by five orders of magnitude.

import { handStrengthIndex, HAND_RANKS } from './hand-evaluator.js';
import { gradeForScore, gradeRank, SCORE_GRADES } from './score-grade.js';

// Every run earns the base, just for playing the day — a daily game's
// progression should never stall on bad luck. Raised from 100 on the owner's
// "xp easier to earn": this is the term that lifts the FLOOR, so it is felt
// most on exactly the days that previously felt unrewarded (busted hand, no
// bonuses, a discard that didn't come off). The terms below already pay for a
// good day; nothing but this pays for a bad one.
export const XP_BASE_PER_RUN = 150;
// Scaled by hand category (0 = High Card ... 11 = Royal Flush), so a better
// hand is worth more without the 274,000x spread the point table has.
export const XP_PER_HAND_STRENGTH = 25;
// Decision Rating (§3d) is the game's own "did you play this well" measure,
// and it's the one term here that rewards skill over luck.
//
// IT WAS NEARLY INERT AND NOBODY COULD HAVE SEEN IT. While the rating was
// `actualScore / bestEV`, its clamped value averaged about 0.23 even for a
// player making the mathematically optimal discard every single day, and its
// MEDIAN was 0.069 — so a term advertising 100 XP for playing well actually
// paid out around 7-20, a few percent of a typical run. Exactly the same class
// of silent deadness as meters.js's RISK_CHASE_CEILING: a constant sized
// against one scale, left behind when the scale moved, still looking correct.
//
// Now that the rating measures the choice (0-1, 1 = found the best discard),
// this term pays roughly what it always claimed. That is a real increase in XP
// for well-played runs — deliberately so, since differentiating them is the
// entire reason the term exists — and it lands on skill rather than lifting
// everyone, because a careless discard still scores near zero here.
//
// The clamp below is kept even though the rating can no longer exceed 1: rows
// stored under the old formula are still read back by the profile page, and
// some of them are 3.4, 14.0, or larger.
export const XP_PER_DECISION_RATING = 100;
// Small per-bonus nudge so a run stacked with named bonuses (§3f) feels like
// it did something, even when the hand itself was modest.
export const XP_PER_BONUS = 10;
export const XP_PER_ACHIEVEMENT = 50;
// Per step up the nine-tier score ladder (score-grade.js): Busted earns nothing
// extra, ??? earns eight steps' worth. Anchored to that ladder rather than to
// the points themselves for the reason at the top of this file, and because it
// is the ladder the player was just shown on the result panel — so the XP they
// see awarded lines up with the grade they were given, instead of being a
// separate opaque number.
//
// Sized on the owner's pick of "strong": at 100 a run's score becomes the
// largest single term, roughly tripling a great day against a bad one
// (~250 XP busted vs ~950 at the top) where hand strength alone spans 275.
export const XP_PER_SCORE_GRADE = 100;

// Highest tier index, so the maximum contribution is derivable rather than
// restated. Used by the tests and by anything sizing a progress display.
export const MAX_SCORE_GRADE_RANK = SCORE_GRADES.length - 1;

// --- The level curve ------------------------------------------------------
//
// The cost of the FIRST level-up (1 -> 2). Every later band is this plus
// XP_LEVEL_BAND_GROWTH per level, until it stops at XP_LEVEL_BAND_CAP.
export const XP_PER_LEVEL_STEP = 300;
// How much more each level costs than the one before it, while still growing.
export const XP_LEVEL_BAND_GROWTH = 150;
// The most a single level can ever cost. THIS IS THE WHOLE FIX (owner: "levels
// scale better").
//
// The curve used to be triangular — band(L) = 300 x L — which meant the cost of
// one level grew without bound: level 20 -> 21 alone cost 6,000 XP, about three
// weeks at one run per day, and level 40 would have cost six. In a game that
// hands out exactly one run per day by design (§9.2), a band that grows forever
// doesn't read as "a long-term goal", it reads as the game quietly ending. The
// player's rate of progress is fixed at ~1 run/day, so anything super-linear
// eventually outruns them no matter how well they play.
//
// Capping the band makes levelling asymptotically STEADY instead: bands widen
// for the first nine levels (so early progress still visibly accelerates away
// from the tutorial), then settle at a level roughly every 4-5 days forever.
// That is a pace a daily game can actually sustain.
//
// Because every new band is <= the old band at the same level (they are equal
// at level 1 and cheaper everywhere after), this change can only move an
// existing player's level UP. Levels are DERIVED from daily_plays rather than
// stored, so everyone re-levels on their next page load — and nobody can be
// demoted by it, which is the property that makes it safe to ship.
export const XP_LEVEL_BAND_CAP = 1500;

// The first level whose band is already at the cap, derived rather than
// restated so the three dials above stay the only things to tune.
// With 300/150/1500 this is 9.
const CAP_LEVEL = 1 + Math.ceil((XP_LEVEL_BAND_CAP - XP_PER_LEVEL_STEP) / XP_LEVEL_BAND_GROWTH);
// Cumulative XP at CAP_LEVEL, above which the curve is a straight line.
const CAP_LEVEL_XP =
  XP_PER_LEVEL_STEP * (CAP_LEVEL - 1) + (XP_LEVEL_BAND_GROWTH * (CAP_LEVEL - 1) * (CAP_LEVEL - 2)) / 2;

/** XP to get from `level` to `level + 1`. */
export function xpBandForLevel(level) {
  if (level < 1) return XP_PER_LEVEL_STEP;
  return Math.min(XP_PER_LEVEL_STEP + XP_LEVEL_BAND_GROWTH * (level - 1), XP_LEVEL_BAND_CAP);
}

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

  // Number.isFinite rejects undefined/null from an older row, and null from a
  // run where there was no discard decision to grade. The clamp additionally
  // caps ratings stored under the pre-choiceQuality formula, which was
  // unbounded above (see XP_PER_DECISION_RATING).
  const rating = Number.isFinite(result.decisionRating) ? clamp(result.decisionRating, 0, 1) : 0;

  const bonusCount = Array.isArray(result.score?.extraBonuses) ? result.score.extraBonuses.length : 0;
  const achievementCount = Array.isArray(result.newlyUnlocked) ? result.newlyUnlocked.length : 0;

  // Read defensively like every other term: a row written before scores were
  // stored, or a corrupted one, grades as Busted and simply earns nothing here
  // rather than throwing and taking out the whole profile.
  const total = Number.isFinite(result.score?.total) ? result.score.total : 0;
  const scoreGrade = gradeRank(gradeForScore(total).id);

  return Math.round(
    XP_BASE_PER_RUN +
      strength * XP_PER_HAND_STRENGTH +
      rating * XP_PER_DECISION_RATING +
      bonusCount * XP_PER_BONUS +
      achievementCount * XP_PER_ACHIEVEMENT +
      scoreGrade * XP_PER_SCORE_GRADE,
  );
}

/**
 * Total XP required to reach `level`. Level 1 is the starting point and costs
 * nothing. Two pieces: a widening (quadratic) run up to CAP_LEVEL, then a
 * straight line at XP_LEVEL_BAND_CAP per level.
 */
export function totalXpForLevel(level) {
  if (level <= 1) return 0;
  if (level <= CAP_LEVEL) {
    const steps = level - 1;
    return XP_PER_LEVEL_STEP * steps + (XP_LEVEL_BAND_GROWTH * steps * (steps - 1)) / 2;
  }
  return CAP_LEVEL_XP + XP_LEVEL_BAND_CAP * (level - CAP_LEVEL);
}

/**
 * The level a given lifetime XP total corresponds to — the exact inverse of
 * totalXpForLevel.
 *
 * Closed form for both pieces (the positive root of the quadratic below the
 * cap, plain division above it) so this stays O(1) however far a player
 * progresses. The correction loops afterwards exist only to absorb floating
 * point: Math.sqrt can land a hair under an exact boundary and floor() then
 * reports the level BELOW the one the player just earned. They run at most one
 * iteration, and they are what make "levelForXp is the exact inverse at every
 * boundary" true rather than nearly true.
 */
export function levelForXp(totalXp) {
  const xp = Math.max(0, Number.isFinite(totalXp) ? totalXp : 0);

  let level;
  if (xp >= CAP_LEVEL_XP) {
    level = CAP_LEVEL + Math.floor((xp - CAP_LEVEL_XP) / XP_LEVEL_BAND_CAP);
  } else {
    // steps = level - 1 solves (G/2)·steps² + (STEP - G/2)·steps - xp = 0.
    const b = XP_PER_LEVEL_STEP - XP_LEVEL_BAND_GROWTH / 2;
    const steps = (-b + Math.sqrt(b * b + 2 * XP_LEVEL_BAND_GROWTH * xp)) / XP_LEVEL_BAND_GROWTH;
    level = 1 + Math.floor(steps);
  }

  while (totalXpForLevel(level + 1) <= xp) level++;
  while (level > 1 && totalXpForLevel(level) > xp) level--;
  return level;
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
