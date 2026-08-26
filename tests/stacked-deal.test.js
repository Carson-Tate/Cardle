import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dealFromStack,
  normalizeStackedDeal,
  applyDiscards,
  dealHand,
  STACK_HAND_SIZE,
} from '../src/core/deck.js';
import { verifyAndScoreRun } from '../src/core/verify-run.js';
import { getDailyModifier } from '../src/core/modifiers.js';

const card = (rank, suit, extra = {}) => ({ rank, suit, rarity: null, wild: false, ...extra });
const ROYAL = [card(14, 'S'), card(13, 'S'), card(12, 'S'), card(11, 'S'), card(10, 'S')];
const NO_DRAWS = [null, null, null, null, null];
const validDeal = (over = {}) => ({ hand: ROYAL, slotDraws: NO_DRAWS, ...over });

// A day with no modifier surprises, so these test the deal rather than a rule.
const plainModifier = getDailyModifier(new Date('2026-01-15T12:00:00Z'));

describe('normalizeStackedDeal', () => {
  test('a well-formed deal passes and comes back normalized', () => {
    const { ok, deal } = normalizeStackedDeal(validDeal({ slotDraws: [null, null, card(2, 'H'), null, null] }));
    assert.equal(ok, true);
    assert.equal(deal.hand.length, STACK_HAND_SIZE);
    assert.deepEqual(deal.slotDraws[2], card(2, 'H'));
  });

  // THE SHAPE IS POSITIONAL. A short or missing slotDraws must pad with holes,
  // not shift the pins it does contain onto earlier slots.
  test('slotDraws is always length 5 and keeps its holes', () => {
    const { deal } = normalizeStackedDeal(validDeal({ slotDraws: [null, card(7, 'D')] }));
    assert.equal(deal.slotDraws.length, STACK_HAND_SIZE);
    assert.equal(deal.slotDraws[0], null);
    assert.deepEqual(deal.slotDraws[1], card(7, 'D'));
    assert.deepEqual(deal.slotDraws.slice(2), [null, null, null]);
  });

  test('a deal with no pinned replacements at all is valid', () => {
    const { ok, deal } = normalizeStackedDeal({ hand: ROYAL });
    assert.equal(ok, true);
    assert.deepEqual(deal.slotDraws, NO_DRAWS);
  });

  // A 021-shape row parses as "an array of cards" either way, so REINTERPRETING
  // it would deal real cards to the wrong slots — plausible and silently wrong.
  // It must read as "nothing pinned" instead.
  test("the retired ordered-pile shape is ignored, not reinterpreted", () => {
    const { ok, deal } = normalizeStackedDeal({ hand: ROYAL, draws: [card(2, 'H'), card(3, 'H')] });
    assert.equal(ok, true);
    assert.deepEqual(deal.slotDraws, NO_DRAWS);
  });

  test('a hand that is not exactly five cards is refused', () => {
    assert.equal(normalizeStackedDeal({ hand: ROYAL.slice(0, 4) }).ok, false);
    assert.equal(normalizeStackedDeal({ hand: [...ROYAL, card(9, 'S')] }).ok, false);
  });

  test('the same card cannot be both dealt and pinned as a replacement', () => {
    assert.equal(normalizeStackedDeal({ hand: [...ROYAL.slice(0, 4), card(14, 'S')] }).ok, false);
    assert.equal(normalizeStackedDeal(validDeal({ slotDraws: [card(14, 'S'), null, null, null, null] })).ok, false);
  });

  test('junk ranks, suits and rarity tiers are refused rather than silently dropped', () => {
    assert.equal(normalizeStackedDeal({ hand: [card(99, 'S'), ...ROYAL.slice(1)] }).ok, false);
    assert.equal(normalizeStackedDeal({ hand: [card(14, 'X'), ...ROYAL.slice(1)] }).ok, false);
    assert.equal(normalizeStackedDeal({ hand: [card(14, 'S', { rarity: 'platinum' }), ...ROYAL.slice(1)] }).ok, false);
  });

  test('more pinned replacements than there are slots is refused', () => {
    const six = [card(2, 'H'), card(3, 'H'), card(4, 'H'), card(5, 'H'), card(6, 'H'), card(7, 'H')];
    assert.equal(normalizeStackedDeal(validDeal({ slotDraws: six })).ok, false);
  });

  test('absent or malformed input is refused, not thrown on', () => {
    for (const value of [null, undefined, 'nonsense', 42, {}, { hand: 'nope' }]) {
      assert.equal(normalizeStackedDeal(value).ok, false);
    }
  });
});

