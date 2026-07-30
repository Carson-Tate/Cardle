import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHand, handStrengthIndex, HAND_RANKS, scoreForHandId } from '../src/core/hand-evaluator.js';

const c = (rank, suit) => ({ rank, suit });
const j = (rank = 2, suit = 'S') => ({ rank, suit, rarity: 'joker' }); // a wild joker card; its own rank/suit is irrelevant

describe('evaluateHand', () => {
  test('Royal Flush', () => {
    const hand = [c(14, 'S'), c(13, 'S'), c(12, 'S'), c(11, 'S'), c(10, 'S')];
    const result = evaluateHand(hand);
    assert.equal(result.id, 'ROYAL_FLUSH');
    assert.equal(result.score, scoreForHandId('ROYAL_FLUSH'));
  });

  test('Straight Flush (non-royal)', () => {
    const hand = [c(9, 'H'), c(8, 'H'), c(7, 'H'), c(6, 'H'), c(5, 'H')];
    assert.equal(evaluateHand(hand).id, 'STRAIGHT_FLUSH');
  });

  test('Straight Flush wheel (A-2-3-4-5)', () => {
    const hand = [c(14, 'C'), c(2, 'C'), c(3, 'C'), c(4, 'C'), c(5, 'C')];
    assert.equal(evaluateHand(hand).id, 'STRAIGHT_FLUSH');
  });

  test('Four of a Kind', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(2, 'S')];
    assert.equal(evaluateHand(hand).id, 'FOUR_OF_A_KIND');
  });

  test('Full House', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), c(2, 'S')];
    assert.equal(evaluateHand(hand).id, 'FULL_HOUSE');
  });

  test('Flush', () => {
    const hand = [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')];
    assert.equal(evaluateHand(hand).id, 'FLUSH');
  });

  test('Straight', () => {
    const hand = [c(9, 'S'), c(8, 'H'), c(7, 'D'), c(6, 'C'), c(5, 'S')];
    assert.equal(evaluateHand(hand).id, 'STRAIGHT');
  });

  test('Straight wheel (A-2-3-4-5, mixed suits)', () => {
    const hand = [c(14, 'S'), c(2, 'H'), c(3, 'D'), c(4, 'C'), c(5, 'S')];
    assert.equal(evaluateHand(hand).id, 'STRAIGHT');
  });

  test('Ace-high is not a wraparound straight (K-A-2-3-4 is not a straight)', () => {
    const hand = [c(13, 'S'), c(14, 'H'), c(2, 'D'), c(3, 'C'), c(4, 'S')];
    assert.notEqual(evaluateHand(hand).id, 'STRAIGHT');
  });

  test('Three of a Kind', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), c(5, 'S')];
    assert.equal(evaluateHand(hand).id, 'THREE_OF_A_KIND');
  });

  test('Two Pair', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(2, 'C'), c(5, 'S')];
    assert.equal(evaluateHand(hand).id, 'TWO_PAIR');
  });

  test('Pair', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    assert.equal(evaluateHand(hand).id, 'PAIR');
  });

  test('High Card', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    assert.equal(evaluateHand(hand).id, 'HIGH_CARD');
    assert.equal(evaluateHand(hand).score, 0);
  });

  test('throws on wrong card count', () => {
    assert.throws(() => evaluateHand([c(2, 'S'), c(3, 'H')]));
  });
});

