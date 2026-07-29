// A growing list of small named bonuses — the RNGDLE-style "pile of
// interesting things that happened" layer on top of hand-rank scoring.
// Each entry is a pure, independent check; any number can fire on the same
// hand and they all stack. Kept individually small (30-90 pts, scaled ×5
// with the rest of the point system — see scoring.js) so no single one
// distorts hand-rank ordering — the fun is in how many land at once, not
// any one of them being huge.
//
// `description` and `highlight` (owner request: a per-bonus explanation +
// visual proof, "like the attached picture" — RNGDLE's badge breakdown)
// feed the score-breakdown UI (board.js): `description` is a one-line plain
// -English restatement of `check`'s condition, and `highlight(context)`
// returns which of the 5 final-hand card indices are the actual evidence —
// e.g. the J/Q/K for Royal Trio, or all 5 for a whole-hand condition like
// Rainbow. Bonuses whose condition isn't about *which* final-hand cards
// (No Waste is about discards; Full Send is about a count) return `[]` —
// the UI just omits the card-proof strip for those, showing the
// description alone.
//
// To add a new one: append an entry here. Nothing else needs to change —
// scoring.js sums whatever fires, and the UI lists whatever's non-empty.

// longestConsecutiveRunIndices now lives in hand-evaluator.js (§3w) — Three
// Straight/Four Straight were promoted from extra bonuses to real hand
// categories, so the run-detection logic moved to where hand CATEGORIES are
// decided.
import { longestConsecutiveRunIndices } from './hand-evaluator.js';

const COLOR_BY_SUIT = { S: 'black', C: 'black', H: 'red', D: 'red' };
const PRIMES = new Set([2, 3, 5, 7, 11, 13]);
const ALL_INDICES = [0, 1, 2, 3, 4];

function ranksOf(cards) {
  return cards.map((card) => card.rank);
}

function sumRanks(cards) {
  return ranksOf(cards).reduce((a, b) => a + b, 0);
}

function longestConsecutiveRun(cards) {
  return longestConsecutiveRunIndices(cards).length;
}

function minMaxRankIndices(cards) {
  const ranks = ranksOf(cards);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  return cards.reduce((acc, c, i) => {
    if (c.rank === min || c.rank === max) acc.push(i);
    return acc;
  }, []);
}

