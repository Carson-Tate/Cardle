import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDailyModifier,
  modifierScoringMultiplier,
  modifierBoardIsAscending,
  MODIFIERS,
} from '../src/core/modifiers.js';
import { evaluateHand } from '../src/core/hand-evaluator.js';
import { suitGlyph } from '../src/core/deck.js';

const c = (rank, suit) => ({ rank, suit });

describe('getDailyModifier', () => {
  test('is deterministic for the same day', () => {
    const date = new Date('2026-08-10T00:00:00Z');
    const a = getDailyModifier(date);
    const b = getDailyModifier(date);
    assert.deepEqual(a, b);
  });

  // The intent here is "the modifier depends on which DAY it is, not the time
  // within that day". Both samples must therefore sit inside one GAME day
  // (DESIGN.md §11l) — the day now rolls at 7pm New York, which in summer is
  // 23:00 UTC, so the old 23:00 sample was actually the next day's modifier.
  test('is the same regardless of time-of-day within one game day', () => {
    const morning = getDailyModifier(new Date('2026-08-10T01:00:00Z'));
    const evening = getDailyModifier(new Date('2026-08-10T22:59:00Z'));
    assert.deepEqual(morning, evening);
  });

  test('changes at the 7pm reset, in step with the new hand', () => {
    const before = getDailyModifier(new Date('2026-08-10T22:59:00Z'));
    const after = getDailyModifier(new Date('2026-08-10T23:00:00Z'));
    assert.notDeepEqual(before, after, 'a new game day means a new modifier');
    const laterSameGameDay = getDailyModifier(new Date('2026-08-11T05:00:00Z'));
    assert.deepEqual(after, laterSameGameDay, 'and it does not change again at midnight UTC');
  });

  test('every day has some active modifier (no "vanilla" day)', () => {
    for (let d = 0; d < 20; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date);
      assert.ok(modifier?.id, `day ${d} had no modifier`);
    }
  });

  test('no modifier repeats within any trailing window of (roster size) consecutive days', () => {
    const results = [];
    for (let d = 0; d < 40; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      results.push(getDailyModifier(date).id);
    }
    const windowSize = MODIFIERS.length;
    for (let i = 0; i < results.length; i++) {
      for (let j = Math.max(0, i - windowSize + 1); j < i; j++) {
        assert.notEqual(results[i], results[j], `day ${i} repeated day ${j}'s modifier (${results[i]})`);
      }
    }
  });

  test('suitBonus days include a valid bonusSuit, and its description shows the suit glyph, not a letter code', () => {
    for (let d = 0; d < 20; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date);
      if (modifier.id === 'suitBonus') {
        assert.ok(['S', 'H', 'D', 'C'].includes(modifier.bonusSuit), modifier.bonusSuit);
        assert.ok(modifier.description.includes(suitGlyph(modifier.bonusSuit)), modifier.description);
        assert.ok(!modifier.description.includes(` ${modifier.bonusSuit} `), modifier.description);
      }
    }
  });

  test('lockedCard days include a valid lockedIndex (0-4)', () => {
    for (let d = 0; d < 20; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date);
      if (modifier.id === 'lockedCard') {
        assert.ok(Number.isInteger(modifier.lockedIndex) && modifier.lockedIndex >= 0 && modifier.lockedIndex <= 4);
      }
    }
  });

  test('discardLimit modifiers carry the documented maxDiscards', () => {
    for (let d = 0; d < 20; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date);
      if (modifier.id === 'fourthChance') assert.equal(modifier.maxDiscards, 4);
      if (modifier.id === 'cleanSlate') assert.equal(modifier.maxDiscards, 5);
    }
  });

  test('secondLook days carry a round1MaxDiscards strictly greater than round2MaxDiscards', () => {
    for (let d = 0; d < 20; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date);
      if (modifier.id === 'secondLook') {
        assert.equal(modifier.type, 'twoRoundDiscard');
        assert.ok(Number.isInteger(modifier.round1MaxDiscards) && modifier.round1MaxDiscards > 0);
        assert.ok(Number.isInteger(modifier.round2MaxDiscards) && modifier.round2MaxDiscards > 0);
        assert.ok(
          modifier.round2MaxDiscards < modifier.round1MaxDiscards,
          `round 2 (${modifier.round2MaxDiscards}) should be less than round 1 (${modifier.round1MaxDiscards})`,
        );
      }
    }
  });

  test('every modifier has a non-empty player-facing description', () => {
    for (let d = 0; d < 10; d++) {
      const date = new Date('2026-07-27T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date);
      assert.ok(typeof modifier.description === 'string' && modifier.description.length > 0);
    }
  });

  test('stays fast for a date many years in the future (loop is bounded, not exponential)', () => {
    const start = Date.now();
    getDailyModifier(new Date('2040-01-01T00:00:00Z'));
    assert.ok(Date.now() - start < 200, 'took too long for a far-future date');
  });
});

