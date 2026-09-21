import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dealHand, dealForRun, applyDealModifier, DEAL_EFFECTS, freshSeed } from '../src/core/deck.js';
import { buildModifierById, modifierScoringMultiplier } from '../src/core/modifiers.js';
import { verifyAndScoreRun } from '../src/core/verify-run.js';
import { isWild } from '../src/core/rarity.js';

// §4i's batch: three scoring modifiers and two that change the DEAL. The deal
// pair are the second two-sided feature in the project after Stack the Deck —
// the board and the Edge Function are different machines and agree only because
// applyDealModifier is a pure function of the row's own seed.

const wildWednesday = buildModifierById('wildWednesday');
const loadedDeck = buildModifierById('loadedDeck');
const RARE_OR_BETTER = new Set(['gold', 'diamond']);

describe('applyDealModifier', () => {
  // THE LOAD-BEARING REGRESSION. Every player, every ordinary day, goes through
  // dealForRun now. If this ever fails, adding a modifier silently re-dealt the
  // whole game.
  test('no deal effect leaves the deal byte-identical to dealHand', () => {
    for (const seed of [1, 31337, 987654, 2316669]) {
      assert.deepEqual(dealForRun({ seed }), { ...dealHand(seed), stacked: false }, `seed ${seed}`);
      assert.deepEqual(dealForRun({ seed, modifier: buildModifierById('flushFrenzy') }).hand, dealHand(seed).hand);
    }
  });

  // The §11al property, restated for this feature: determinism is the entire
  // contract between the two machines, and a freshSeed() in there would pass
  // every local test and reject every real run.
  test('the same seed and modifier always build the identical hand', () => {
    for (let i = 0; i < 50; i++) {
      const seed = freshSeed();
      assert.deepEqual(dealForRun({ seed, modifier: wildWednesday }), dealForRun({ seed, modifier: wildWednesday }));
      assert.deepEqual(dealForRun({ seed, modifier: loadedDeck }), dealForRun({ seed, modifier: loadedDeck }));
    }
  });

  test('Wild Wednesday guarantees a wild in every opening hand', () => {
    for (let i = 0; i < 200; i++) {
      const seed = freshSeed();
      const { hand } = dealForRun({ seed, modifier: wildWednesday });
      assert.ok(hand.some((card) => isWild(card)), `seed ${seed} dealt no wild`);
    }
  });

  test('Loaded Deck guarantees Gold or better in every opening hand', () => {
    for (let i = 0; i < 200; i++) {
      const seed = freshSeed();
      const { hand } = dealForRun({ seed, modifier: loadedDeck });
      assert.ok(hand.some((card) => RARE_OR_BETTER.has(card.rarity)), `seed ${seed} dealt nothing rare`);
    }
  });

  // "At least one" is the promise, so a hand that already qualifies is left
  // completely alone — which keeps these days differing from an ordinary deal
  // by exactly one card, or not at all.
  test('a hand that already qualifies is untouched', () => {
    const base = { hand: [{ rank: 5, suit: 'S', rarity: null, wild: true }], drawPile: [] };
    assert.equal(applyDealModifier(base, wildWednesday, 42), base);

    const rare = { hand: [{ rank: 5, suit: 'S', rarity: 'diamond', wild: false }], drawPile: [] };
    assert.equal(applyDealModifier(rare, loadedDeck, 42), rare);
  });

  // Exactly one card changes — never two, and never the draw pile, which would
  // silently alter every replacement a discard draws.
  test('it upgrades one card and leaves the draw pile alone', () => {
    const seed = 555;
    const plain = dealHand(seed);
    const wilded = applyDealModifier(plain, wildWednesday, seed);
    if (plain.hand.some((c) => isWild(c))) return; // already satisfied; covered above
    const changed = wilded.hand.filter((card, i) => card.wild !== plain.hand[i].wild);
    assert.equal(changed.length, 1);
    assert.deepEqual(wilded.drawPile, plain.drawPile);
  });

  // Loaded Deck promises a FLOOR, not a roll. Handing out Diamonds (×15, about
  // 1 in 1000 naturally) on a schedule would quietly make this the biggest
  // score source in the game.
  test('Loaded Deck grants Gold, never Diamond', () => {
    for (let i = 0; i < 100; i++) {
      const seed = freshSeed();
      const plain = dealHand(seed);
      if (plain.hand.some((c) => RARE_OR_BETTER.has(c.rarity))) continue;
      const loaded = applyDealModifier(plain, loadedDeck, seed);
      const upgraded = loaded.hand.filter((card, idx) => card.rarity !== plain.hand[idx].rarity);
      assert.equal(upgraded.length, 1);
      assert.equal(upgraded[0].rarity, 'gold');
    }
  });

  // An admin who pinned five exact cards meant those cards (§11al). Silently
  // making one wild would contradict the one feature whose whole point is
  // "these cards, exactly" — and the decision lives inside dealForRun so the
  // board and the server cannot decide it differently.
  test('a stacked deal wins and the modifier is skipped', () => {
    const stack = {
      hand: [
        { rank: 2, suit: 'C', rarity: null },
        { rank: 5, suit: 'H', rarity: null },
        { rank: 9, suit: 'D', rarity: null },
        { rank: 11, suit: 'S', rarity: null },
        { rank: 3, suit: 'H', rarity: null },
      ],
      slotDraws: [null, null, null, null, null],
    };
    const dealt = dealForRun({ seed: 4242, modifier: wildWednesday, stackedDeal: stack });
    assert.equal(dealt.stacked, true);
    assert.equal(dealt.hand.some((card) => isWild(card)), false, 'the stack was overridden');
    assert.deepEqual(
      dealt.hand.map((c) => `${c.rank}${c.suit}`),
      stack.hand.map((c) => `${c.rank}${c.suit}`),
    );
  });
});

