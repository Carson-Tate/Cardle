import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  flavorBonus,
  perfectKeepBonus,
  longShotBonus,
  cleanFinishBonus,
  optimalDiscardBonus,
  suitSynergyBonus,
  cardValueBonus,
  rarityBonus,
  discardedRarityBonus,
  rarityMultiplier,
  pityBonus,
  scoreRun,
  logicalCardsFor,
} from '../src/core/scoring.js';
import { evaluateHand } from '../src/core/hand-evaluator.js';

const c = (rank, suit, rarity = null, jokerTier = null) => ({ rank, suit, rarity, jokerTier });

// Double or Nothing (§4) locks in with maxDiscards = 0, so the solver returns
// exactly one option and bestEV === worstEV. optimalDiscardBonus short-circuits
// that case to the FULL bonus — correct when a real choice happened to have only
// one good answer, catastrophic when there was no choice at all. board.js now
// omits evContext entirely in that case; this pins the half core owns.
describe('optimalDiscard when there was no decision to grade', () => {
  const c = (rank, suit) => ({ rank, suit, rarity: null, jokerTier: null });
  const hand = [c(14, 'S'), c(7, 'H'), c(9, 'D'), c(12, 'C'), c(13, 'S')];
  const run = (evContext) => scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0, evContext });

  test('a degenerate evContext still pays the full bonus — which is why the caller must not send one', () => {
    assert.equal(run({ chosenEV: 100, bestEV: 100, worstEV: 100 }).skillBonuses.optimalDiscard, 200);
  });

  test('omitting evContext awards nothing for a round with no discard choice', () => {
    assert.equal(run(undefined).skillBonuses.optimalDiscard, 0);
  });

  test('and the difference is exactly the free bonus that was being handed out', () => {
    const free = run({ chosenEV: 100, bestEV: 100, worstEV: 100 }).total - run(undefined).total;
    assert.equal(free, 200);
  });
});

describe('logicalCardsFor', () => {
  const wild = (rank, suit) => ({ rank, suit, wild: true });

  test('leaves a hand with no wild untouched', () => {
    const hand = [c(4, 'D'), c(7, 'D')];
    assert.equal(logicalCardsFor(hand, { hasWildJoker: false }), hand);
  });

  // The bug: every wild slot was handed the FIRST wild's substitution, so a
  // two-wild hand rendered as two identical cards that did not add up to the
  // hand it had just been scored as. `wildSubstitutions` is position-keyed and
  // exists precisely for this. Rare while WILD_CHANCE was ~1 hand in 100; at
  // the current ~1 in 11 a two-wild hand turns up every ~120 hands.
  test('each wild resolves to its OWN substitution, not the first one', () => {
    const hand = [wild(2, 'D'), c(13, 'S'), wild(6, 'C')];
    const result = {
      hasWildJoker: true,
      wildSubstitution: { rank: 13, suit: 'H' },
      wildSubstitutions: { 0: { rank: 13, suit: 'H' }, 2: { rank: 13, suit: 'D' } },
    };
    assert.deepEqual(logicalCardsFor(hand, result), [
      { rank: 13, suit: 'H' },
      c(13, 'S'),
      { rank: 13, suit: 'D' },
    ]);
  });

  // Stored rows written before `wildSubstitutions` existed carry only the
  // singular field, and this runs over history (profile + leaderboard).
  test('falls back to the singular substitution for legacy stored rows', () => {
    const hand = [{ rank: 2, suit: 'D', rarity: 'joker' }, c(13, 'S')];
    const result = { hasWildJoker: true, wildSubstitution: { rank: 13, suit: 'H' } };
    assert.deepEqual(logicalCardsFor(hand, result), [{ rank: 13, suit: 'H' }, c(13, 'S')]);
  });

  test('leaves the card alone rather than throwing when no substitution was recorded', () => {
    const hand = [wild(2, 'D')];
    assert.deepEqual(logicalCardsFor(hand, { hasWildJoker: true }), hand);
  });
});

