import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBonuses } from '../src/core/bonus-registry.js';
import { evaluateHand } from '../src/core/hand-evaluator.js';

const c = (rank, suit) => ({ rank, suit });

// Builds a full bonus-evaluation context. `finalHand` defaults to also being
// the `originalHand` (most bonuses only care about the final hand) — tests
// that care about the original/final distinction (Comeback Kid) override it.
function ctx({
  finalHand,
  originalHand = finalHand,
  discardedCards = [],
  discardedCount = 0,
  maxDiscards = 3,
}) {
  return {
    originalHand,
    finalHand,
    discardedCards,
    discardedCount,
    maxDiscards,
    originalHandResult: evaluateHand(originalHand),
    finalHandResult: evaluateHand(finalHand),
  };
}

function idsOf(finalHand, overrides = {}) {
  return evaluateBonuses(ctx({ finalHand, ...overrides })).map((b) => b.id);
}

describe('rainbow', () => {
  test('fires when all 4 suits appear', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(13, 'C'), c(7, 'S')];
    assert.ok(idsOf(hand).includes('rainbow'));
  });
  test('does not fire with only 3 suits', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(13, 'D'), c(7, 'S')];
    assert.ok(!idsOf(hand).includes('rainbow'));
  });
});

describe('monochrome', () => {
  test('fires when every card is the same color', () => {
    const hand = [c(2, 'H'), c(5, 'H'), c(9, 'D'), c(13, 'D'), c(7, 'H')];
    assert.ok(idsOf(hand).includes('monochrome'));
  });
  test('does not fire when colors are mixed', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(13, 'D'), c(7, 'H')];
    assert.ok(!idsOf(hand).includes('monochrome'));
  });
});

describe('royalTrio', () => {
  test('fires when J, Q, and K are all present', () => {
    const hand = [c(11, 'H'), c(12, 'S'), c(13, 'D'), c(2, 'C'), c(5, 'C')];
    assert.ok(idsOf(hand).includes('royalTrio'));
  });
  test('does not fire when one is missing', () => {
    const hand = [c(11, 'H'), c(12, 'S'), c(9, 'D'), c(2, 'C'), c(5, 'C')];
    assert.ok(!idsOf(hand).includes('royalTrio'));
  });
});

describe('smallStack', () => {
  test('fires when every card is rank 6 or lower', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(4, 'D'), c(5, 'C'), c(6, 'H')];
    assert.ok(idsOf(hand).includes('smallStack'));
  });
  test('does not fire with a 7 or higher', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(4, 'D'), c(5, 'C'), c(7, 'H')];
    assert.ok(!idsOf(hand).includes('smallStack'));
  });
});

describe('primeCut', () => {
  test('fires when every rank is prime', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(5, 'D'), c(7, 'C'), c(13, 'H')];
    assert.ok(idsOf(hand).includes('primeCut'));
  });
  test('does not fire with a non-prime rank', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(4, 'D'), c(7, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand).includes('primeCut'));
  });
});

describe('bigNumbers / babySteps', () => {
  test('bigNumbers fires when the rank sum is 50+', () => {
    const hand = [c(10, 'H'), c(11, 'S'), c(12, 'D'), c(13, 'C'), c(14, 'H')]; // sum 60
    assert.ok(idsOf(hand).includes('bigNumbers'));
    assert.ok(!idsOf(hand).includes('babySteps'));
  });
  test('babySteps fires when the rank sum is 30 or under', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(4, 'D'), c(5, 'C'), c(6, 'H')]; // sum 20
    assert.ok(idsOf(hand).includes('babySteps'));
    assert.ok(!idsOf(hand).includes('bigNumbers'));
  });
});

describe('bookends', () => {
  test('fires when min + max rank equals 16', () => {
    const hand = [c(3, 'H'), c(5, 'S'), c(7, 'D'), c(9, 'C'), c(13, 'H')]; // 3 + 13
    assert.ok(idsOf(hand).includes('bookends'));
  });
  test('does not fire otherwise', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(7, 'D'), c(9, 'C'), c(13, 'H')]; // 2 + 13 = 15
    assert.ok(!idsOf(hand).includes('bookends'));
  });
});

