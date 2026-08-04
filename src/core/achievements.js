import { HAND_RANKS, scoreForHandId, handStrengthIndex } from './hand-evaluator.js';
import { PERSONALITIES } from './personality.js';
import { SCORE_GRADES_ASCENDING, gradeForScore, reachesGrade } from './score-grade.js';

// Point thresholds anchored to specific hand ranks rather than hardcoded
// (owner request rebalanced HAND_RANKS to be odds-proportional — see
// hand-evaluator.js — so a bare magic number here would silently mean
// something different, or nothing at all, once that table changes).
const HIGH_ROLLER_THRESHOLD = scoreForHandId('FULL_HOUSE');
const CENTURY_BONUS_THRESHOLD = scoreForHandId('TWO_PAIR');

// "X or better" thresholds compared by CATEGORY (handStrengthIndex), not raw
// score — hand-evaluator.js's rank-scaling means two hands in the same
// category no longer share one flat score (a low-rank Full House can score
// less than scoreForHandId('FULL_HOUSE') itself), so a score comparison
// would wrongly exclude a genuine low-rank Full House/Straight from "at
// least Full House"/"at least Straight."
const ZEN_MASTER_INDEX = handStrengthIndex('FULL_HOUSE');
const FULL_SEND_INDEX = handStrengthIndex('STRAIGHT');

// Achievement registry (owner request: "a whole bunch of different badges
// and achievements"). Pure predicates, same registry pattern as
// bonus-registry.js and personality.js — evaluateAchievements() just
// filters, src/state/stats.js tracks which ids have ever been unlocked so
// unlocking is a one-time event even though the predicates stay true
// forever after (e.g. "played 7 games" stays true on game 8, 9, ...).
//
// Two families:
//  - single-run: judged only on the run just played (ctx.score, etc.)
//  - cumulative: judged on ctx.stats, which src/state/stats.recordRun()
//    already folded this run into before evaluateAchievements() runs.

