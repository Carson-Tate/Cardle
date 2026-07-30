import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { solveOptimalDiscard, findEV, decisionRating } from '../src/core/ev-solver.js';
import { evaluateHand } from '../src/core/hand-evaluator.js';

const c = (rank, suit) => ({ rank, suit });

// Hand scores are rank-scaled (a Pair of 9s isn't the same score as a Pair
// of 2s), and Three/Four Straight are now real hand categories too, so
// these are derived from the actual resulting hands below rather than a
// hand-derived formula that could silently drift with the next rebalance.
const PAIR_SCORE = evaluateHand([c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]).score;
const TRIPS_SCORE = evaluateHand([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(4, 'C'), c(5, 'S')]).score;
// Discarding one 9 and drawing 3H instead of 9D leaves 9H,2D,4C,5S,3H — no
// pair, but 2-3-4-5 is a hidden Four Straight (not High Card's 0).
const FOUR_STRAIGHT_SCORE = evaluateHand([c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S'), c(3, 'H')]).score;
const CHASE_PAIR_EV = (PAIR_SCORE + FOUR_STRAIGHT_SCORE) / 2;

// Discarding a kicker's "miss" (drawing 3H instead of 9D) doesn't always
// land the same category — whichever kicker was discarded decides which
// OTHER two kickers stay behind, and 2/3/4/5 happen to be consecutive
// enough that some leftovers form a hidden Three Straight alongside the
// surviving pair of 9s, which now correctly outranks a plain Pair
// (DESIGN.md §3w/§3x — a coexisting run wins classification over a weaker
// pair pattern, same fix as the Four Straight case above). So each kicker
// discard below gets its own EV, derived from its own actual miss-hand,
// rather than assuming all three are interchangeable.
//
// Discard [2] (the 2D): leftover kickers 4,5 + miss draw 3H -> 9,9,4,5,3,
// where 3-4-5 is a coexisting run -> Three Straight, not Pair.
const DISCARD_2D_MISS_SCORE = evaluateHand([c(9, 'S'), c(9, 'H'), c(4, 'C'), c(5, 'S'), c(3, 'H')]).score;
const CHASE_TRIPS_EV_VIA_2D = (TRIPS_SCORE + DISCARD_2D_MISS_SCORE) / 2;
// Discard [3] (the 4C): leftover kickers 2,5 + miss draw 3H -> 9,9,2,5,3, no
// coexisting run (2-3 is only length 2) -> a plain Pair, same PAIR_SCORE.
const CHASE_TRIPS_EV_VIA_4C = (TRIPS_SCORE + PAIR_SCORE) / 2;
// Discard [4] (the 5S): leftover kickers 2,4 + miss draw 3H -> 9,9,2,4,3,
// where 2-3-4 is a coexisting run -> Three Straight, not Pair.
const DISCARD_5S_MISS_SCORE = evaluateHand([c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(3, 'H')]).score;
const CHASE_TRIPS_EV_VIA_5S = (TRIPS_SCORE + DISCARD_5S_MISS_SCORE) / 2;

// Hand-verifiable small scenario: a pair of 9s with a 2, 4, 5 kicker, and a
// tiny 2-card draw pile so every EV can be checked by hand.
//
// Hand:      9S 9H 2D 4C 5S  (pair)
// Draw pile: 9D 3H
//
// Discard [] (keep all):            pair                                    -> PAIR_SCORE
// Discard [2] (the 2D):   +9D -> trips, +3H -> Three Straight (3-4-5) -> EV (trips+threeStraight)/2
// Discard [3] (the 4C):   +9D -> trips, +3H -> pair                  -> EV (trips+pair)/2
// Discard [4] (the 5S):   +9D -> trips, +3H -> Three Straight (2-3-4) -> EV (trips+threeStraight)/2
// Discard [0] (a 9):      +9D -> pair,  +3H -> Four Straight (2-3-4-5) -> EV (pair+fourStraight)/2
// Discard [1] (the other 9): same as [0] by symmetry                  -> EV (pair+fourStraight)/2
const originalHand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
const drawPile = [c(9, 'D'), c(3, 'H')];

describe('solveOptimalDiscard', () => {
  test('computes EV for the no-discard option', () => {
    const { evByDiscard } = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1 });
    assert.equal(findEV(evByDiscard, []), PAIR_SCORE);
  });

  test('computes EV for discarding a kicker (chases trips)', () => {
    const { evByDiscard } = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1 });
    assert.equal(findEV(evByDiscard, [2]), CHASE_TRIPS_EV_VIA_2D);
    assert.equal(findEV(evByDiscard, [3]), CHASE_TRIPS_EV_VIA_4C);
    assert.equal(findEV(evByDiscard, [4]), CHASE_TRIPS_EV_VIA_5S);
  });

  test('computes EV for discarding half the pair (worse play)', () => {
    const { evByDiscard } = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1 });
    assert.equal(findEV(evByDiscard, [0]), CHASE_PAIR_EV);
    assert.equal(findEV(evByDiscard, [1]), CHASE_PAIR_EV);
  });

  test('identifies best and worst EV across all legal discards', () => {
    // Worst is discarding nothing (PAIR_SCORE=213) — every other option's
    // miss case lands at least a Three Straight or Four Straight, which now
    // correctly outscores a plain Pair (DESIGN.md §3w/§3x). Best is
    // discarding the 2D: its Three Straight miss (3-4-5) scores higher than
    // the 5S discard's (2-3-4), since Three Straight is rank-scaled by the
    // run's own high card.
    const { best, worst } = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1 });
    assert.equal(best.ev, CHASE_TRIPS_EV_VIA_2D);
    assert.equal(worst.ev, PAIR_SCORE);
  });

  test('throws a useful error for an unevaluated discard combination', () => {
    const { evByDiscard } = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1 });
    assert.throws(() => findEV(evByDiscard, [0, 1]));
  });

  // excludedIndices — Locked Card (Daily Modifiers, DESIGN.md §4): a
  // starting card that can never appear in any candidate discard.
  test('excludedIndices removes every combination touching a locked index', () => {
    const { evByDiscard } = solveOptimalDiscard(originalHand, drawPile, {
      minDiscards: 0,
      maxDiscards: 1,
      excludedIndices: [0],
    });
    assert.ok(evByDiscard.every((entry) => !entry.indices.includes(0)));
    // The excluded index's own single-card discard ([0]) must be gone...
    assert.throws(() => findEV(evByDiscard, [0]));
    // ...but discarding a different single card is still a valid option.
    assert.doesNotThrow(() => findEV(evByDiscard, [2]));
  });

  test('excludedIndices never changes best/worst to a combination that includes it', () => {
    const { best, worst } = solveOptimalDiscard(originalHand, drawPile, {
      minDiscards: 0,
      maxDiscards: 1,
      excludedIndices: [2], // the best play (discard a kicker) normally includes index 2, 3, or 4
    });
    assert.ok(!best.indices.includes(2));
    assert.ok(!worst.indices.includes(2));
  });

  test('an empty excludedIndices (the default) behaves exactly as before', () => {
    const withDefault = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1 });
    const withEmpty = solveOptimalDiscard(originalHand, drawPile, { minDiscards: 0, maxDiscards: 1, excludedIndices: [] });
    assert.deepEqual(withDefault.evByDiscard, withEmpty.evByDiscard);
  });
});