export const BONUS_DEFINITIONS = [
  {
    id: 'rainbow',
    emoji: '🌈',
    label: 'Rainbow',
    points: 50,
    description: 'All 4 suits appear in the final hand.',
    check: ({ finalHand }) => new Set(finalHand.map((c) => c.suit)).size === 4,
    highlight: () => ALL_INDICES,
  },
  {
    id: 'monochrome',
    emoji: '⚫',
    label: 'Monochrome',
    points: 75,
    description: 'Every card is the same color.',
    check: ({ finalHand }) => new Set(finalHand.map((c) => COLOR_BY_SUIT[c.suit])).size === 1,
    highlight: () => ALL_INDICES,
  },
  {
    id: 'royalTrio',
    emoji: '🃏',
    label: 'Royal Trio',
    points: 75,
    description: 'Hand contains a Jack, Queen, and King.',
    check: ({ finalHand }) => {
      const ranks = new Set(ranksOf(finalHand));
      return ranks.has(11) && ranks.has(12) && ranks.has(13);
    },
    highlight: ({ finalHand }) => finalHand.reduce((acc, c, i) => (c.rank >= 11 && c.rank <= 13 ? [...acc, i] : acc), []),
  },
  {
    id: 'smallStack',
    emoji: '🌱',
    label: 'Small Stack',
    points: 60,
    description: 'Every card is rank 6 or lower.',
    check: ({ finalHand }) => finalHand.every((c) => c.rank <= 6),
    highlight: () => ALL_INDICES,
  },
  {
    id: 'primeCut',
    emoji: '🧮',
    label: 'Prime Cut',
    points: 90,
    description: 'Every rank is prime (2, 3, 5, 7, 11, 13).',
    check: ({ finalHand }) => finalHand.every((c) => PRIMES.has(c.rank)),
    highlight: () => ALL_INDICES,
  },
  {
    id: 'bigNumbers',
    emoji: '🔢',
    label: 'Big Numbers',
    points: 50,
    description: 'The 5 ranks add up to 50 or more.',
    check: ({ finalHand }) => sumRanks(finalHand) >= 50,
    highlight: () => ALL_INDICES,
  },
  {
    id: 'babySteps',
    emoji: '🐣',
    label: 'Baby Steps',
    points: 50,
    description: 'The 5 ranks add up to 30 or less.',
    check: ({ finalHand }) => sumRanks(finalHand) <= 30,
    highlight: () => ALL_INDICES,
  },
  {
    id: 'bookends',
    emoji: '🦄',
    label: 'Bookends',
    points: 40,
    description: 'Lowest rank + highest rank equals 16.',
    check: ({ finalHand }) => {
      const ranks = ranksOf(finalHand);
      return Math.min(...ranks) + Math.max(...ranks) === 16;
    },
    highlight: ({ finalHand }) => minMaxRankIndices(finalHand),
  },
  {
    // Three Straight/Four Straight (below) are now real hand CATEGORIES
    // (hand-evaluator.js, §3w) — this extra bonus only fires when a run is
    // hiding INSIDE a stronger made hand (e.g. a Pair with a 4-straight
    // sitting alongside it), not when the run itself already IS the primary
    // hand. Without the `finalHandResult.id` exclusion this would double-
    // credit the exact same run as both the "HAND" badge and an "extra
    // bonus" badge.
    id: 'threeStraight',
    emoji: '🪜',
    label: 'Three Straight',
    points: 30,
    description: 'The longest run of consecutive ranks in the hand is exactly 3 (e.g. 8, 9, 10).',
    check: ({ finalHand, finalHandResult }) =>
      finalHandResult.id !== 'THREE_STRAIGHT' && finalHandResult.id !== 'FOUR_STRAIGHT' && longestConsecutiveRun(finalHand) === 3,
    highlight: ({ finalHand }) => longestConsecutiveRunIndices(finalHand).indices,
  },
  {
    id: 'fourStraight',
    emoji: '🌉',
    label: 'Four Straight',
    points: 60,
    description: 'The longest run of consecutive ranks in the hand is exactly 4 — one card short of a straight.',
    check: ({ finalHand, finalHandResult }) =>
      finalHandResult.id !== 'THREE_STRAIGHT' && finalHandResult.id !== 'FOUR_STRAIGHT' && longestConsecutiveRun(finalHand) === 4,
    highlight: ({ finalHand }) => longestConsecutiveRunIndices(finalHand).indices,
  },
  {
    id: 'noWaste',
    emoji: '🧹',
    label: 'No Waste',
    points: 40,
    description: 'Every card you discarded was rank 8 or lower.',
    check: ({ discardedCards }) => discardedCards.length > 0 && discardedCards.every((c) => c.rank <= 8),
    highlight: () => [], // about the discarded cards, not the final hand — no final-hand proof to show
  },
  {
    id: 'fullSend',
    emoji: '🎲',
    label: 'Full Send',
    points: 30,
    description: "Discarded the maximum number of cards allowed today.",
    check: ({ discardedCount, maxDiscards }) => maxDiscards > 0 && discardedCount === maxDiscards,
    highlight: () => [], // about a count, not specific cards
  },
  {
    id: 'comebackKid',
    emoji: '🌟',
    label: 'Comeback Kid',
    points: 30,
    description: 'Opening hand was High Card, but the final hand still scores.',
    check: ({ originalHandResult, finalHandResult }) =>
      originalHandResult.id === 'HIGH_CARD' && finalHandResult.score > 0,
    highlight: () => ALL_INDICES,
  },
  {
    id: 'jackpotDigits',
    emoji: '🎰',
    label: 'Jackpot Digits',
    points: 30,
    description: 'The 5 ranks add up to a multiple of 10.',
    check: ({ finalHand }) => sumRanks(finalHand) % 10 === 0,
    highlight: () => ALL_INDICES,
  },
  {
    id: 'lucky21',
    emoji: '💯',
    label: 'Lucky 21',
    points: 75,
    description: 'The 5 ranks add up to exactly 21.',
    check: ({ finalHand }) => sumRanks(finalHand) === 21,
    highlight: () => ALL_INDICES,
  },
  {
    // Unconditional — fires for holding pat regardless of hand quality.
    // Distinct from the ⭐ Perfect Keep skill bonus in scoring.js, which only
    // fires when holding pat *and* the hand is already excellent; this one
    // is the simple "you didn't discard anything" reward the other doesn't
    // cover, and the two stack when both apply.
    id: 'steadyHand',
    emoji: '✋',
    label: 'Steady Hand',
    points: 40,
    description: 'Discarded zero cards, regardless of hand quality.',
    check: ({ discardedCount }) => discardedCount === 0,
    highlight: () => ALL_INDICES,
  },
];

/**
 * Runs every bonus definition against the given run context and returns
 * only the ones that fired, in registry order.
 *
 * @param {object} context
 * @param {Card[]} context.originalHand
 * @param {Card[]} context.finalHand
 * @param {Card[]} context.discardedCards
 * @param {number} context.discardedCount
 * @param {number} context.maxDiscards
 * @param {{id: string, score: number}} context.originalHandResult
 * @param {{id: string, score: number}} context.finalHandResult
 */
export function evaluateBonuses(context) {
  return BONUS_DEFINITIONS.filter((bonus) => bonus.check(context)).map(({ id, emoji, label, points, description, highlight }) => ({
    id,
    emoji,
    label,
    points,
    description,
    highlightIndices: highlight(context),
  }));
}