export const ACHIEVEMENTS = [
  {
    id: 'royalFlushClub',
    emoji: '🏆',
    label: 'Royal Flush Club',
    description: 'Score a Royal Flush.',
    check: (ctx) => ctx.score.handResult.id === 'ROYAL_FLUSH',
  },
  {
    id: 'straightFlush',
    emoji: '⚡',
    label: 'Straight Flush',
    description: 'Score a Straight Flush.',
    check: (ctx) => ctx.score.handResult.id === 'STRAIGHT_FLUSH',
  },
  {
    id: 'quadSquad',
    emoji: '🃏',
    label: 'Quad Squad',
    description: 'Score Four of a Kind.',
    check: (ctx) => ctx.score.handResult.id === 'FOUR_OF_A_KIND',
  },
  {
    id: 'highRoller',
    emoji: '💰',
    label: 'High Roller',
    description: `Score ${HIGH_ROLLER_THRESHOLD.toLocaleString()}+ points in a single run.`,
    check: (ctx) => ctx.score.total >= HIGH_ROLLER_THRESHOLD,
  },
  {
    id: 'flawless',
    emoji: '🎯',
    label: 'Flawless',
    // "100%+" was accurate when the Decision Rating was actual score ÷ best EV
    // and could overshoot on a lucky draw — which is precisely why the old
    // version of this unlocked on LUCK, not play: the only way to clear 100%
    // was to draw a hand bigger than the deal's own expected value. The rating
    // now tops out at exactly 100% and means "no discard available to you had a
    // higher expected value than the one you took", so this is finally the
    // achievement its name always claimed. `>= 1` is unchanged and needs no
    // epsilon: choiceQuality returns exactly 1 for the best option, because
    // that option is what the numerator and denominator are both built from.
    description: 'Pick the single best discard available.',
    check: (ctx) => Number.isFinite(ctx.decisionRating) && ctx.decisionRating >= 1,
  },
  {
    id: 'zenMaster',
    emoji: '🧘',
    label: 'Zen Master',
    description: 'Hold pat and still land a Full House or better.',
    check: (ctx) => ctx.discardedCount === 0 && handStrengthIndex(ctx.score.handResult.id) >= ZEN_MASTER_INDEX,
  },
  {
    id: 'fullSendClub',
    emoji: '🎲',
    label: 'Full Send',
    description: 'Discard the max allowed and still land a Straight or better.',
    check: (ctx) =>
      ctx.discardedCount > 0 &&
      ctx.discardedCount === ctx.maxDiscards &&
      handStrengthIndex(ctx.score.handResult.id) >= FULL_SEND_INDEX,
  },
  {
    id: 'jackpotRun',
    emoji: '🌟',
    label: 'Jackpot Run',
    description: 'Trigger 5 or more bonus badges in a single run.',
    check: (ctx) => ctx.score.extraBonuses.length >= 5,
  },
  {
    id: 'centuryBonus',
    emoji: '💯',
    label: 'Century Bonus',
    description: `Earn ${CENTURY_BONUS_THRESHOLD.toLocaleString()}+ points from bonuses alone, on top of the hand itself.`,
    check: (ctx) => ctx.score.total - ctx.score.baseScore >= CENTURY_BONUS_THRESHOLD,
  },
  {
    id: 'buildingBlocks',
    emoji: '🪜',
    label: 'Building Blocks',
    description: 'Land a Three Straight or Four Straight — as the hand itself, or hiding inside a stronger one.',
    check: (ctx) =>
      ctx.score.handResult.id === 'THREE_STRAIGHT' ||
      ctx.score.handResult.id === 'FOUR_STRAIGHT' ||
      ctx.score.extraBonuses.some((b) => b.id === 'threeStraight' || b.id === 'fourStraight'),
  },
  {
    id: 'monochromeMaster',
    emoji: '⚫',
    label: 'Monochrome Master',
    description: "Land a hand that's all one color.",
    check: (ctx) => ctx.score.extraBonuses.some((b) => b.id === 'monochrome'),
  },
  {
    id: 'firstSteps',
    emoji: '🥉',
    label: 'First Steps',
    description: 'Play your first Cardle.',
    check: (ctx) => ctx.stats.gamesPlayed >= 1,
  },
  {
    id: 'dedicated',
    emoji: '🔥',
    label: 'Dedicated',
    description: 'Play 7 games.',
    check: (ctx) => ctx.stats.gamesPlayed >= 7,
  },
  {
    id: 'veteran',
    emoji: '💪',
    label: 'Veteran',
    description: 'Play 30 games.',
    check: (ctx) => ctx.stats.gamesPlayed >= 30,
  },
  {
    id: 'collector',
    emoji: '📖',
    label: 'Collector',
    description: 'Achieve every hand category at least once.',
    check: (ctx) => ctx.stats.handsSeen.length >= HAND_RANKS.length,
  },
  {
    id: 'multiplePersonalities',
    emoji: '🎭',
    label: 'Multiple Personalities',
    description: 'Unlock 5 different personality types.',
    check: (ctx) => ctx.stats.personalitiesSeen.length >= 5,
  },
  {
    id: 'personalityCollector',
    emoji: '🌈',
    label: 'Personality Collector',
    description: 'Unlock every personality type.',
    check: (ctx) => ctx.stats.personalitiesSeen.length >= PERSONALITIES.length,
  },
  // One achievement per score grade (§11k, owner request: "make badges titles
  // and achievements for earning these"). Generated from the grade ladder rather
  // than hand-listed, so adding or renaming a grade can't leave the two lists
  // disagreeing — the same reasoning as badges being generated from achievements
  // (§11e).
  //
  // "or better" for every grade EXCEPT the floor: `Busted or better` would be
  // true of literally every run, so the bottom rung is an exact match instead —
  // a wooden spoon you actually have to earn by whiffing.
  ...SCORE_GRADES_ASCENDING.map((grade, index) => ({
    id: `grade_${grade.id}`,
    emoji: grade.emoji,
    label: grade.label,
    description:
      index === 0
        ? `Finish a run graded ${grade.label} — someone has to.`
        : `Finish a run graded ${grade.label} or better (${grade.min.toLocaleString()}+ points).`,
    check:
      index === 0
        ? (ctx) => gradeForScore(ctx.score.total).id === grade.id
        : (ctx) => reachesGrade(ctx.score.total, grade.id),
  })),
  {
    id: 'newPersonalBest',
    emoji: '📈',
    label: 'New Personal Best',
    description: 'Beat your previous best score.',
    check: (ctx) => ctx.stats.gamesPlayed > 1 && ctx.score.total > 0 && ctx.score.total === ctx.stats.bestScore,
  },
];

/**
 * @param {object} ctx
 * @param {object} ctx.score - scoreRun() result
 * @param {number} ctx.decisionRating
 * @param {number} ctx.discardedCount
 * @param {number} ctx.maxDiscards
 * @param {object} ctx.stats - from src/state/stats.js, already updated with this run
 * @returns {Array} every achievement definition currently satisfied (not just newly-unlocked ones)
 */
export function evaluateAchievements(ctx) {
  return ACHIEVEMENTS.filter((a) => a.check(ctx));
}
