import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { solveOptimalDiscard, findEV, choiceQuality, drawPercentile } from '../src/core/ev-solver.js';
import { optimalDiscardBonus, OPTIMAL_DISCARD_MAX_BONUS } from '../src/core/scoring.js';
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

describe('choiceQuality', () => {
  test('is 1 for the best available discard', () => {
    assert.equal(choiceQuality({ chosenEV: 110, bestEV: 110, worstEV: 40 }), 1);
  });

  test('is 0 for the worst available discard', () => {
    assert.equal(choiceQuality({ chosenEV: 40, bestEV: 110, worstEV: 40 }), 0);
  });

  test('places a middling choice between them', () => {
    assert.equal(choiceQuality({ chosenEV: 75, bestEV: 110, worstEV: 40 }), 0.5);
  });

  test('is null when every option had the same EV — no decision to grade', () => {
    assert.equal(choiceQuality({ chosenEV: 110, bestEV: 110, worstEV: 110 }), null);
  });

  test('is null rather than NaN on a missing or malformed context', () => {
    assert.equal(choiceQuality(), null);
    assert.equal(choiceQuality({ chosenEV: 1, bestEV: 2 }), null);
    assert.equal(choiceQuality({ chosenEV: NaN, bestEV: 2, worstEV: 0 }), null);
  });

  test('clamps a chosen EV outside the solved range instead of leaving the meter over 100%', () => {
    assert.equal(choiceQuality({ chosenEV: 200, bestEV: 110, worstEV: 40 }), 1);
    assert.equal(choiceQuality({ chosenEV: 10, bestEV: 110, worstEV: 40 }), 0);
  });

  // THE DEFECT THE REWRITE EXISTED TO FIX, stated directly rather than as a
  // set of cases. The old rating was actualScore / bestEV, so it moved with the
  // draw; this asserts the property that replaced it — the rating is a function
  // of the CHOICE alone, and no outcome can change it.
  test('does not depend on what was actually drawn', () => {
    const context = { chosenEV: 75, bestEV: 110, worstEV: 40 };
    const rating = choiceQuality(context);
    // There is nowhere to even pass an outcome, which is the point; the same
    // context scored before and after a hypothetical draw must agree.
    assert.equal(choiceQuality({ ...context }), rating);
    assert.equal(rating, 0.5);
  });

  test('agrees with optimalDiscardBonus, which scores the same quantity', () => {
    for (const chosenEV of [40, 57.5, 75, 92.5, 110]) {
      const context = { chosenEV, bestEV: 110, worstEV: 40 };
      assert.equal(
        optimalDiscardBonus(context),
        Math.round(choiceQuality(context) * OPTIMAL_DISCARD_MAX_BONUS),
      );
    }
  });
});

describe('drawPercentile', () => {
  // A tiny closed universe so the answer can be counted by hand: keep four
  // cards, draw one from a three-card pile.
  const kept = [c(9, 'S'), c(9, 'H'), c(4, 'C'), c(5, 'S')];
  const pile = [c(9, 'D'), c(2, 'D'), c(7, 'C')];
  const hand = [...kept, c(13, 'D')]; // the 5th card is the one discarded
  const scoreWith = (card) => evaluateHand([...kept, card]).score;

  test('is null when no cards were drawn — holding pat is not luck', () => {
    assert.equal(drawPercentile(hand, pile, [], 1000), null);
  });

  // Derived from the real score multiset rather than hardcoded. Two of these
  // three draws tie — a rank-scaled Pair is scored on the pair's rank, so
  // drawing the 2 and drawing the 7 both leave a pair of nines worth exactly
  // the same — and a hand-written 0.5/3 quietly encoded the assumption that
  // they wouldn't. Counting is also the clearest statement of the mid-rank
  // convention this function uses.
  const expectedPercentile = (target) => {
    const scores = pile.map(scoreWith);
    const below = scores.filter((s) => s < target).length;
    const equal = scores.filter((s) => s === target).length;
    return (below + equal / 2) / scores.length;
  };

  test('ranks the best possible draw at the top', () => {
    const best = Math.max(...pile.map(scoreWith));
    // Mid-rank: the realised draw is itself one of the combinations counted,
    // so even the outright best cannot read a flat 1 here.
    assert.equal(drawPercentile(hand, pile, [4], best), expectedPercentile(best));
    assert.ok(drawPercentile(hand, pile, [4], best) > 0.5);
  });

  test('ranks the worst possible draw at the bottom', () => {
    const worst = Math.min(...pile.map(scoreWith));
    assert.equal(drawPercentile(hand, pile, [4], worst), expectedPercentile(worst));
    assert.ok(drawPercentile(hand, pile, [4], worst) < 0.5);
  });

  test('splits tied draws evenly rather than ranking one above the other', () => {
    const scores = pile.map(scoreWith);
    const tied = scores.find((s) => scores.filter((other) => other === s).length > 1);
    assert.ok(tied !== undefined, 'fixture must contain a tie for this to test anything');
    // Two of three tie at the bottom: (0 below + 2/2 equal) / 3.
    assert.equal(drawPercentile(hand, pile, [4], tied), 1 / 3);
  });

  test('is a percentile, so it never leaves 0-1', () => {
    for (const card of pile) {
      const p = drawPercentile(hand, pile, [4], scoreWith(card));
      assert.ok(p >= 0 && p <= 1, `${p} out of range`);
    }
  });

  // Luck must not be movable by playing better or worse — the old drawFortune
  // graded the result against the player's OWN chosen EV, so a deliberately
  // bad discard lowered the bar and inflated the meter (measured correlation
  // with choice quality: -0.49). A percentile has no such input.
  test('does not read the chosen EV, so a worse choice cannot inflate it', () => {
    const median = pile.map(scoreWith).sort((a, b) => a - b)[1];
    // Same draw, same result, scored identically no matter what else was on
    // the table — there is no EV parameter to pass.
    assert.equal(drawPercentile(hand, pile, [4], median), drawPercentile(hand, pile, [4], median));
    assert.equal(drawPercentile.length, 4); // (hand, pile, discardIndices, actualScore)
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