describe('applyDiscards', () => {
  const hand = [card(2, 'C'), card(3, 'D'), card(12, 'S'), card(5, 'H'), card(6, 'C')];
  const pile = [card(9, 'S'), card(9, 'D'), card(9, 'H')];

  // THE REGRESSION THAT MATTERS MOST. Every ordinary deal, every day, goes
  // through here. Without slotDraws it must behave exactly like the four copies
  // it replaced: consume the pile in ascending slot order.
  test('with no pinned replacements it consumes the pile in slot order', () => {
    const out = applyDiscards({ hand, pile, indices: [0, 3] });
    assert.deepEqual(out.hand[0], card(9, 'S'));
    assert.deepEqual(out.hand[3], card(9, 'D'));
    assert.deepEqual(out.hand[1], card(3, 'D'));
    assert.deepEqual(out.pile, [card(9, 'H')]);
  });

  test('discarding nothing changes nothing and consumes nothing', () => {
    const out = applyDiscards({ hand, pile, indices: [] });
    assert.deepEqual(out.hand, hand);
    assert.deepEqual(out.pile, pile);
  });

  // The owner's own example: 2 3 Q 5 6, pin a 4 opposite the Q.
  test('a pinned replacement is dealt to ITS slot, whichever slot is discarded', () => {
    const slotDraws = [null, null, card(4, 'S'), null, null];
    const out = applyDiscards({ hand, pile, indices: [2], slotDraws });
    assert.deepEqual(out.hand[2], card(4, 'S'));
    assert.deepEqual(out.hand.map((c) => c.rank).sort((a, b) => a - b), [2, 3, 4, 5, 6]);
    // A pinned card comes from nowhere near the pile, so nothing was consumed.
    assert.deepEqual(out.pile, pile);
  });

  // The failure the old model had: pin a card for slot 2, and it landed on
  // whichever slot happened to be discarded first.
  test('a pin for a slot that is NOT discarded is never dealt', () => {
    const slotDraws = [null, null, card(4, 'S'), null, null];
    const out = applyDiscards({ hand, pile, indices: [0], slotDraws });
    assert.deepEqual(out.hand[0], card(9, 'S'));
    assert.equal(out.hand.some((c) => c.rank === 4), false);
  });

  test('pinned and un-pinned discards in the same round each get the right card', () => {
    const slotDraws = [null, null, card(4, 'S'), null, null];
    const out = applyDiscards({ hand, pile, indices: [0, 2, 4], slotDraws });
    assert.deepEqual(out.hand[0], card(9, 'S'));
    assert.deepEqual(out.hand[2], card(4, 'S'));
    assert.deepEqual(out.hand[4], card(9, 'D'));
    assert.deepEqual(out.pile, [card(9, 'H')]);
  });

  // Second Look discards twice. The same card arriving in the same slot in both
  // rounds is something no physical deck can do.
  test('a pinned replacement is dealt at most once across rounds', () => {
    const slotDraws = [null, null, card(4, 'S'), null, null];
    const first = applyDiscards({ hand, pile, indices: [2], slotDraws });
    assert.deepEqual(first.hand[2], card(4, 'S'));
    const second = applyDiscards({ hand: first.hand, pile: first.pile, indices: [2], slotDraws: first.slotDraws });
    assert.deepEqual(second.hand[2], card(9, 'S'));
  });

  test('the caller\'s slotDraws array is not mutated', () => {
    const slotDraws = [null, null, card(4, 'S'), null, null];
    applyDiscards({ hand, pile, indices: [2], slotDraws });
    assert.deepEqual(slotDraws[2], card(4, 'S'));
  });
});