describe('decisionRating', () => {
  test('is 1.0 when the actual score matches the best EV', () => {
    assert.equal(decisionRating(110, 110), 1);
  });

  test('scales proportionally below the best EV', () => {
    assert.equal(decisionRating(55, 110), 0.5);
  });

  test('can exceed 1.0 on a lucky draw beating the average', () => {
    assert.equal(decisionRating(180, 110), 180 / 110);
  });

  test('handles a zero-EV hand without dividing by zero', () => {
    assert.equal(decisionRating(0, 0), 1);
  });
});

describe('performance: full daily range (0-3 discards) solves quickly', () => {
  test('solves a realistic hand against a real 47-card draw pile under 500ms', () => {
    // Build a real 47-card remainder deck (any 47 distinct cards not in the hand).
    const SUITS = ['S', 'H', 'D', 'C'];
    const RANKS = Array.from({ length: 13 }, (_, i) => i + 2);
    const full = SUITS.flatMap((s) => RANKS.map((r) => ({ rank: r, suit: s })));
    const handIds = new Set(originalHand.map((card) => `${card.rank}${card.suit}`));
    const fullDrawPile = full.filter((card) => !handIds.has(`${card.rank}${card.suit}`));
    assert.equal(fullDrawPile.length, 47);

    const start = Date.now();
    const { best } = solveOptimalDiscard(originalHand, fullDrawPile, { minDiscards: 0, maxDiscards: 3 });
    const elapsed = Date.now() - start;

    assert.ok(best.ev > 0);
    assert.ok(elapsed < 500, `solver took ${elapsed}ms, expected < 500ms`);
  });

  // Locks in the allocation removals in evForDiscard/combinationIndices. The
  // 5-discard case (Clean Slate) is the heaviest the game can ask for:
  // C(47,5) = 1,533,939 draws. Measured ~2.4s before the bound below, down
  // from ~3.0s; the bound is deliberately loose enough for a slow CI box but
  // tight enough to catch a real regression (e.g. reintroducing a per-draw
  // array allocation).
  test('the heaviest legal solve (5 discards, Clean Slate) stays bounded', () => {
    const SUITS = ['S', 'H', 'D', 'C'];
    const RANKS = Array.from({ length: 13 }, (_, i) => i + 2);
    const full = SUITS.flatMap((s) => RANKS.map((r) => ({ rank: r, suit: s })));
    const handIds = new Set(originalHand.map((card) => `${card.rank}${card.suit}`));
    const fullDrawPile = full.filter((card) => !handIds.has(`${card.rank}${card.suit}`));

    const start = Date.now();
    const { best } = solveOptimalDiscard(originalHand, fullDrawPile, { minDiscards: 0, maxDiscards: 5 });
    const elapsed = Date.now() - start;

    assert.ok(best.ev > 0);
    assert.ok(elapsed < 8000, `5-discard solve took ${elapsed}ms, expected < 8000ms`);
  });

  test('a joker in the hand is slower (wild-substitution search) but stays bounded', () => {
    // Regression guard for the wild search. The bound tightened from 5000ms
    // to 2000ms once candidateSuitsFor() pruning landed (hand-evaluator.js):
    // when the other cards can't make a flush, the wild's suit provably
    // cannot change the result, so it tries 13 substitutions instead of 52.
    // Measured ~1.1s here, down from ~4.2s.
    const SUITS = ['S', 'H', 'D', 'C'];
    const RANKS = Array.from({ length: 13 }, (_, i) => i + 2);
    const full = SUITS.flatMap((s) => RANKS.map((r) => ({ rank: r, suit: s, rarity: null })));

    const jokerHand = [
      { rank: 9, suit: 'S', rarity: 'joker' },
      { rank: 4, suit: 'H', rarity: null },
      { rank: 7, suit: 'D', rarity: null },
      { rank: 11, suit: 'C', rarity: null },
      { rank: 2, suit: 'S', rarity: null },
    ];
    const handIds = new Set(jokerHand.map((card) => `${card.rank}${card.suit}`));
    const drawPile = full.filter((card) => !handIds.has(`${card.rank}${card.suit}`));
    assert.equal(drawPile.length, 47);

    const start = Date.now();
    const { best } = solveOptimalDiscard(jokerHand, drawPile, { minDiscards: 0, maxDiscards: 3 });
    const elapsed = Date.now() - start;

    assert.ok(best.ev > 0);
    assert.ok(elapsed < 2000, `solver took ${elapsed}ms with a joker present, expected < 2000ms`);
  });
});
