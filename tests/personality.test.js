import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPersonality, PERSONALITIES } from '../src/core/personality.js';
import { scoreForHandId } from '../src/core/hand-evaluator.js';

function ctx(overrides = {}) {
  return {
    meters: { luck: 50, skill: 50, risk: 20 },
    discardedCount: 1,
    maxDiscards: 3,
    originalHandResult: { id: 'PAIR', score: 40 },
    finalHandResult: { id: 'PAIR', score: 40 },
    skillBonuses: { perfectKeep: 0, longShot: 0, cleanFinish: 0, optimalDiscard: 0 },
    extraBonuses: [],
    ...overrides,
  };
}

describe('classifyPersonality', () => {
  test('The Shark: high skill + a big final hand', () => {
    const result = classifyPersonality(
      ctx({ meters: { skill: 95, risk: 20, luck: 50 }, finalHandResult: { id: 'FLUSH', score: scoreForHandId('FLUSH') } }),
    );
    assert.equal(result.id, 'shark');
  });

  test('The Shark fires for even the lowest-scoring Flush (compared by category, not raw score)', () => {
    // Rank-scaled: a low Flush scores less than scoreForHandId('FLUSH')
    // itself, but it's still a Flush and should still qualify.
    const result = classifyPersonality(
      ctx({ meters: { skill: 95, risk: 20, luck: 50 }, finalHandResult: { id: 'FLUSH', score: 36582 } }),
    );
    assert.equal(result.id, 'shark');
  });

  test('The Statistician: matched the EV-optimal discard', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        skillBonuses: { perfectKeep: 0, longShot: 0, cleanFinish: 0, optimalDiscard: 200 },
        meters: { skill: 60, risk: 20, luck: 50 },
      }),
    );
    assert.equal(result.id, 'statistician');
  });

  test('The Statistician does NOT fire when the perfect discard still whiffed to 0 points (regression: reported bug)', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        skillBonuses: { perfectKeep: 0, longShot: 0, cleanFinish: 0, optimalDiscard: 200 },
        meters: { skill: 60, risk: 20, luck: 10 },
        finalHandResult: { id: 'HIGH_CARD', score: 0 },
      }),
    );
    assert.notEqual(result.id, 'statistician');
  });

  test('The Statistician does NOT fire for a merely decent (not optimal) discard (regression: owner bug report — "i just got a decision rating of 27% and still got it")', () => {
    // 150/200 is a solidly above-average choice, but not the literal best
    // one available that day — old threshold (>= 35, 17.5% of max) let picks
    // far worse than this through; the fix requires near-literally the max.
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        skillBonuses: { perfectKeep: 0, longShot: 0, cleanFinish: 0, optimalDiscard: 150 },
        meters: { skill: 60, risk: 20, luck: 50 },
      }),
    );
    assert.notEqual(result.id, 'statistician');
  });

  test('The Maniac: max discards, and it paid off big', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 3,
        maxDiscards: 3,
        skillBonuses: { perfectKeep: 0, longShot: 15, cleanFinish: 0, optimalDiscard: 10 },
        meters: { skill: 60, risk: 80, luck: 50 },
        finalHandResult: { id: 'THREE_OF_A_KIND', score: 180 },
      }),
    );
    assert.equal(result.id, 'maniac');
  });

  test('The Dreamer: chased hard, ended up no better off', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 2,
        originalHandResult: { id: 'PAIR', score: 40 },
        finalHandResult: { id: 'HIGH_CARD', score: 0 },
        meters: { skill: 40, risk: 50, luck: 30 },
      }),
    );
    assert.equal(result.id, 'dreamer');
  });

  test('The Gambler: high risk, none of the sharper patterns matched', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        meters: { skill: 50, risk: 70, luck: 50 },
        originalHandResult: { id: 'HIGH_CARD', score: 0 },
        finalHandResult: { id: 'PAIR', score: 40 },
      }),
    );
    assert.equal(result.id, 'gambler');
  });

  test('The Optimist: held a High Card opener on faith', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 0,
        originalHandResult: { id: 'HIGH_CARD', score: 0 },
        finalHandResult: { id: 'PAIR', score: 40 },
        meters: { skill: 50, risk: 0, luck: 50 },
      }),
    );
    assert.equal(result.id, 'optimist');
  });

  test('The Hoarder: held pat with a non-trivial opener', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 0,
        originalHandResult: { id: 'PAIR', score: 40 },
        finalHandResult: { id: 'PAIR', score: 40 },
        meters: { skill: 50, risk: 0, luck: 50 },
      }),
    );
    assert.equal(result.id, 'hoarder');
  });

  test('The Perfectionist: clean finish plus strong skill', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        skillBonuses: { perfectKeep: 0, longShot: 0, cleanFinish: 10, optimalDiscard: 20 },
        meters: { skill: 82, risk: 20, luck: 50 },
        finalHandResult: { id: 'STRAIGHT', score: 300 },
      }),
    );
    assert.equal(result.id, 'perfectionist');
  });

  test('The Wildcard: a pile of bonuses fired at once', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        originalHandResult: { id: 'HIGH_CARD', score: 0 },
        finalHandResult: { id: 'PAIR', score: 40 },
        extraBonuses: [{}, {}, {}, {}],
      }),
    );
    assert.equal(result.id, 'wildcard');
  });

  test('The Architect: solid skill, built something strong', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        originalHandResult: { id: 'HIGH_CARD', score: 0 },
        finalHandResult: { id: 'STRAIGHT', score: scoreForHandId('STRAIGHT') },
        meters: { skill: 78, risk: 20, luck: 50 },
      }),
    );
    assert.equal(result.id, 'architect');
  });

  test('The Ghost: a quiet High Card run, nothing else fired', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        originalHandResult: { id: 'HIGH_CARD', score: 0 },
        finalHandResult: { id: 'HIGH_CARD', score: 0 },
        extraBonuses: [],
      }),
    );
    assert.equal(result.id, 'ghost');
  });

  test('The Grinder: guaranteed fallback for an unremarkable run', () => {
    const result = classifyPersonality(
      ctx({
        discardedCount: 1,
        originalHandResult: { id: 'PAIR', score: 40 },
        finalHandResult: { id: 'TWO_PAIR', score: 100 },
      }),
    );
    assert.equal(result.id, 'grinder');
  });

  test('every archetype the owner explicitly asked for is present', () => {
    const ids = PERSONALITIES.map((p) => p.id);
    for (const expected of ['gambler', 'optimist', 'shark', 'grinder', 'hoarder', 'dreamer', 'statistician', 'maniac']) {
      assert.ok(ids.includes(expected), `missing "${expected}"`);
    }
  });

  test('Grinder is last and matches unconditionally (true fallback)', () => {
    const last = PERSONALITIES[PERSONALITIES.length - 1];
    assert.equal(last.id, 'grinder');
    assert.equal(last.matches(), true);
  });

  test('classifyPersonality never returns undefined', () => {
    // A deliberately bizarre context that shouldn't hit any specific rule.
    const result = classifyPersonality(
      ctx({ discardedCount: 1, originalHandResult: { id: 'TWO_PAIR', score: 100 }, finalHandResult: { id: 'TWO_PAIR', score: 100 } }),
    );
    assert.ok(result);
    assert.equal(typeof result.id, 'string');
  });
});