describe('dealFromStack', () => {
  test('the pinned hand is exactly what is dealt, and pins are kept off the pile', () => {
    const stack = validDeal({ slotDraws: [null, null, card(2, 'H'), null, null] });
    const { hand, drawPile, slotDraws } = dealFromStack(12345, stack);
    assert.deepEqual(hand, ROYAL);
    assert.deepEqual(slotDraws[2], card(2, 'H'));
    const inPile = drawPile.some((c) => c.rank === 2 && c.suit === 'H');
    assert.equal(inPile, false, 'a pinned replacement must not also sit in the draw pile');
  });

  // THE PROPERTY THE WHOLE FEATURE RESTS ON. The board and the Edge Function
  // are different machines; they agree only because this is derived from the
  // seed. Anything random in here that did not come from the seed breaks only
  // in production.
  test('the same seed and stack always build the identical deal', () => {
    const a = dealFromStack(999, validDeal({ slotDraws: [card(2, 'H'), null, null, null, null] }));
    const b = dealFromStack(999, validDeal({ slotDraws: [card(2, 'H'), null, null, null, null] }));
    assert.deepEqual(a, b);
  });

  test('a different seed changes only the un-pinned cards', () => {
    const stack = validDeal({ slotDraws: [card(2, 'H'), null, null, null, null] });
    const a = dealFromStack(1, stack);
    const b = dealFromStack(2, stack);
    assert.deepEqual(a.hand, b.hand);
    assert.deepEqual(a.slotDraws, b.slotDraws);
    assert.notDeepEqual(a.drawPile, b.drawPile);
  });

  test('the deck is still 52 cards, no more and no fewer', () => {
    const stack = validDeal({ slotDraws: [card(2, 'H'), null, null, null, null] });
    const { hand, drawPile, slotDraws } = dealFromStack(77, stack);
    const all = [...hand, ...drawPile, ...slotDraws.filter(Boolean)];
    assert.equal(all.length, 52);
    assert.equal(new Set(all.map((c) => `${c.rank}${c.suit}`)).size, 52);
  });

  test('rarity and wild survive onto pinned cards', () => {
    const stack = {
      hand: [card(14, 'S', { rarity: 'diamond', wild: true }), ...ROYAL.slice(1)],
      slotDraws: [null, card(3, 'C', { rarity: 'gold' }), null, null, null],
    };
    const { hand, slotDraws } = dealFromStack(5, stack);
    assert.equal(hand[0].rarity, 'diamond');
    assert.equal(hand[0].wild, true);
    assert.equal(slotDraws[1].rarity, 'gold');
  });

  test('a malformed stack throws rather than dealing something arbitrary', () => {
    assert.throws(() => dealFromStack(1, { hand: ROYAL.slice(0, 3) }));
  });
});

describe('verifyAndScoreRun with a stacked deal', () => {
  test('the server scores the stacked cards, not the seed-dealt ones', () => {
    const verified = verifyAndScoreRun({
      seed: 4242,
      discardRounds: [[]],
      modifier: plainModifier,
      stackedDeal: validDeal(),
    });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.finalHand, ROYAL);
    assert.equal(verified.score.handResult.id, 'ROYAL_FLUSH');
  });

  // End to end, in the owner's own words: 2 3 Q 5 6, pin the 4 opposite the Q,
  // they discard the Q, they get a straight.
  test('discarding the pinned slot completes the intended hand', () => {
    const stack = {
      hand: [card(2, 'C'), card(3, 'D'), card(12, 'S'), card(5, 'H'), card(6, 'C')],
      slotDraws: [null, null, card(4, 'S'), null, null],
    };
    const verified = verifyAndScoreRun({ seed: 7, discardRounds: [[2]], modifier: plainModifier, stackedDeal: stack });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.finalHand[2], card(4, 'S'));
    assert.equal(verified.score.handResult.id, 'STRAIGHT');
  });

  test('discarding a different slot does not hand over the pinned card', () => {
    const stack = {
      hand: [card(2, 'C'), card(3, 'D'), card(12, 'S'), card(5, 'H'), card(6, 'C')],
      slotDraws: [null, null, card(4, 'S'), null, null],
    };
    const verified = verifyAndScoreRun({ seed: 7, discardRounds: [[0]], modifier: plainModifier, stackedDeal: stack });
    assert.equal(verified.ok, true);
    assert.equal(
      verified.finalHand.some((c) => c.rank === 4 && c.suit === 'S'),
      false,
    );
  });

  // The ordinary path is every player, every day.
  test('no stacked deal leaves the ordinary deal completely untouched', () => {
    const withNull = verifyAndScoreRun({ seed: 31337, discardRounds: [[0]], modifier: plainModifier, stackedDeal: null });
    const without = verifyAndScoreRun({ seed: 31337, discardRounds: [[0]], modifier: plainModifier });
    assert.deepEqual(withNull, without);
    assert.deepEqual(withNull.originalHand, dealHand(31337).hand);
  });

  // CHANGED FROM REFUSING. board.js falls back to an ordinary deal on a
  // malformed stack, so refusing here meant the player played a perfectly
  // normal hand and then had it rejected — losing the day to a bad admin row
  // they never saw. Both halves ignoring the same unreadable stack is the only
  // pairing where they agree AND nobody is punished.
  test('a malformed stacked deal falls back to the ordinary deal, exactly as the board does', () => {
    const verified = verifyAndScoreRun({
      seed: 31337,
      discardRounds: [[0]],
      modifier: plainModifier,
      stackedDeal: { hand: ROYAL.slice(0, 4) },
    });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.originalHand, dealHand(31337).hand);
  });
});