describe('evaluateHand with a wild joker', () => {
  test('completes Four of a Kind from three-of-a-kind plus a kicker', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), j()];
    const result = evaluateHand(hand);
    assert.equal(result.id, 'FOUR_OF_A_KIND');
    // Rank-scaled by the quad's own rank (9), not the flat reference value.
    assert.equal(result.score, evaluateHand([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(2, 'S')]).score);
  });

  test('completes a Royal Flush from four cards of a royal run', () => {
    const hand = [c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), j()];
    const result = evaluateHand(hand);
    assert.equal(result.id, 'ROYAL_FLUSH');
    assert.equal(result.score, scoreForHandId('ROYAL_FLUSH'));
  });

  test('picks the best possible substitution, not just any valid one', () => {
    // 4 hearts in a row (2-3-4-5): the joker could make a plain flush or a
    // plain straight, but the best play is a straight flush — extending
    // UP to 6 (high=6) rather than down to a wheel A-2-3-4-5 (high=5),
    // since Straight Flush is rank-scaled and a higher high card scores more.
    const hand = [c(2, 'H'), c(3, 'H'), c(4, 'H'), c(5, 'H'), j()];
    const result = evaluateHand(hand);
    assert.equal(result.id, 'STRAIGHT_FLUSH');
    assert.deepEqual(result.wildSubstitution, { rank: 6, suit: 'H' });
    assert.equal(result.score, evaluateHand([c(2, 'H'), c(3, 'H'), c(4, 'H'), c(5, 'H'), c(6, 'H')]).score);
  });

  test('sets hasWildJoker on the result when a joker was used', () => {
    const hand = [c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), j()];
    assert.equal(evaluateHand(hand).hasWildJoker, true);
  });

  // Bug: evaluateHand used findIndex, so only the FIRST wild was ever
  // substituted — any second one kept the meaningless rank/suit it happened
  // to be dealt as, making the hand strictly weaker than the player's cards
  // actually allowed. This exact hand evaluated as THREE_STRAIGHT (613).
  test('substitutes EVERY wild in the hand, not just the first', () => {
    const hand = [j(2, 'H'), j(3, 'D'), c(9, 'S'), c(11, 'S'), c(13, 'S')];
    const result = evaluateHand(hand);
    // 10♠ and Q♠ complete 9-10-J-Q-K, all spades.
    assert.equal(result.id, 'STRAIGHT_FLUSH');
    assert.equal(result.score, evaluateHand([c(9, 'S'), c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S')]).score);
  });

  test('exposes every wild substitution keyed by hand position', () => {
    const hand = [j(2, 'H'), j(3, 'D'), c(9, 'S'), c(11, 'S'), c(13, 'S')];
    const { wildSubstitutions, wildSubstitution } = evaluateHand(hand);
    assert.deepEqual(Object.keys(wildSubstitutions).sort(), ['0', '1']);
    // The single-wild `wildSubstitution` field still points at the first one,
    // so every pre-existing caller keeps working unchanged.
    assert.deepEqual(wildSubstitution, wildSubstitutions[0]);
  });

  test('a hand of nothing but wilds resolves without hanging (admin hand builder)', () => {
    const hand = [j(2, 'H'), j(3, 'D'), j(4, 'S'), j(5, 'C'), j(6, 'H')];
    const start = Date.now();
    const result = evaluateHand(hand);
    assert.ok(Date.now() - start < 1000, 'five wilds should not take a full second');
    assert.ok(result.score > 0);
  });

  // candidateSuitsFor() prunes the wild's suit loop to a single suit when the
  // other cards can't possibly make a flush. That's an optimization, so it
  // must not change any result — this pins the equivalence rather than
  // trusting the reasoning.
  test('suit pruning never changes the outcome for flush-impossible hands', () => {
    const cases = [
      [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), j()],
      [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), j()],
      [c(7, 'S'), c(8, 'H'), c(9, 'D'), c(10, 'C'), j()],
      [c(3, 'S'), c(3, 'H'), c(3, 'D'), c(8, 'C'), j()],
    ];
    for (const hand of cases) {
      const result = evaluateHand(hand);
      // Brute-force the same search over all 4 suits x 13 ranks.
      const others = hand.filter((card) => card.rarity !== 'joker');
      let bestScore = -1;
      for (const suit of ['S', 'H', 'D', 'C']) {
        for (let rank = 2; rank <= 14; rank++) {
          const score = evaluateHand([...others, c(rank, suit)]).score;
          if (score > bestScore) bestScore = score;
        }
      }
      assert.equal(result.score, bestScore, `pruned search disagreed for ${JSON.stringify(hand)}`);
    }
  });

  test('does not set hasWildJoker for an ordinary hand', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    assert.ok(!evaluateHand(hand).hasWildJoker);
  });

  test("the joker's own rank/suit is irrelevant to the result", () => {
    const handA = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), j(3, 'D')];
    const handB = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), j(14, 'C')];
    assert.deepEqual(
      { id: evaluateHand(handA).id, score: evaluateHand(handA).score },
      { id: evaluateHand(handB).id, score: evaluateHand(handB).score },
    );
  });
});