// Three Straight/Four Straight are now real hand CATEGORIES (hand-evaluator.js,
// §3w), not just extra bonuses — a bare 3-run or 4-run with no pair is now
// scored as its own "HAND" badge, not this extra bonus. This extra bonus only
// fires when a run is hiding INSIDE a stronger made hand; when the run itself
// is the whole story, it must NOT also fire here, or the same run would get
// double-credited as both the "HAND" badge and an "extra bonus" badge.
//
// Note: a Pair or Two Pair can no longer be the "stronger made hand" in these
// examples — hand-evaluator.js's classification now picks whichever category
// is odds-proportionally RARER when a run coexists with a pair pattern
// (DESIGN.md §3w/§3x), and Three/Four Straight both outrank Pair, so a
// Pair+run hand reclassifies as the run itself rather than staying Pair. The
// examples below use a Flush (whose 5 cards can still separately form a
// run) or Three of a Kind (whose trip rank plus 2 kickers can still form a
// 3-run) instead, which genuinely do outrank Four/Three Straight.
describe('fourStraight', () => {
  test('fires when a 4-run coexists with a Flush (the flush is the primary hand; the run is a bonus)', () => {
    // All diamonds (Flush), with 5-6-7-8 also forming a 4-run.
    const hand = [c(5, 'D'), c(6, 'D'), c(7, 'D'), c(8, 'D'), c(13, 'D')];
    assert.equal(evaluateHand(hand).id, 'FLUSH');
    assert.ok(idsOf(hand).includes('fourStraight'));
  });
  test('recognizes an Ace-low near run (A-2-3-4) coexisting with a Flush', () => {
    // All diamonds (Flush), with A-2-3-4 (ace low) forming the 4-run.
    const hand = [c(14, 'D'), c(2, 'D'), c(3, 'D'), c(4, 'D'), c(9, 'D')];
    assert.equal(evaluateHand(hand).id, 'FLUSH');
    assert.ok(idsOf(hand).includes('fourStraight'));
  });
  test('does NOT fire when the 4-run IS the primary hand (already credited as the Four Straight category — no double count)', () => {
    const hand = [c(4, 'H'), c(5, 'S'), c(6, 'D'), c(7, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand).includes('fourStraight'));
  });
  test('does not fire on an actual straight', () => {
    const hand = [c(4, 'H'), c(5, 'S'), c(6, 'D'), c(7, 'C'), c(8, 'H')];
    assert.ok(!idsOf(hand).includes('fourStraight'));
  });
  test('does not fire when no 4-card run exists', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand).includes('fourStraight'));
  });
});

describe('threeStraight', () => {
  test('fires when a 3-run coexists with Three of a Kind (the trips are the primary hand; the run is a bonus)', () => {
    // Trip 8s, with 8-9-10 forming a 3-run using the trip rank.
    const hand = [c(8, 'H'), c(8, 'S'), c(8, 'D'), c(9, 'C'), c(10, 'H')];
    assert.equal(evaluateHand(hand).id, 'THREE_OF_A_KIND');
    assert.ok(idsOf(hand).includes('threeStraight'));
  });
  test('recognizes an Ace-low 3-run (A-2-3) coexisting with Three of a Kind', () => {
    // Trip Aces, with A-2-3 (ace low) forming the 3-run.
    const hand = [c(14, 'H'), c(14, 'S'), c(14, 'D'), c(2, 'C'), c(3, 'H')];
    assert.equal(evaluateHand(hand).id, 'THREE_OF_A_KIND');
    assert.ok(idsOf(hand).includes('threeStraight'));
  });
  test('does NOT fire when the 3-run IS the primary hand (already credited as the Three Straight category — no double count)', () => {
    const hand = [c(8, 'H'), c(9, 'S'), c(10, 'D'), c(2, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand).includes('threeStraight'));
  });
  test('does NOT fire when the run is actually 4 long AND is the primary hand (that\'s the Four Straight category instead)', () => {
    const hand = [c(4, 'H'), c(5, 'S'), c(6, 'D'), c(7, 'C'), c(13, 'H')];
    const ids = idsOf(hand);
    assert.ok(!ids.includes('threeStraight'));
    assert.ok(!ids.includes('fourStraight'));
  });
  test('does not fire on an actual straight (that\'s just a straight)', () => {
    const hand = [c(4, 'H'), c(5, 'S'), c(6, 'D'), c(7, 'C'), c(8, 'H')];
    const ids = idsOf(hand);
    assert.ok(!ids.includes('threeStraight'));
    assert.ok(!ids.includes('fourStraight'));
  });
  test('does not fire when no 3-card run exists', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand).includes('threeStraight'));
  });
});