describe('flavorBonus', () => {
  test('awards 25 per ace, 10 per face card', () => {
    const hand = [c(14, 'S'), c(13, 'H'), c(2, 'D'), c(3, 'C'), c(4, 'S')];
    const { aceBonus, faceBonus, total } = flavorBonus(hand);
    assert.equal(aceBonus, 25);
    assert.equal(faceBonus, 10);
    assert.equal(total, 35);
  });

  test('caps ace bonus at 100 and face bonus at 50', () => {
    // 4 aces would be 100 points anyway (4*25); use 4 face cards to test face cap headroom
    const allFace = [c(11, 'S'), c(11, 'H'), c(12, 'D'), c(12, 'C'), c(13, 'S')];
    const { faceBonus } = flavorBonus(allFace);
    assert.equal(faceBonus, Math.min(5 * 10, 50));
  });

  test('caps combined total at 125', () => {
    const hand = [c(14, 'S'), c(14, 'H'), c(14, 'D'), c(14, 'C'), c(13, 'S')];
    const { total } = flavorBonus(hand);
    assert.ok(total <= 125);
  });
});

describe('perfectKeepBonus', () => {
  test('awards bonus when 0 discards and hand is excellent', () => {
    const hand = evaluateHand([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), c(5, 'S')]); // trips
    assert.equal(perfectKeepBonus(0, hand), 50);
  });

  test('no bonus if any discards were used', () => {
    const hand = evaluateHand([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), c(5, 'S')]);
    assert.equal(perfectKeepBonus(1, hand), 0);
  });

  test('no bonus if hand is below the excellence threshold', () => {
    const hand = evaluateHand([c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]); // pair
    assert.equal(perfectKeepBonus(0, hand), 0);
  });

  test('awards bonus for even the lowest-scoring Three of a Kind (compared by category, not raw score)', () => {
    // A trip of 2s scores less than scoreForHandId('THREE_OF_A_KIND') itself
    // now that hand scores are rank-scaled — still Three of a Kind, still
    // "excellent," so this must still count.
    const hand = evaluateHand([c(2, 'S'), c(2, 'H'), c(2, 'D'), c(4, 'C'), c(6, 'S')]);
    assert.equal(perfectKeepBonus(0, hand), 50);
  });
});

describe('longShotBonus', () => {
  test('awards bonus on a 3+ rank jump', () => {
    const before = evaluateHand([c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]); // high card
    const after = evaluateHand([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(2, 'S')]); // quads
    assert.equal(longShotBonus(before, after), 75);
  });

  test('no bonus on a small improvement', () => {
    const before = evaluateHand([c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]); // high card
    const after = evaluateHand([c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]); // pair
    assert.equal(longShotBonus(before, after), 0);
  });
});