// Rank-scaling (owner request: "it should matter what it pairs with... a
// joker paired with a jack will be worth more than a joker paired with a
// 2"). Every category defined by a specific rank (or a run's high card)
// scores along a small range instead of one flat number — verified here
// two ways: (a) higher ranks score strictly more within a category, and
// (b) no category's ceiling can ever cross into the next category's floor,
// so poker-hand ordering can never invert regardless of which ranks formed
// the hand.
describe('rank-scaled hand scores', () => {
  test('a higher-ranked Pair scores strictly more than a lower one', () => {
    const low = evaluateHand([c(2, 'S'), c(2, 'H'), c(4, 'D'), c(6, 'C'), c(8, 'S')]).score;
    const high = evaluateHand([c(14, 'S'), c(14, 'H'), c(4, 'D'), c(6, 'C'), c(8, 'S')]).score;
    assert.ok(high > low);
  });

  test('a higher-ranked Two Pair (by the higher pair) scores strictly more than a lower one', () => {
    const low = evaluateHand([c(3, 'S'), c(3, 'H'), c(2, 'D'), c(2, 'C'), c(9, 'S')]).score;
    const high = evaluateHand([c(14, 'S'), c(14, 'H'), c(2, 'D'), c(2, 'C'), c(9, 'S')]).score;
    assert.ok(high > low);
  });

  test('a higher-ranked Three/Four of a Kind scores strictly more than a lower one', () => {
    const lowTrips = evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(4, 'C'), c(6, 'S')]).score;
    const highTrips = evaluateHand([c(14, 'S'), c(14, 'H'), c(14, 'D'), c(4, 'C'), c(6, 'S')]).score;
    assert.ok(highTrips > lowTrips);

    const lowQuads = evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(2, 'C'), c(6, 'S')]).score;
    const highQuads = evaluateHand([c(14, 'S'), c(14, 'H'), c(14, 'D'), c(14, 'C'), c(6, 'S')]).score;
    assert.ok(highQuads > lowQuads);
  });

  test('a higher-ranked Straight/Flush/Straight Flush (by high card) scores strictly more than a lower one', () => {
    const lowStraight = evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D'), c(4, 'C'), c(5, 'S')]).score; // wheel, high=5
    const highStraight = evaluateHand([c(10, 'S'), c(11, 'H'), c(12, 'D'), c(13, 'C'), c(14, 'S')]).score;
    assert.ok(highStraight > lowStraight);

    const lowFlush = evaluateHand([c(2, 'D'), c(3, 'D'), c(4, 'D'), c(6, 'D'), c(7, 'D')]).score; // non-consecutive
    const highFlush = evaluateHand([c(2, 'D'), c(4, 'D'), c(6, 'D'), c(9, 'D'), c(14, 'D')]).score;
    assert.ok(highFlush > lowFlush);

    const lowStraightFlush = evaluateHand([c(14, 'D'), c(2, 'D'), c(3, 'D'), c(4, 'D'), c(5, 'D')]).score; // wheel
    const highStraightFlush = evaluateHand([c(9, 'D'), c(10, 'D'), c(11, 'D'), c(12, 'D'), c(13, 'D')]).score;
    assert.ok(highStraightFlush > lowStraightFlush);
  });

  test('a Full House scores more with a higher trip rank', () => {
    const low = evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(3, 'C'), c(3, 'S')]).score;
    const high = evaluateHand([c(14, 'S'), c(14, 'H'), c(14, 'D'), c(2, 'C'), c(2, 'S')]).score;
    assert.ok(high > low);
  });

  test('a higher-ranked Three Straight/Four Straight (by the run\'s high card) scores strictly more than a lower one', () => {
    const lowThree = evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D'), c(9, 'C'), c(11, 'S')]).score; // wheel-adjacent A-2-3
    const highThree = evaluateHand([c(12, 'S'), c(13, 'H'), c(14, 'D'), c(2, 'C'), c(5, 'S')]).score;
    assert.ok(highThree > lowThree);

    const lowFour = evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D'), c(4, 'C'), c(9, 'S')]).score; // wheel-adjacent A-2-3-4
    const highFour = evaluateHand([c(11, 'S'), c(12, 'H'), c(13, 'D'), c(14, 'C'), c(2, 'S')]).score;
    assert.ok(highFour > lowFour);
  });

  test('rank-scaling can never invert the poker-hand category ordering — every category ceiling stays below the next category floor', () => {
    // Highest-scoring hand of each category (rank 14, or the highest each
    // category can actually reach) vs. the lowest-scoring hand of the NEXT
    // category up. Category order must strictly hold regardless.
    const ceilings = {
      HIGH_CARD: evaluateHand([c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]).score,
      PAIR: evaluateHand([c(14, 'S'), c(14, 'H'), c(2, 'D'), c(4, 'C'), c(6, 'S')]).score,
      THREE_STRAIGHT: evaluateHand([c(12, 'S'), c(13, 'H'), c(14, 'D'), c(2, 'C'), c(5, 'S')]).score,
      TWO_PAIR: evaluateHand([c(14, 'S'), c(14, 'H'), c(13, 'D'), c(13, 'C'), c(2, 'S')]).score,
      FOUR_STRAIGHT: evaluateHand([c(11, 'S'), c(12, 'H'), c(13, 'D'), c(14, 'C'), c(2, 'S')]).score,
      THREE_OF_A_KIND: evaluateHand([c(14, 'S'), c(14, 'H'), c(14, 'D'), c(2, 'C'), c(4, 'S')]).score,
      STRAIGHT: evaluateHand([c(10, 'S'), c(11, 'H'), c(12, 'D'), c(13, 'C'), c(14, 'S')]).score,
      FLUSH: evaluateHand([c(2, 'D'), c(4, 'D'), c(6, 'D'), c(9, 'D'), c(14, 'D')]).score,
      FULL_HOUSE: evaluateHand([c(14, 'S'), c(14, 'H'), c(14, 'D'), c(13, 'C'), c(13, 'S')]).score,
      FOUR_OF_A_KIND: evaluateHand([c(14, 'S'), c(14, 'H'), c(14, 'D'), c(14, 'C'), c(2, 'S')]).score,
      STRAIGHT_FLUSH: evaluateHand([c(9, 'D'), c(10, 'D'), c(11, 'D'), c(12, 'D'), c(13, 'D')]).score,
    };
    const floors = {
      PAIR: evaluateHand([c(2, 'S'), c(2, 'H'), c(4, 'D'), c(6, 'C'), c(8, 'S')]).score,
      THREE_STRAIGHT: evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D'), c(9, 'C'), c(11, 'S')]).score, // wheel-adjacent A-2-3
      TWO_PAIR: evaluateHand([c(3, 'S'), c(3, 'H'), c(2, 'D'), c(2, 'C'), c(9, 'S')]).score,
      FOUR_STRAIGHT: evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D'), c(4, 'C'), c(9, 'S')]).score, // wheel-adjacent A-2-3-4
      THREE_OF_A_KIND: evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(4, 'C'), c(6, 'S')]).score,
      STRAIGHT: evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D'), c(4, 'C'), c(5, 'S')]).score,
      FLUSH: evaluateHand([c(2, 'D'), c(3, 'D'), c(4, 'D'), c(6, 'D'), c(7, 'D')]).score,
      FULL_HOUSE: evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(3, 'C'), c(3, 'S')]).score,
      FOUR_OF_A_KIND: evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(2, 'C'), c(6, 'S')]).score,
      STRAIGHT_FLUSH: evaluateHand([c(14, 'D'), c(2, 'D'), c(3, 'D'), c(4, 'D'), c(5, 'D')]).score,
      ROYAL_FLUSH: evaluateHand([c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), c(14, 'S')]).score,
    };
    const order = [
      'HIGH_CARD', 'PAIR', 'THREE_STRAIGHT', 'TWO_PAIR', 'FOUR_STRAIGHT', 'THREE_OF_A_KIND', 'STRAIGHT',
      'FLUSH', 'FULL_HOUSE', 'FOUR_OF_A_KIND', 'STRAIGHT_FLUSH', 'ROYAL_FLUSH',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      const current = order[i];
      const next = order[i + 1];
      assert.ok(
        ceilings[current] < floors[next],
        `${current}'s ceiling (${ceilings[current]}) must stay below ${next}'s floor (${floors[next]})`,
      );
    }
  });
});