describe('noWaste', () => {
  test('fires when every discarded card is rank 8 or lower', () => {
    const hand = [c(9, 'H'), c(9, 'S'), c(2, 'D'), c(4, 'C'), c(5, 'H')];
    const ids = idsOf(hand, { discardedCards: [c(2, 'D'), c(8, 'S')], discardedCount: 2 });
    assert.ok(ids.includes('noWaste'));
  });
  test('does not fire if any discarded card is rank 9+', () => {
    const hand = [c(9, 'H'), c(9, 'S'), c(2, 'D'), c(4, 'C'), c(5, 'H')];
    const ids = idsOf(hand, { discardedCards: [c(2, 'D'), c(9, 'S')], discardedCount: 2 });
    assert.ok(!ids.includes('noWaste'));
  });
  test('does not fire with zero discards', () => {
    const hand = [c(9, 'H'), c(9, 'S'), c(2, 'D'), c(4, 'C'), c(5, 'H')];
    assert.ok(!idsOf(hand, { discardedCards: [], discardedCount: 0 }).includes('noWaste'));
  });
});

describe('fullSend', () => {
  test('fires when discards used equals the day\'s max', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.ok(idsOf(hand, { discardedCount: 3, maxDiscards: 3 }).includes('fullSend'));
  });
  test('does not fire under the max', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand, { discardedCount: 2, maxDiscards: 3 }).includes('fullSend'));
  });
  test('does not fire when maxDiscards is 0 (guards a 0-equals-0 false positive)', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand, { discardedCount: 0, maxDiscards: 0 }).includes('fullSend'));
  });
});

describe('comebackKid', () => {
  test('fires when a High Card opener turns into a scoring final hand', () => {
    const originalHand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]; // high card
    const finalHand = [c(9, 'H'), c(9, 'S'), c(2, 'D'), c(4, 'C'), c(5, 'H')]; // pair
    assert.ok(idsOf(finalHand, { originalHand }).includes('comebackKid'));
  });
  test('does not fire when the opener was already scoring', () => {
    const originalHand = [c(9, 'H'), c(9, 'S'), c(2, 'D'), c(4, 'C'), c(5, 'H')]; // already a pair
    const finalHand = [c(9, 'H'), c(9, 'S'), c(9, 'D'), c(4, 'C'), c(5, 'H')]; // trips
    assert.ok(!idsOf(finalHand, { originalHand }).includes('comebackKid'));
  });
});

describe('jackpotDigits / lucky21', () => {
  test('jackpotDigits fires on a rank sum that is a multiple of 10', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]; // sum 40
    assert.ok(idsOf(hand).includes('jackpotDigits'));
  });
  test('lucky21 fires when the rank sum is exactly 21', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(4, 'D'), c(5, 'C'), c(7, 'H')]; // sum 21
    assert.ok(idsOf(hand).includes('lucky21'));
    assert.ok(!idsOf(hand).includes('jackpotDigits')); // 21 isn't a multiple of 10
  });
});

describe('steadyHand', () => {
  test('fires whenever nothing was discarded, regardless of hand quality', () => {
    const weakHand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]; // high card
    assert.ok(idsOf(weakHand, { discardedCount: 0 }).includes('steadyHand'));
  });
  test('does not fire if any card was discarded', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.ok(!idsOf(hand, { discardedCount: 1 }).includes('steadyHand'));
  });
});

describe('evaluateBonuses', () => {
  test('multiple bonuses can stack on the same hand', () => {
    const hand = [c(2, 'H'), c(3, 'H'), c(4, 'H'), c(5, 'H'), c(6, 'H')]; // straight flush, low, mono, small
    const results = evaluateBonuses(ctx({ finalHand: hand }));
    const ids = results.map((b) => b.id);
    assert.ok(ids.includes('monochrome'));
    assert.ok(ids.includes('smallStack'));
    assert.ok(ids.includes('babySteps'));
    // it's a straight flush, so fourStraight should NOT also fire
    assert.ok(!ids.includes('fourStraight'));
  });

  test('every returned bonus carries its point value and emoji', () => {
    const hand = [c(2, 'H'), c(3, 'H'), c(9, 'S'), c(10, 'D'), c(13, 'C')];
    const results = evaluateBonuses(ctx({ finalHand: hand }));
    for (const bonus of results) {
      assert.ok(bonus.points > 0);
      assert.equal(typeof bonus.emoji, 'string');
      assert.equal(typeof bonus.label, 'string');
    }
  });
});
