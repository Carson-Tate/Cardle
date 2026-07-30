import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMeters } from '../src/core/meters.js';
import { scoreForHandId } from '../src/core/hand-evaluator.js';

const weakOriginal = { score: 0 }; // High Card opener
// Any decent made hand now moves Risk's chase component visibly. This used to
// need a STRAIGHT_FLUSH: the chase term was normalized against ROYAL_FLUSH
// (~55 million), so everything below a straight flush contributed under a
// single point and rounded away entirely. That was the bug, not the fixture —
// see meters.js's RISK_CHASE_CEILING comment.
const strongOriginal = { score: scoreForHandId('TWO_PAIR') };

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
      originalHandResult: { score: scoreForHandId('ROYAL_FLUSH') },
      actualScore: 100,
      chosenEV: 100,
      bestEV: 100,
      decisionRating: 1,
      discardedCount: 3,
      maxDiscards: 3,
    });
    assert.ok(risk <= 100);
  });

  // Regression guard for a dead half of the formula: the chase component was
  // normalized against ROYAL_FLUSH, so at realistic scores it contributed
  // under 1 point of its 40 and Risk could never exceed 60 — which in turn
  // made "The Gambler" (personality.js, needs risk >= 65) unreachable.
  test('chasing from a real made hand pushes Risk past the discard-only ceiling of 60', () => {
    const risk = (score) =>
      computeMeters({
        originalHandResult: { score },
        actualScore: 100,
        chosenEV: 100,
        bestEV: 100,
        decisionRating: 1,
        discardedCount: 3,
        maxDiscards: 3,
      }).risk;
    assert.equal(risk(0), 60, 'discarding everything from nothing is the 60-point floor');
    assert.ok(risk(scoreForHandId('TWO_PAIR')) > 65, 'abandoning Two Pair should read as a real gamble');
    assert.equal(risk(scoreForHandId('THREE_OF_A_KIND')), 100, 'Three of a Kind and up saturates the chase term');
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