// Three Straight/Four Straight promoted from extra bonuses to real hand
// categories (owner bug report: "i just got a three straight and the top
// said the hand was a high card"). Classification checks the run length at
// exactly the if-chain position its HAND_RANKS rarity demands — not just as
// a bottom-of-the-chain fallback — because a Pair or Two Pair pattern can
// genuinely coexist with a longer run (the paired rank doubles as one end of
// it), and whichever category is odds-proportionally RARER must win
// (owner bug report #2: a Pair-of-5s-with-5,6,7,8 hand displayed as "Pair"
// worth ~150 points instead of the Four Straight it actually ranks above
// Two Pair as — DESIGN.md §3w/§3x).
describe('Three Straight / Four Straight classification', () => {
  test('3 consecutive ranks, no pair, classifies as Three Straight (not High Card)', () => {
    const hand = [c(8, 'S'), c(9, 'H'), c(10, 'D'), c(2, 'C'), c(13, 'S')];
    assert.equal(evaluateHand(hand).id, 'THREE_STRAIGHT');
  });

  test('4 consecutive ranks, no pair, classifies as Four Straight (not High Card)', () => {
    const hand = [c(8, 'S'), c(9, 'H'), c(10, 'D'), c(11, 'C'), c(2, 'S')];
    assert.equal(evaluateHand(hand).id, 'FOUR_STRAIGHT');
  });

  test('a genuine 5-card straight still wins over the 4-run/3-run fallback', () => {
    const hand = [c(8, 'S'), c(9, 'H'), c(10, 'D'), c(11, 'C'), c(12, 'S')];
    assert.equal(evaluateHand(hand).id, 'STRAIGHT');
  });

  test('a coexisting Four Straight outranks a Pair — Four Straight wins, not Pair', () => {
    // Pair of 5s, with 5-6-7-8 also forming a 4-run: Four Straight (2,726) is
    // rarer than Pair (200), so it must win the classification.
    const hand = [c(5, 'S'), c(5, 'H'), c(6, 'D'), c(7, 'C'), c(8, 'S')];
    assert.equal(evaluateHand(hand).id, 'FOUR_STRAIGHT');
  });

  test('a coexisting Three Straight outranks a Pair — Three Straight wins, not Pair', () => {
    // Pair of 4s, with 4-5-6 also forming a 3-run.
    const hand = [c(4, 'S'), c(4, 'H'), c(5, 'D'), c(6, 'C'), c(9, 'S')];
    assert.equal(evaluateHand(hand).id, 'THREE_STRAIGHT');
  });

  test('Two Pair still outranks a coexisting Three Straight — Two Pair wins', () => {
    // Pairs of 7s and 8s with a 9 kicker: 7-8-9 also forms a 3-run, but Two
    // Pair (1,780) is rarer than Three Straight (613).
    const hand = [c(7, 'S'), c(7, 'H'), c(8, 'D'), c(8, 'C'), c(9, 'S')];
    assert.equal(evaluateHand(hand).id, 'TWO_PAIR');
  });

  test('Three Straight is odds-proportionally rarer than Pair, so it outranks Pair', () => {
    assert.ok(handStrengthIndex('THREE_STRAIGHT') > handStrengthIndex('PAIR'));
  });

  test('Four Straight outranks Two Pair but not Three of a Kind', () => {
    assert.ok(handStrengthIndex('FOUR_STRAIGHT') > handStrengthIndex('TWO_PAIR'));
    assert.ok(handStrengthIndex('FOUR_STRAIGHT') < handStrengthIndex('THREE_OF_A_KIND'));
  });
});

describe('handStrengthIndex', () => {
  test('High Card is weakest, Royal Flush is strongest', () => {
    assert.equal(handStrengthIndex('HIGH_CARD'), 0);
    assert.equal(handStrengthIndex('ROYAL_FLUSH'), HAND_RANKS.length - 1);
  });

  test('is monotonic with score order', () => {
    const sorted = [...HAND_RANKS].sort((a, b) => a.score - b.score);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(handStrengthIndex(sorted[i].id) > handStrengthIndex(sorted[i - 1].id));
    }
  });
});
