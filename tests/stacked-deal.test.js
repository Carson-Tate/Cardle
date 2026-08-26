import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dealFromStack, normalizeStackedDeal, dealHand, STACK_HAND_SIZE, STACK_MAX_DRAWS } from '../src/core/deck.js';
import { verifyAndScoreRun } from '../src/core/verify-run.js';
import { getDailyModifier } from '../src/core/modifiers.js';

const card = (rank, suit, extra = {}) => ({ rank, suit, rarity: null, wild: false, ...extra });
const ROYAL = [card(14, 'S'), card(13, 'S'), card(12, 'S'), card(11, 'S'), card(10, 'S')];
const validDeal = (over = {}) => ({ hand: ROYAL, draws: [], ...over });

// A day with no modifier surprises, so these test the deal rather than a rule.
const plainModifier = getDailyModifier(new Date('2026-01-15T12:00:00Z'));

describe('normalizeStackedDeal', () => {
  test('a well-formed deal passes and comes back normalized', () => {
    const { ok, deal } = normalizeStackedDeal(validDeal({ draws: [card(2, 'H')] }));
    assert.equal(ok, true);
    assert.equal(deal.hand.length, STACK_HAND_SIZE);
    assert.deepEqual(deal.draws, [card(2, 'H')]);
  });

  test('rank and suit are coerced and defaulted, so a stored string still works', () => {
    const { ok, deal } = normalizeStackedDeal({ hand: ROYAL.map((c) => ({ rank: String(c.rank), suit: c.suit })) });
    assert.equal(ok, true);
    assert.equal(deal.hand[0].rank, 14);
    assert.equal(deal.hand[0].rarity, null);
    assert.equal(deal.hand[0].wild, false);
  });

  // THE LOAD-BEARING ONE. evaluateHand throws on anything that isn't five
  // cards, and it is called from the board's render path — a four-card stack
  // would take the whole page down rather than merely failing to be a surprise.
  test('a hand that is not exactly five cards is refused', () => {
    assert.equal(normalizeStackedDeal({ hand: ROYAL.slice(0, 4) }).ok, false);
    assert.equal(normalizeStackedDeal({ hand: [...ROYAL, card(9, 'S')] }).ok, false);
  });

  // One physical deck. A card pinned into the hand AND the draw pile would be
  // dealt to the player twice, which no real deck can do and the evaluator does
  // not expect.
  test('the same card cannot appear twice, in either half', () => {
    assert.equal(normalizeStackedDeal({ hand: [...ROYAL.slice(0, 4), card(14, 'S')] }).ok, false);
    assert.equal(normalizeStackedDeal(validDeal({ draws: [card(14, 'S')] })).ok, false);
  });

  test('junk ranks, suits and rarity tiers are refused rather than silently dropped', () => {
    assert.equal(normalizeStackedDeal({ hand: [card(99, 'S'), ...ROYAL.slice(1)] }).ok, false);
    assert.equal(normalizeStackedDeal({ hand: [card(14, 'X'), ...ROYAL.slice(1)] }).ok, false);
    // Downgrading an unknown tier to null would change the score without saying so.
    assert.equal(normalizeStackedDeal({ hand: [card(14, 'S', { rarity: 'platinum' }), ...ROYAL.slice(1)] }).ok, false);
  });

  test('more pinned draws than the cap is refused', () => {
    const draws = [card(2, 'H'), card(3, 'H'), card(4, 'H'), card(5, 'H'), card(6, 'H'), card(7, 'H')];
    assert.equal(draws.length, STACK_MAX_DRAWS + 1);
    assert.equal(normalizeStackedDeal(validDeal({ draws })).ok, false);
  });

  test('absent or malformed input is refused, not thrown on', () => {
    for (const value of [null, undefined, 'nonsense', 42, {}, { hand: 'nope' }]) {
      assert.equal(normalizeStackedDeal(value).ok, false);
    }
  });
});