describe('modifierScoringMultiplier', () => {
  test('suitBonus multiplies by +50% per matching card in the final hand', () => {
    const dailyModifier = { id: 'suitBonus', bonusSuit: 'D' };
    const hand = [c(2, 'D'), c(5, 'D'), c(9, 'S'), c(11, 'C'), c(13, 'H')]; // 2 diamonds
    const finalHandResult = evaluateHand(hand);
    const multiplier = modifierScoringMultiplier(dailyModifier)(finalHandResult, hand);
    assert.equal(multiplier, 2); // 1 + 2 matching cards * 0.5
  });

  test('suitBonus multiplies by 1 (no-op) when no card matches the bonus suit', () => {
    const dailyModifier = { id: 'suitBonus', bonusSuit: 'D' };
    const hand = [c(2, 'S'), c(5, 'S'), c(9, 'S'), c(11, 'C'), c(13, 'H')];
    const finalHandResult = evaluateHand(hand);
    assert.equal(modifierScoringMultiplier(dailyModifier)(finalHandResult, hand), 1);
  });

  test('flushFrenzy quadruples the total when the final hand is a Flush', () => {
    const dailyModifier = { id: 'flushFrenzy' };
    const hand = [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')];
    const finalHandResult = evaluateHand(hand);
    assert.equal(finalHandResult.id, 'FLUSH');
    const multiplier = modifierScoringMultiplier(dailyModifier)(finalHandResult, hand);
    assert.equal(multiplier, 4);
  });

  test('flushFrenzy multiplies by 1 (no-op) for a non-Flush hand', () => {
    const dailyModifier = { id: 'flushFrenzy' };
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]; // pair
    const finalHandResult = evaluateHand(hand);
    assert.notEqual(finalHandResult.id, 'FLUSH');
    assert.equal(modifierScoringMultiplier(dailyModifier)(finalHandResult, hand), 1);
  });

  // Bug: the check was `id === 'FLUSH'` exactly, so on a day advertised as
  // "Flushes score 4x today" the two BEST flushes in the game got nothing —
  // landing a Royal Flush was worth less than an ordinary flush.
  test('flushFrenzy also covers Straight Flush and Royal Flush', () => {
    const dailyModifier = { id: 'flushFrenzy' };
    const straightFlush = [c(5, 'S'), c(6, 'S'), c(7, 'S'), c(8, 'S'), c(9, 'S')];
    const royalFlush = [c(10, 'S'), c(11, 'S'), c(12, 'S'), c(13, 'S'), c(14, 'S')];
    assert.equal(evaluateHand(straightFlush).id, 'STRAIGHT_FLUSH');
    assert.equal(evaluateHand(royalFlush).id, 'ROYAL_FLUSH');
    assert.equal(modifierScoringMultiplier(dailyModifier)(evaluateHand(straightFlush), straightFlush), 4);
    assert.equal(modifierScoringMultiplier(dailyModifier)(evaluateHand(royalFlush), royalFlush), 4);
  });

  test('highRoller always multiplies by 1.5, regardless of the hand', () => {
    const dailyModifier = { id: 'highRoller' };
    for (const hand of [
      [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')], // Flush
      [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')], // High Card
    ]) {
      const finalHandResult = evaluateHand(hand);
      assert.equal(modifierScoringMultiplier(dailyModifier)(finalHandResult, hand), 1.5);
    }
  });

  test('discardLimit, lockedCard, and twoRoundDiscard modifiers never contribute a scoring multiplier', () => {
    const hand = [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')]; // a flush, so any accidental scoring hook would show up
    const finalHandResult = evaluateHand(hand);
    // flippedBoard joins them: it changes only how the leaderboard is SORTED,
    // so it must never touch a score (owner: "normal draw").
    for (const id of ['fourthChance', 'cleanSlate', 'lockedCard', 'secondLook', 'flippedBoard']) {
      assert.equal(modifierScoringMultiplier({ id })(finalHandResult, hand), 1, id);
    }
  });

  test('doubleOrNothing multiplies by 1 (no-op) until the wager is resolved', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]; // Pair — would double if wagered
    const finalHandResult = evaluateHand(hand);
    assert.equal(modifierScoringMultiplier({ id: 'doubleOrNothing' })(finalHandResult, hand), 1);
    assert.equal(modifierScoringMultiplier({ id: 'doubleOrNothing', wagered: false })(finalHandResult, hand), 1);
  });

  test('doubleOrNothing doubles when wagered and the hand is at least a Pair', () => {
    const dailyModifier = { id: 'doubleOrNothing', wagered: true };
    const pair = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const flush = [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')];
    for (const hand of [pair, flush]) {
      const finalHandResult = evaluateHand(hand);
      assert.equal(modifierScoringMultiplier(dailyModifier)(finalHandResult, hand), 2, finalHandResult.id);
    }
  });

  test('doubleOrNothing zeroes out when wagered and the hand is only a High Card', () => {
    const dailyModifier = { id: 'doubleOrNothing', wagered: true };
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    const finalHandResult = evaluateHand(hand);
    assert.equal(finalHandResult.id, 'HIGH_CARD');
    assert.equal(modifierScoringMultiplier(dailyModifier)(finalHandResult, hand), 0);
  });

  test('returns 1 (no-op) with no active modifier', () => {
    const hand = [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')];
    const finalHandResult = evaluateHand(hand);
    assert.equal(modifierScoringMultiplier(null)(finalHandResult, hand), 1);
  });
});

describe('MODIFIERS registry — new §4d entries', () => {
  test('cleanSlate is a discardLimit modifier with maxDiscards 5', () => {
    const modifier = MODIFIERS.find((m) => m.id === 'cleanSlate');
    assert.equal(modifier.type, 'discardLimit');
    assert.equal(modifier.maxDiscards, 5);
  });

  test('highRoller is a scoring modifier', () => {
    const modifier = MODIFIERS.find((m) => m.id === 'highRoller');
    assert.equal(modifier.type, 'scoring');
  });

  test('secondLook is a twoRoundDiscard modifier with round 2 stricter than round 1', () => {
    const modifier = MODIFIERS.find((m) => m.id === 'secondLook');
    assert.equal(modifier.type, 'twoRoundDiscard');
    assert.ok(modifier.round2MaxDiscards < modifier.round1MaxDiscards);
  });

  test('doubleOrNothing is a peekWager modifier', () => {
    const modifier = MODIFIERS.find((m) => m.id === 'doubleOrNothing');
    assert.equal(modifier.type, 'peekWager');
  });
});

// --- §4f's batch ------------------------------------------------------------
describe('Held Card', () => {
  const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
  const result = evaluateHand(hand);
  const mult = (markedIndex, discardIndices) =>
    modifierScoringMultiplier({ id: 'heldCard', markedIndex })(result, hand, { discardIndices });

  test('pays out when the marked slot was not discarded', () => {
    assert.equal(mult(3, [0, 1]), 2);
    assert.equal(mult(3, []), 2, 'discarding nothing keeps it too');
  });

  test('pays nothing when the marked slot was discarded', () => {
    assert.equal(mult(3, [3]), 1);
    assert.equal(mult(0, [0, 2, 4]), 1);
  });

  // The reason the check is on discardIndices rather than the final hand: a
  // replacement occupies the same index, so the hand alone cannot answer it.
  test('is decided by the slot, not by what card ended up there', () => {
    assert.equal(mult(2, [2]), 1, 'slot 2 was swapped, even though a card sits there');
  });

  test('defaults to no payout when the caller supplies no discard context', () => {
    // An empty discard list means nothing was thrown away, so the card is kept.
    assert.equal(modifierScoringMultiplier({ id: 'heldCard', markedIndex: 1 })(result, hand), 2);
  });
});

describe('Rainbow', () => {
  const mult = (hand) => modifierScoringMultiplier({ id: 'rainbow' })(evaluateHand(hand), hand);

  test('pays out when all four suits are present', () => {
    assert.equal(mult([c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]), 2.5);
  });

  test('pays nothing when a suit is missing', () => {
    assert.equal(mult([c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'H'), c(13, 'S')]), 1);
    assert.equal(mult([c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')]), 1, 'a flush is the opposite of a rainbow');
  });
});

describe('Even Money (parity)', () => {
  // 2,4 even; 5,7,9 odd.
  const hand = [c(2, 'S'), c(4, 'H'), c(5, 'D'), c(7, 'C'), c(9, 'S')];
  const result = evaluateHand(hand);
  const mult = (parity) => modifierScoringMultiplier({ id: 'parity', parity })(result, hand);

  test('adds per matching card', () => {
    assert.equal(mult('even'), 1 + 2 * 0.25);
    assert.equal(mult('odd'), 1 + 3 * 0.25);
  });

  test('treats face cards by their rank value', () => {
    // J=11 odd, Q=12 even, K=13 odd, A=14 even.
    const faces = [c(11, 'S'), c(12, 'H'), c(13, 'D'), c(14, 'C'), c(2, 'S')];
    const faceResult = evaluateHand(faces);
    assert.equal(modifierScoringMultiplier({ id: 'parity', parity: 'even' })(faceResult, faces), 1 + 3 * 0.25);
    assert.equal(modifierScoringMultiplier({ id: 'parity', parity: 'odd' })(faceResult, faces), 1 + 2 * 0.25);
  });

  test('defaults to even when no parity was resolved', () => {
    assert.equal(modifierScoringMultiplier({ id: 'parity' })(result, hand), mult('even'));
  });
});

describe('Hot Hand', () => {
  const pair = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(7, 'S')];
  const twoPair = [c(9, 'S'), c(9, 'H'), c(4, 'D'), c(4, 'C'), c(7, 'S')];
  const mult = (hand, hotHandId) =>
    modifierScoringMultiplier({ id: 'hotHand', hotHandId })(evaluateHand(hand), hand);

  test('pays out on the exact named category', () => {
    assert.equal(mult(pair, 'PAIR'), 4);
    assert.equal(mult(twoPair, 'TWO_PAIR'), 4);
  });

  test('pays nothing for a different category, better or worse', () => {
    assert.equal(mult(twoPair, 'PAIR'), 1, 'a better hand is still not the named one');
    assert.equal(mult(pair, 'TWO_PAIR'), 1);
  });

  test('only ever names a category that can actually pay out', () => {
    // High Card scores 0 (multiplying it stays 0) and Royal Flush is too rare
    // for the day to mean anything — neither may be picked.
    for (let d = 0; d < 400; d++) {
      const date = new Date('2026-07-27T12:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      const modifier = getDailyModifier(date, 'hotHand');
      assert.ok(modifier.hotHandId, 'a hot hand day always resolves a category');
      assert.notEqual(modifier.hotHandId, 'HIGH_CARD');
      assert.notEqual(modifier.hotHandId, 'ROYAL_FLUSH');
      assert.ok(modifier.description.includes(modifier.hotHandLabel));
    }
  });
});

describe('Upside Down (flipped leaderboard)', () => {
  test('flags the daily board as ascending', () => {
    assert.equal(modifierBoardIsAscending(getDailyModifier(new Date(), 'flippedBoard')), true);
  });

  test('every other modifier leaves the board alone', () => {
    for (const m of MODIFIERS) {
      if (m.id === 'flippedBoard') continue;
      assert.equal(modifierBoardIsAscending(getDailyModifier(new Date(), m.id)), false, m.id);
    }
    assert.equal(modifierBoardIsAscending(null), false);
    assert.equal(modifierBoardIsAscending(undefined), false);
  });
});

describe('One Swap is gone', () => {
  test('no longer in the roster', () => {
    assert.equal(MODIFIERS.find((m) => m.id === 'oneSwap'), undefined);
  });

  test('and can never be produced by the rotation', () => {
    for (let d = 0; d < 200; d++) {
      const date = new Date('2026-07-27T12:00:00Z');
      date.setUTCDate(date.getUTCDate() + d);
      assert.notEqual(getDailyModifier(date).id, 'oneSwap');
    }
  });
});