// The agreement that matters: the server re-deals from the seed, so on a deal
// modifier day it must build the SAME hand the board showed.
describe('the server honours a deal modifier', () => {
  test('verifyAndScoreRun deals the wild the board would have dealt', () => {
    for (const seed of [11, 2222, 33333]) {
      const verified = verifyAndScoreRun({ seed, discardRounds: [[]], modifier: wildWednesday });
      assert.ok(verified.ok, verified.errors?.join('; '));
      assert.deepEqual(verified.finalHand, dealForRun({ seed, modifier: wildWednesday }).hand);
      assert.ok(verified.finalHand.some((card) => isWild(card)));
    }
  });

  test('and scores an ordinary day exactly as before', () => {
    const plain = { id: '__test_plain__', type: 'scoring' };
    const verified = verifyAndScoreRun({ seed: 31337, discardRounds: [[0]], modifier: plain });
    assert.deepEqual(verified.originalHand, dealHand(31337).hand);
  });
});

describe('the §4i scoring modifiers', () => {
  const hand = (a, b) => [a, { rank: 5, suit: 'H' }, { rank: 7, suit: 'D' }, { rank: 9, suit: 'C' }, b];
  const result = { id: 'HIGH_CARD' };
  const mult = (id, cards, discardIndices) =>
    modifierScoringMultiplier(buildModifierById(id))(result, cards, { discardIndices });

  test('Escalator pays per card thrown away, and nothing for standing pat', () => {
    const cards = hand({ rank: 13, suit: 'S' }, { rank: 2, suit: 'D' });
    assert.equal(mult('escalator', cards, []), 1);
    assert.equal(mult('escalator', cards, [0]), 1.4);
    assert.ok(Math.abs(mult('escalator', cards, [0, 1, 2]) - 2.2) < 1e-9);
  });

  // The exact inverse, deliberately at the same rate — a player who has learned
  // one already knows the other's arithmetic.
  test('Refund pays per card kept, and is Escalator pointing the other way', () => {
    const cards = hand({ rank: 13, suit: 'S' }, { rank: 2, suit: 'D' });
    assert.equal(mult('refund', cards, []), 3); // all five kept
    assert.ok(Math.abs(mult('refund', cards, [0, 1, 2]) - 1.8) < 1e-9);
  });

  test('Bookends matches on rank OR suit, and only on the two end slots', () => {
    assert.equal(mult('bookends', hand({ rank: 13, suit: 'S' }, { rank: 13, suit: 'D' }), []), 3, 'same rank');
    assert.equal(mult('bookends', hand({ rank: 13, suit: 'S' }, { rank: 4, suit: 'S' }), []), 3, 'same suit');
    assert.equal(mult('bookends', hand({ rank: 13, suit: 'S' }, { rank: 4, suit: 'D' }), []), 1, 'neither');
  });

  // The middle three are explicitly irrelevant, which is what makes the
  // modifier legible — asserted so a future "any two matching cards" rewrite
  // has to change the test on purpose.
  test('Bookends ignores a match that is not at the ends', () => {
    const cards = [
      { rank: 13, suit: 'S' },
      { rank: 4, suit: 'D' },
      { rank: 4, suit: 'H' },
      { rank: 4, suit: 'C' },
      { rank: 7, suit: 'H' },
    ];
    assert.equal(mult('bookends', cards, []), 1);
  });
});