describe('dealFromStack', () => {
  test('the pinned cards are exactly what is dealt', () => {
    const { hand, drawPile } = dealFromStack(12345, validDeal({ draws: [card(2, 'H'), card(3, 'D')] }));
    assert.deepEqual(hand, ROYAL);
    assert.deepEqual(drawPile.slice(0, 2), [card(2, 'H'), card(3, 'D')]);
  });

  // THE PROPERTY THE WHOLE FEATURE RESTS ON. The board and the Edge Function
  // are different machines running this with the same row's seed; if it were
  // not deterministic, the server would re-score a different hand and the
  // player would be paid for cards they never saw. Anything random in there
  // that did not come from the seed breaks only in production.
  test('the same seed and stack always build the identical deal', () => {
    const a = dealFromStack(999, validDeal({ draws: [card(2, 'H')] }));
    const b = dealFromStack(999, validDeal({ draws: [card(2, 'H')] }));
    assert.deepEqual(a, b);
  });

  test('a different seed changes only the un-pinned cards', () => {
    const a = dealFromStack(1, validDeal({ draws: [card(2, 'H')] }));
    const b = dealFromStack(2, validDeal({ draws: [card(2, 'H')] }));
    assert.deepEqual(a.hand, b.hand);
    assert.deepEqual(a.drawPile[0], b.drawPile[0]);
    assert.notDeepEqual(a.drawPile.slice(1), b.drawPile.slice(1));
  });

  // A pinned card must not also be sitting in the filler, or discarding could
  // deal you your own card back.
  test('no pinned card reappears in the rest of the pile', () => {
    const stack = validDeal({ draws: [card(2, 'H'), card(3, 'D')] });
    const { hand, drawPile } = dealFromStack(4242, stack);
    const pinned = new Set([...hand, ...drawPile.slice(0, 2)].map((c) => `${c.rank}${c.suit}`));
    for (const c of drawPile.slice(2)) {
      assert.equal(pinned.has(`${c.rank}${c.suit}`), false, `${c.rank}${c.suit} was dealt twice`);
    }
  });

  test('the deck is still 52 cards, no more and no fewer', () => {
    const { hand, drawPile } = dealFromStack(77, validDeal({ draws: [card(2, 'H')] }));
    const all = new Set([...hand, ...drawPile].map((c) => `${c.rank}${c.suit}`));
    assert.equal(hand.length + drawPile.length, 52);
    assert.equal(all.size, 52);
  });

  test('rarity and wild survive onto the pinned cards', () => {
    const stack = { hand: [card(14, 'S', { rarity: 'diamond', wild: true }), ...ROYAL.slice(1)], draws: [] };
    const { hand } = dealFromStack(5, stack);
    assert.equal(hand[0].rarity, 'diamond');
    assert.equal(hand[0].wild, true);
  });

  test('a malformed stack throws rather than dealing something arbitrary', () => {
    assert.throws(() => dealFromStack(1, { hand: ROYAL.slice(0, 3) }));
  });
});

describe('verifyAndScoreRun with a stacked deal', () => {
  // The agreement assertion, stated end to end: what the board would put on
  // screen and what the server pays out are the same cards.
  test('the server scores the stacked cards, not the seed-dealt ones', () => {
    const stack = validDeal();
    const verified = verifyAndScoreRun({ seed: 4242, discardRounds: [[]], modifier: plainModifier, stackedDeal: stack });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.finalHand, ROYAL);
    assert.equal(verified.score.handResult.id, 'ROYAL_FLUSH');
  });

  test('a discard is served from the pinned draw pile in order', () => {
    const stack = { hand: [...ROYAL.slice(0, 4), card(2, 'C')], draws: [card(10, 'S')] };
    const verified = verifyAndScoreRun({ seed: 7, discardRounds: [[4]], modifier: plainModifier, stackedDeal: stack });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.finalHand[4], card(10, 'S'));
    assert.equal(verified.score.handResult.id, 'ROYAL_FLUSH');
  });

  // Without a stack the behaviour must be byte-identical to before this
  // existed — the ordinary path is every player, every day.
  test('no stacked deal leaves the ordinary deal completely untouched', () => {
    const withNull = verifyAndScoreRun({ seed: 31337, discardRounds: [[0]], modifier: plainModifier, stackedDeal: null });
    const without = verifyAndScoreRun({ seed: 31337, discardRounds: [[0]], modifier: plainModifier });
    assert.deepEqual(withNull, without);
    assert.deepEqual(withNull.originalHand, dealHand(31337).hand);
  });

  // REFUSED, NOT SILENTLY DOWNGRADED. Scoring the ordinary deal here would pay
  // the player for five cards that were never on their screen.
  test('a malformed stacked deal is rejected rather than scored from the seed', () => {
    const verified = verifyAndScoreRun({
      seed: 1,
      discardRounds: [[]],
      modifier: plainModifier,
      stackedDeal: { hand: ROYAL.slice(0, 4) },
    });
    assert.equal(verified.ok, false);
    assert.ok(verified.errors.some((e) => e.startsWith('stacked deal:')));
  });
});
