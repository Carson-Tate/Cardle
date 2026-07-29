import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMeters } from '../src/core/meters.js';
import { scoreForHandId } from '../src/core/hand-evaluator.js';

const weakOriginal = { score: 0 }; // High Card opener
// Needs to be a large enough fraction of MAX_HAND_SCORE (Royal Flush, now in
// the tens of millions post-rebalance) that chaseBonus's rounded difference
// from 0 is actually visible — Full House alone rounds away to nothing.
const strongOriginal = { score: scoreForHandId('STRAIGHT_FLUSH') };

describe('skill', () => {
  test('scales directly with decision rating', () => {
    const { skill } = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 100,
      chosenEV: 100,
      bestEV: 200,
      decisionRating: 0.5,
      discardedCount: 1,
      maxDiscards: 3,
    });
    assert.equal(skill, 50);
  });

  test('caps at 100 even when decision rating exceeds 1.0 (lucky draw beat the average)', () => {
    const { skill } = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 300,
      chosenEV: 100,
      bestEV: 200,
      decisionRating: 1.8,
      discardedCount: 1,
      maxDiscards: 3,
    });
    assert.equal(skill, 100);
  });

  test('caps at 100 for a non-finite decision rating (edge case)', () => {
    const { skill } = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 50,
      chosenEV: 0,
      bestEV: 0,
      decisionRating: Infinity,
      discardedCount: 0,
      maxDiscards: 3,
    });
    assert.equal(skill, 100);
  });
});

describe('risk', () => {
  test('is zero when nothing was discarded, regardless of other inputs', () => {
    const { risk } = computeMeters({
      originalHandResult: strongOriginal,
      actualScore: 500,
      chosenEV: 500,
      bestEV: 500,
      decisionRating: 1,
      discardedCount: 0,
      maxDiscards: 3,
    });
    assert.equal(risk, 0);
  });

  test('increases with how many cards were discarded', () => {
    const base = (discardedCount) =>
      computeMeters({
        originalHandResult: weakOriginal,
        actualScore: 100,
        chosenEV: 100,
        bestEV: 100,
        decisionRating: 1,
        discardedCount,
        maxDiscards: 3,
      }).risk;
    assert.ok(base(1) < base(2));
    assert.ok(base(2) < base(3));
  });

  test('is higher when abandoning an already-strong original hand than a weak one', () => {
    const weakChase = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 100,
      chosenEV: 100,
      bestEV: 100,
      decisionRating: 1,
      discardedCount: 2,
      maxDiscards: 3,
    }).risk;
    const strongChase = computeMeters({
      originalHandResult: strongOriginal,
      actualScore: 100,
      chosenEV: 100,
      bestEV: 100,
      decisionRating: 1,
      discardedCount: 2,
      maxDiscards: 3,
    }).risk;
    assert.ok(strongChase > weakChase);
  });

  test('never exceeds 100 even at max discards from a maxed-out original hand', () => {
    const { risk } = computeMeters({
      originalHandResult: { score: 1000 },
      actualScore: 100,
      chosenEV: 100,
      bestEV: 100,
      decisionRating: 1,
      discardedCount: 3,
      maxDiscards: 3,
    });
    assert.ok(risk <= 100);
  });
});

describe('luck', () => {
  test('running hot (actual beats chosen EV) scores higher than running cold, holding deal quality constant', () => {
    const hot = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 400,
      chosenEV: 100,
      bestEV: 150,
      decisionRating: 1,
      discardedCount: 1,
      maxDiscards: 3,
    }).luck;
    const cold = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 0,
      chosenEV: 100,
      bestEV: 150,
      decisionRating: 1,
      discardedCount: 1,
      maxDiscards: 3,
    }).luck;
    assert.ok(hot > cold);
  });

  test('a stronger starting deal (higher bestEV) scores higher luck, holding draw fortune constant', () => {
    const weakDeal = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 100,
      chosenEV: 100,
      bestEV: 50,
      decisionRating: 1,
      discardedCount: 1,
      maxDiscards: 3,
    }).luck;
    const strongDeal = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 100,
      chosenEV: 100,
      bestEV: 350,
      decisionRating: 1,
      discardedCount: 1,
      maxDiscards: 3,
    }).luck;
    assert.ok(strongDeal > weakDeal);
  });

  test('stays within 0-100 for extreme inputs', () => {
    const high = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 1000,
      chosenEV: 0,
      bestEV: 1000,
      decisionRating: 1,
      discardedCount: 1,
      maxDiscards: 3,
    }).luck;
    const low = computeMeters({
      originalHandResult: weakOriginal,
      actualScore: 0,
      chosenEV: 1000,
      bestEV: 0,
      decisionRating: 1,
      discardedCount: 1,
      maxDiscards: 3,
    }).luck;
    assert.ok(high <= 100);
    assert.ok(low >= 0);
  });
});