describe('cleanFinishBonus', () => {
  test('flush has no dead cards', () => {
    const hand = evaluateHand([c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')]);
    assert.equal(cleanFinishBonus(hand), 50);
  });

  test('four of a kind still has one dead kicker', () => {
    const hand = evaluateHand([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(2, 'S')]);
    assert.equal(cleanFinishBonus(hand), 0);
  });
});

describe('optimalDiscardBonus', () => {
  test('full marks when chosen EV equals best EV', () => {
    assert.equal(optimalDiscardBonus({ chosenEV: 500, bestEV: 500, worstEV: 100 }), 200);
  });

  test('zero when chosen EV equals worst EV', () => {
    assert.equal(optimalDiscardBonus({ chosenEV: 100, bestEV: 500, worstEV: 100 }), 0);
  });

  test('scales linearly between worst and best', () => {
    assert.equal(optimalDiscardBonus({ chosenEV: 300, bestEV: 500, worstEV: 100 }), 100);
  });

  test('handles bestEV === worstEV without dividing by zero', () => {
    assert.equal(optimalDiscardBonus({ chosenEV: 200, bestEV: 200, worstEV: 200 }), 200);
  });
});

describe('suitSynergyBonus', () => {
  test("2 of hearts + 3 of hearts scores 5x(2+3) for the numbers plus the group bonus", () => {
    const hand = [c(2, 'H'), c(3, 'H'), c(9, 'S'), c(10, 'D'), c(13, 'C')];
    const result = suitSynergyBonus(hand);
    assert.equal(result.suit, 'H');
    assert.equal(result.count, 2);
    assert.equal(result.numberBonus, 25); // (2 + 3) * 5
    assert.equal(result.groupBonus, 40);
    assert.equal(result.total, 65);
  });

  test('4 suits can\'t cover 5 cards, so a real hand always has some group of 2+', () => {
    // Pigeonhole: 5 cards, 4 suits -> at least one suit repeats. suitSynergyBonus
    // never returns 0 for a genuine 5-card hand; only for inputs with < 2 cards
    // sharing any suit (which can't happen at 5 cards, only in smaller inputs).
    const spreadAsEvenlyAsPossible = [c(2, 'H'), c(3, 'S'), c(9, 'D'), c(10, 'C'), c(13, 'H')];
    const result = suitSynergyBonus(spreadAsEvenlyAsPossible);
    assert.ok(result.total > 0);
    assert.equal(result.count, 2);
  });

  test('returns zero total for an input with no repeated suit (fewer than 5 cards)', () => {
    const fourDistinctSuits = [c(2, 'H'), c(3, 'S'), c(9, 'D'), c(10, 'C')];
    const result = suitSynergyBonus(fourDistinctSuits);
    assert.equal(result.total, 0);
    assert.equal(result.suit, null);
  });

  test('scales the group bonus with group size', () => {
    const threeSuited = [c(4, 'H'), c(7, 'H'), c(10, 'H'), c(2, 'S'), c(9, 'D')];
    const result = suitSynergyBonus(threeSuited);
    assert.equal(result.count, 3);
    assert.equal(result.numberBonus, 105); // (4 + 7 + 10) * 5
    assert.equal(result.groupBonus, 80);
    assert.equal(result.total, 185);
  });

  test('a full flush maxes out the group bonus', () => {
    const flush = [c(2, 'C'), c(5, 'C'), c(9, 'C'), c(11, 'C'), c(13, 'C')];
    const result = suitSynergyBonus(flush);
    assert.equal(result.count, 5);
    assert.equal(result.groupBonus, 200);
  });

  test('when two suits tie on count, picks whichever scores higher', () => {
    const hand = [c(2, 'H'), c(3, 'H'), c(9, 'S'), c(10, 'S'), c(13, 'C')];
    const result = suitSynergyBonus(hand);
    assert.equal(result.suit, 'S'); // 9+10=19 beats hearts' 2+3=5
    assert.equal(result.numberBonus, 95); // 19 * 5
  });
});

describe('cardValueBonus (owner request: "base points for each card in the hand")', () => {
  test('sums every card\'s rank, scaled ×5, regardless of suit or hand strength', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    const result = cardValueBonus(hand);
    assert.equal(result.total, (2 + 3 + 9 + 11 + 13) * 5);
  });

  test('is never zero for a real 5-card hand (unconditional, unlike Flavor Bonus or Suit Synergy)', () => {
    const hand = [c(2, 'H'), c(3, 'S'), c(4, 'D'), c(6, 'C'), c(9, 'H')];
    const result = cardValueBonus(hand);
    assert.ok(result.total > 0);
  });

  test('higher-ranked hands score strictly more', () => {
    const low = cardValueBonus([c(2, 'H'), c(3, 'S'), c(4, 'D'), c(5, 'C'), c(6, 'H')]).total;
    const high = cardValueBonus([c(10, 'H'), c(11, 'S'), c(12, 'D'), c(13, 'C'), c(14, 'H')]).total;
    assert.ok(high > low);
  });
});

describe('rarityBonus', () => {
  test('no bonus when nothing is rare', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    const result = rarityBonus(hand);
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
  });

  test('awards rank-scaled points for a single rare card (bronze rank 2 = 150 + 12*2)', () => {
    const hand = [c(2, 'H', 'bronze'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    const result = rarityBonus(hand);
    assert.equal(result.total, 174);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].rarity, 'bronze');
  });

  test('stacks multiple rare cards in the same hand', () => {
    const hand = [c(2, 'H', 'bronze'), c(5, 'S', 'gold'), c(9, 'D'), c(11, 'C'), c(13, 'H', 'joker', 'silver')];
    const result = rarityBonus(hand);
    // bronze(2)=150+12*2=174, gold(5)=300+25*5=425, silver-flavored joker=210 flat
    assert.equal(result.total, 174 + 425 + 210);
    assert.equal(result.items.length, 3);
  });

  test('higher non-joker tiers are worth strictly more than lower ones', () => {
    const bronze = rarityBonus([c(2, 'H', 'bronze'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    const silver = rarityBonus([c(2, 'H', 'silver'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    const gold = rarityBonus([c(2, 'H', 'gold'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    assert.ok(bronze < silver && silver < gold);
  });

  test('within the same tier, a higher-ranked card is worth strictly more (owner request: more volatility)', () => {
    const low = rarityBonus([c(2, 'H', 'gold'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    const high = rarityBonus([c(14, 'H', 'gold'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    assert.ok(high > low);
  });

  test("a joker's bonus is flat, unaffected by its underlying rank (defaults to the bronze flavor)", () => {
    const low = rarityBonus([c(2, 'H', 'joker'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    const high = rarityBonus([c(14, 'H', 'joker'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    assert.equal(low, high);
    assert.equal(low, 150);
  });

  test("a joker's bonus and label match whichever of bronze/silver/gold it rolled (owner request: same rarities as normal cards)", () => {
    const bronzeJoker = rarityBonus([c(2, 'H', 'joker', 'bronze'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]);
    const goldJoker = rarityBonus([c(2, 'H', 'joker', 'gold'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]);
    assert.ok(goldJoker.total > bronzeJoker.total);
    assert.equal(goldJoker.total, 300);
    assert.equal(bronzeJoker.items[0].label, 'Bronze Wild');
    assert.equal(goldJoker.items[0].label, 'Gold Wild');
  });
});

describe('discardedRarityBonus', () => {
  test('no bonus when nothing discarded was rare', () => {
    const discarded = [c(2, 'H'), c(9, 'D')];
    const result = discardedRarityBonus(discarded);
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
  });

  test('awards half of what rarityBonus would give for the same card (owner request: discarding a rare card should still add a good amount of points)', () => {
    const card = c(2, 'H', 'bronze');
    const kept = rarityBonus([card, c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')]).total;
    const discarded = discardedRarityBonus([card]).total;
    assert.equal(discarded, Math.round(kept * 0.5));
    assert.ok(discarded > 0 && discarded < kept);
  });

  test('stacks across multiple discarded rare cards', () => {
    const discarded = [c(2, 'H', 'bronze'), c(5, 'S', 'gold')];
    const result = discardedRarityBonus(discarded);
    assert.equal(result.items.length, 2);
    assert.ok(result.total > discardedRarityBonus([discarded[0]]).total);
  });

  test("a discarded joker uses its rolled flavor's points, same as rarityBonus", () => {
    const result = discardedRarityBonus([c(2, 'H', 'joker', 'gold')]);
    assert.equal(result.items[0].label, 'Gold Wild');
    assert.equal(result.total, Math.round(300 * 0.5));
  });
});

describe('rarityMultiplier', () => {
  test('is 1 when nothing in the hand is rare', () => {
    const hand = [c(2, 'H'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.equal(rarityMultiplier(hand), 1);
  });

  test('is the tier multiplier for a single rare card', () => {
    const hand = [c(2, 'H', 'gold'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.equal(rarityMultiplier(hand), 2.5);
  });

  test('stacks multiplicatively when more than one rare card is present, plus the multi-rarity kicker', () => {
    // 1.2 * 2.5 = 3, then +25% multi-rarity kicker for the 2nd rare card = 3.75
    const hand = [c(2, 'H', 'bronze'), c(5, 'S', 'gold'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.equal(rarityMultiplier(hand), 3.75);
  });

  test("a joker's multiplier matches whichever of bronze/silver/gold it rolled", () => {
    const hand = [c(2, 'H', 'joker', 'gold'), c(5, 'S'), c(9, 'D'), c(11, 'C'), c(13, 'H')];
    assert.equal(rarityMultiplier(hand), 2.5);
  });

});

describe('pityBonus', () => {
  test('is zero at or above the threshold', () => {
    assert.equal(pityBonus(250), 0);
    assert.equal(pityBonus(1000), 0);
  });

  test('is maximal at a total of zero', () => {
    assert.equal(pityBonus(0), 150);
  });

  // Bug: scoreRun passes `multipliedTotal - cardValue.total`, which goes
  // NEGATIVE when Double or Nothing's bust zeroes the total while Card Value
  // stays 50-350. Unclamped, the formula ran past its own maximum —
  // pityBonus(-350) returned 360 — so a "Busted — Nothing" run paid 270.
  test('never exceeds its maximum for a negative total (Double or Nothing bust)', () => {
    assert.equal(pityBonus(-1), 150);
    assert.equal(pityBonus(-350), 150);
    assert.equal(pityBonus(-100000), 150);
  });

  test('scales down smoothly as the total climbs toward the threshold', () => {
    const low = pityBonus(50);
    const mid = pityBonus(125);
    const high = pityBonus(225);
    assert.ok(low > mid && mid > high && high > 0);
  });
});

describe('scoreRun', () => {
  test('combines base score, flavor, and skill bonuses', () => {
    const originalHand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    const finalHand = [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')]; // flush, drawn
    const result = scoreRun({ originalHand, finalHand, discardedCount: 1 });

    // Rank-scaled by the flush's highest card (13, a King): 34476 + 1053*13.
    assert.equal(result.baseScore, 48165);
    assert.equal(result.skillBonuses.cleanFinish, 50);
    assert.equal(result.skillBonuses.perfectKeep, 0); // discards were used
    assert.equal(result.suitSynergy.count, 5); // all-diamond flush also maxes out suit synergy
    assert.equal(result.multiplier, 1); // no rare cards in this hand
    const extraBonusTotal = result.extraBonuses.reduce((sum, bonus) => sum + bonus.points, 0);
    assert.equal(
      result.total,
      result.baseScore +
        result.flavor.total +
        result.suitSynergy.total +
        result.cardValue.total +
        result.skillBonuses.cleanFinish +
        result.skillBonuses.longShot +
        extraBonusTotal,
    );
  });

  test('applies the modifier multiplier to the whole total when provided', () => {
    // A Full House scores well above the pity floor, so pity stays 0 in both
    // runs below and the multiplier's effect on `total` is exact, not just
    // directionally bigger.
    const hand = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(4, 'C'), c(4, 'S')];
    const base = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0, modifierMultiplier: 2 });
    assert.equal(base.pity, 0);
    assert.equal(result.pity, 0);
    assert.equal(result.modifierMultiplier, 2);
    assert.equal(result.total, base.total * 2);
    assert.equal(result.modifierBonusAmount, base.total);
  });

  test('defaults the modifier multiplier to 1 (no-op) when not provided', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.modifierMultiplier, 1);
    assert.equal(result.modifierBonusAmount, 0);
  });

  // Double or Nothing (§4e) is the first modifier whose multiplier can be 0
  // — regression guard for a real bug it exposed: board.js's score-breakdown
  // badges only showed the modifier line when its delta was positive, so the
  // displayed running total silently didn't account for a wipe (it summed
  // only the badges actually shown). `modifierBonusAmount` going negative is
  // the signal the UI now keys off to render a "Busted" badge instead of
  // hiding it. This test locks in the underlying scoring.js contract; the UI
  // fix itself was verified live (no unit coverage for board.js's DOM in
  // this project — see DESIGN.md §4e).
  test('a modifier multiplier of 0 wipes the total, and the shortfall is visible as a negative modifierBonusAmount', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]; // High Card
    const base = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0, modifierMultiplier: 0 });
    assert.equal(result.modifierMultiplier, 0);
    assert.ok(result.modifierBonusAmount < 0);
    assert.equal(result.modifierBonusAmount, -(base.total - base.pity));
  });

  test('a wiped total still respects the pity cap rather than inflating past it', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]; // High Card
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0, modifierMultiplier: 0 });
    // Everything earned is wiped, so the only thing left is pity — which must
    // be at most its own maximum. This used to come out at 270.
    assert.equal(result.total, result.pity);
    assert.ok(result.pity <= 150, `pity was ${result.pity}, expected <= 150`);
  });

  // The modifier callback receives the LOGICAL hand (Wild resolved to what it
  // actually plays as), not the raw dealt cards. Passing the raw hand let a
  // suit-reading modifier count a Wild by its meaningless dealt suit — the
  // same class of bug §3t fixed for Suit Synergy.
  test('the modifier callback is handed the logical hand, not the raw dealt cards', () => {
    // Wild dealt as 2♥, but it completes a SPADE flush, so it plays as a spade.
    const hand = [c(2, 'H', 'joker', 'gold'), c(5, 'S'), c(9, 'S'), c(11, 'S'), c(13, 'S')];
    let seenHand = null;
    scoreRun({
      originalHand: hand,
      finalHand: hand,
      discardedCount: 0,
      modifierMultiplier: (_result, finalHandArg) => {
        seenHand = finalHandArg;
        return 1;
      },
    });
    assert.equal(seenHand.filter((card) => card.suit === 'S').length, 5, 'all 5 should read as spades');
    assert.equal(seenHand.filter((card) => card.suit === 'H').length, 0, "the Wild's dealt ♥ must not leak through");
  });

  test('includes rarity bonuses from the final hand', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D', 'gold'), c(11, 'C'), c(13, 'S')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.rarity.total, 525); // gold rank 9 = 300 + 25*9
  });

  test('a rare card that is PART OF a made hand multiplies the ENTIRE total (owner request)', () => {
    // Two Pair (9s and 2s), with a gold 9 as one of the pair — the gold
    // card is genuinely one of the two matching 9s.
    const hand = [c(9, 'S', 'gold'), c(9, 'H'), c(2, 'D'), c(2, 'C'), c(5, 'S')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    // Rank-scaled by the higher pair's rank (9): 1276 + 63*9.
    assert.equal(result.baseScore, 1843);
    assert.equal(result.multiplier, 2.5);
    assert.equal(result.handSynergyBonus, Math.round(result.additiveTotal * 2.5) - result.additiveTotal);
    assert.ok(result.handSynergyBonus > 0);
    assert.equal(result.total, Math.round(result.additiveTotal * 2.5) + result.pity);
  });

  test('owner\'s own worked example: a rare card as an UNRELATED kicker does not multiply anything', () => {
    // Pair of 2s, with a silver 3♠ that is NOT part of the pair — just an
    // unrelated 5th card. "it would not multiply the whole hand."
    const hand = [c(2, 'H'), c(2, 'D'), c(3, 'S', 'silver'), c(9, 'C'), c(13, 'H')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.handResult.id, 'PAIR');
    assert.equal(result.handSynergyBonus, 0);
    assert.equal(result.total, result.additiveTotal + result.pity);
    assert.ok(result.rarity.total > 0); // still gets its flat bonus regardless
  });

  test("owner's own worked example: the SAME silver card becomes part of Two Pair and multiplies the whole hand", () => {
    // Same as above, but the 5th card is now a normal 3♦ — the silver 3♠
    // is now genuinely one of the two 3s forming Two Pair (2s and 3s).
    const hand = [c(2, 'H'), c(2, 'D'), c(3, 'S', 'silver'), c(3, 'D'), c(13, 'H')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.handResult.id, 'TWO_PAIR');
    assert.equal(result.multiplier, 1.5);
    assert.ok(result.handSynergyBonus > 0);
    assert.equal(result.total, Math.round(result.additiveTotal * 1.5) + result.pity);
  });

  test('owner request: two rare cards score MORE than one, even when neither is part of the winning combo', () => {
    // Pair of 2s — a bronze 3♠ and a silver 9♣ are both unrelated kickers,
    // neither part of the pair, so this does NOT qualify for the whole-hand
    // multiply. But having two of them (vs. one, or zero) should still
    // score strictly more, via the stacked multiplier applied to just the
    // flat rarity total.
    const zero = scoreRun({
      originalHand: [c(2, 'H'), c(2, 'D'), c(3, 'S'), c(9, 'C'), c(13, 'H')],
      finalHand: [c(2, 'H'), c(2, 'D'), c(3, 'S'), c(9, 'C'), c(13, 'H')],
      discardedCount: 0,
    });
    const one = scoreRun({
      originalHand: [c(2, 'H'), c(2, 'D'), c(3, 'S', 'bronze'), c(9, 'C'), c(13, 'H')],
      finalHand: [c(2, 'H'), c(2, 'D'), c(3, 'S', 'bronze'), c(9, 'C'), c(13, 'H')],
      discardedCount: 0,
    });
    const two = scoreRun({
      originalHand: [c(2, 'H'), c(2, 'D'), c(3, 'S', 'bronze'), c(9, 'C', 'silver'), c(13, 'H')],
      finalHand: [c(2, 'H'), c(2, 'D'), c(3, 'S', 'bronze'), c(9, 'C', 'silver'), c(13, 'H')],
      discardedCount: 0,
    });
    assert.equal(one.handSynergyBonus, 0); // single rare kicker: no multiplier effect at all
    assert.ok(two.handSynergyBonus > 0); // two rare kickers: the flat rarity total gets multiplied
    assert.equal(two.multiplier, 2.25); // 1.2 * 1.5 = 1.8, +25% multi-rarity kicker for the 2nd rare card
    assert.equal(two.handSynergyBonus, Math.round(two.rarity.total * two.multiplier) - two.rarity.total);
    assert.ok(two.total > one.total);
    assert.ok(one.total > zero.total);
  });

  test('a rare card sitting in a High Card hand gets zero synergy bonus, though it still gets its flat bonus (owner-reported issue)', () => {
    // The exact shape of the reported problem: "if i have no poker hands
    // but one silver card, i get the same amount of points" as a real hand.
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D', 'gold'), c(11, 'C'), c(13, 'S')]; // high card
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.baseScore, 0);
    assert.equal(result.multiplier, 2.5);
    assert.equal(result.handSynergyBonus, 0);
    assert.ok(result.rarity.total > 0); // the flat "you kept a rare card" bonus still applies
  });

  test('a rare card that is part of a Three Straight run multiplies the whole hand (Three Straight is its own category now, §3w)', () => {
    // 3,4,5 consecutive plus 2 unrelated high cards. Three Straight is now
    // a real hand category (owner: "i just got a three straight and the top
    // said the hand was a high card") rather than an extra bonus stacked on
    // top of High Card, so the bronze card being part of that run qualifies
    // it for the whole-hand multiplier via the same combo-attribution gate
    // as any other hand rank.
    const hand = [c(3, 'H'), c(4, 'D', 'bronze'), c(5, 'C'), c(9, 'S'), c(13, 'H')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.handResult.id, 'THREE_STRAIGHT');
    assert.deepEqual([...result.handContributingIndices].sort(), [0, 1, 2]); // 3H, 4D, 5C — not the 9S/13H kickers
    assert.equal(result.multiplier, 1.2);
    // No 'threeStraight' extra bonus — it's already credited as the primary hand, not double-counted.
    assert.ok(!result.extraBonuses.some((b) => b.id === 'threeStraight'));
    assert.ok(result.handSynergyBonus > 0);
    assert.equal(result.total, Math.round(result.additiveTotal * 1.2) + result.pity);
  });

  test('applies pity points when the run whiffed, and none when it did not', () => {
    // High card, low ranks (minimizes Card Value), no runs/rainbow/other
    // extra bonuses, and low enough combined bonuses that even after Card
    // Value's now-unconditional floor is added back in, the PITY-ELIGIBLE
    // total (which excludes Card Value — see scoreRun's comment) still
    // lands under the threshold.
    const badHand = [c(2, 'S'), c(6, 'S'), c(3, 'H'), c(5, 'H'), c(8, 'D')];
    const badResult = scoreRun({ originalHand: badHand, finalHand: badHand, discardedCount: 0 });
    assert.ok(badResult.pity > 0);

    const strongHand = [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(2, 'S')]; // quads
    const strongResult = scoreRun({ originalHand: strongHand, finalHand: strongHand, discardedCount: 0 });
    assert.equal(strongResult.pity, 0);
  });

  test('Card Value contributes an unconditional, always-nonzero base score for every card in the hand', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]; // high card, no rarity, no suit synergy pair beyond pigeonhole
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.cardValue.total, (2 + 5 + 9 + 11 + 13) * 5);
    assert.ok(result.cardValue.total > 0);
  });

  test('a joker in the final hand is scored as whatever hand it best completes, plus the joker rarity bonus (owner request: joker acts as a wild card completing the best combination)', () => {
    const hand = [c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), c(2, 'H', 'joker')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.handResult.id, 'ROYAL_FLUSH'); // joker wild-substituted as the Ace of Spades
    assert.equal(result.rarity.total, 150); // joker (bronze, default flavor) is flat, regardless of its underlying rank
  });

  test('a joker completing a Royal Flush always multiplies the whole hand (every card in a Royal Flush is load-bearing, joker included)', () => {
    const hand = [c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), c(2, 'H', 'joker', 'gold')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.handResult.id, 'ROYAL_FLUSH');
    assert.equal(result.multiplier, 2.5);
    assert.equal(result.handSynergyBonus, Math.round(result.additiveTotal * 2.5) - result.additiveTotal);
    assert.ok(result.handSynergyBonus > 0);
  });

  test('stacking multiple rare cards in one Royal Flush produces an insane jackpot (owner request)', () => {
    // A gold Joker completing the flush AND a second, independently-gold card
    // already in the run — both genuinely part of the Royal Flush pattern.
    const hand = [c(10, 'S', 'gold'), c(11, 'S'), c(12, 'S'), c(13, 'S'), c(2, 'H', 'joker', 'gold')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });
    assert.equal(result.handResult.id, 'ROYAL_FLUSH');
    // 2.5 * 2.5 = 6.25, then +25% multi-rarity kicker for the 2nd rare card = 7.8125, rounded to 7.81
    assert.equal(result.multiplier, 7.81);
    assert.equal(result.total, Math.round(result.additiveTotal * 7.81) + result.pity);
    assert.ok(result.total > 30000);
  });

  // Bug report: a Joker that wild-completed a Pair displayed (and scored
  // Suit Synergy/Card Value/Flavor against) its own leftover, meaningless
  // dealt rank/suit instead of the rank/suit it actually substituted to —
  // two contradictory identities for the same card in one score.
  test('a joker is scored consistently as its wild substitution everywhere, not its own meaningless dealt rank/suit', () => {
    // 4D 7D 3H JD + a joker literally dealt as 2D (irrelevant flavor data).
    // Now that Three Straight/Four Straight are real hand categories (§3w)
    // and outrank Pair by true rarity, the wild search finds an even better
    // play than pairing with the Jack: 3-4-5 (joker as 5) is a Three
    // Straight, which beats any Pair outright — no tie to break.
    const hand = [c(4, 'D'), c(7, 'D'), c(3, 'H'), c(11, 'D'), c(2, 'D', 'joker', 'diamond')];
    const result = scoreRun({ originalHand: hand, finalHand: hand, discardedCount: 0 });

    assert.equal(result.handResult.id, 'THREE_STRAIGHT');
    assert.deepEqual(result.handResult.wildSubstitution, { rank: 5, suit: 'S' });

    // logicalFinalHand shows the joker AS its substitution, not as 2D.
    assert.deepEqual(result.logicalFinalHand[4], { rank: 5, suit: 'S' });

    // The run correctly found 3H, 4D, and the joker-as-5S (order not
    // significant — sorted for a stable comparison).
    assert.deepEqual([...result.handContributingIndices].sort(), [0, 2, 4]);

    // Suit Synergy must agree the joker is now a Spade, NOT still count it
    // as its old literal Diamond — only 3 real diamonds remain (4D/7D/JD),
    // not 4.
    assert.equal(result.suitSynergy.suit, 'D');
    assert.equal(result.suitSynergy.count, 3);
    assert.deepEqual(result.suitSynergy.indices, [0, 1, 3]);

    // Card Value must sum the substituted rank (5), not the dealt rank (2).
    assert.equal(result.cardValue.total, (4 + 7 + 3 + 11 + 5) * 5);
  });
});
