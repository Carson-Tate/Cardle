import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAchievements, ACHIEVEMENTS } from '../src/core/achievements.js';
import { HAND_RANKS, scoreForHandId } from '../src/core/hand-evaluator.js';
import { PERSONALITIES } from '../src/core/personality.js';

function ctx(overrides = {}) {
  return {
    score: {
      handResult: { id: 'PAIR', score: 40 },
      baseScore: 40,
      total: 60,
      extraBonuses: [],
    },
    decisionRating: 0.8,
    discardedCount: 1,
    maxDiscards: 3,
    stats: {
      gamesPlayed: 1,
      bestScore: 60,
      handsSeen: ['PAIR'],
      personalitiesSeen: ['grinder'],
      achievementsUnlocked: [],
    },
    ...overrides,
  };
}

function idsOf(context) {
  return evaluateAchievements(context).map((a) => a.id);
}

describe('single-run achievements', () => {
  test('royalFlushClub', () => {
    assert.ok(idsOf(ctx({ score: { ...ctx().score, handResult: { id: 'ROYAL_FLUSH', score: scoreForHandId('ROYAL_FLUSH') } } })).includes('royalFlushClub'));
  });

  test('straightFlush', () => {
    assert.ok(idsOf(ctx({ score: { ...ctx().score, handResult: { id: 'STRAIGHT_FLUSH', score: scoreForHandId('STRAIGHT_FLUSH') } } })).includes('straightFlush'));
  });

  test('quadSquad', () => {
    assert.ok(idsOf(ctx({ score: { ...ctx().score, handResult: { id: 'FOUR_OF_A_KIND', score: scoreForHandId('FOUR_OF_A_KIND') } } })).includes('quadSquad'));
  });

  test('highRoller fires at Full House+, not below', () => {
    const threshold = scoreForHandId('FULL_HOUSE');
    assert.ok(idsOf(ctx({ score: { ...ctx().score, total: threshold } })).includes('highRoller'));
    assert.ok(!idsOf(ctx({ score: { ...ctx().score, total: threshold - 1 } })).includes('highRoller'));
  });

  test('flawless requires a finite 100%+ decision rating', () => {
    assert.ok(idsOf(ctx({ decisionRating: 1 })).includes('flawless'));
    assert.ok(!idsOf(ctx({ decisionRating: 0.99 })).includes('flawless'));
    assert.ok(!idsOf(ctx({ decisionRating: Infinity })).includes('flawless'));
  });

  test('zenMaster requires holding pat AND Full House+ (compared by category, not raw score — a low-rank Full House still counts)', () => {
    const fullHouse = { id: 'FULL_HOUSE', score: 52382 }; // lowest-scoring possible Full House (trip 2s, pair 3s)
    assert.ok(
      idsOf(ctx({ discardedCount: 0, score: { ...ctx().score, handResult: fullHouse } })).includes('zenMaster'),
    );
    assert.ok(
      !idsOf(ctx({ discardedCount: 1, score: { ...ctx().score, handResult: fullHouse } })).includes('zenMaster'),
    );
    assert.ok(
      !idsOf(ctx({ discardedCount: 0, score: { ...ctx().score, handResult: { id: 'FLUSH', score: 49218 } } })).includes(
        'zenMaster',
      ),
    );
  });

  test('fullSendClub requires max discards AND Straight+ (compared by category, not raw score — a low-rank Straight still counts)', () => {
    const straight = { id: 'STRAIGHT', score: 18081 }; // lowest-scoring possible Straight (wheel, A-2-3-4-5)
    assert.ok(
      idsOf(ctx({ discardedCount: 3, maxDiscards: 3, score: { ...ctx().score, handResult: straight } })).includes(
        'fullSendClub',
      ),
    );
    assert.ok(
      !idsOf(ctx({ discardedCount: 0, maxDiscards: 3, score: { ...ctx().score, handResult: straight } })).includes(
        'fullSendClub',
      ),
    );
    assert.ok(
      !idsOf(
        ctx({ discardedCount: 3, maxDiscards: 3, score: { ...ctx().score, handResult: { id: 'THREE_OF_A_KIND', score: 4888 } } }),
      ).includes('fullSendClub'),
    );
  });

  test('jackpotRun requires 5+ extra bonuses', () => {
    const many = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    assert.ok(idsOf(ctx({ score: { ...ctx().score, extraBonuses: many } })).includes('jackpotRun'));
    assert.ok(!idsOf(ctx({ score: { ...ctx().score, extraBonuses: many.slice(0, 4) } })).includes('jackpotRun'));
  });

  test('centuryBonus requires Two-Pair-worth-of-points+ beyond the base hand score', () => {
    const threshold = scoreForHandId('TWO_PAIR');
    assert.ok(idsOf(ctx({ score: { ...ctx().score, baseScore: 200, total: 200 + threshold } })).includes('centuryBonus'));
    assert.ok(!idsOf(ctx({ score: { ...ctx().score, baseScore: 200, total: 200 + threshold - 1 } })).includes('centuryBonus'));
  });

  test('buildingBlocks fires for a Three/Four Straight extra bonus (hiding inside a stronger hand)', () => {
    assert.ok(idsOf(ctx({ score: { ...ctx().score, extraBonuses: [{ id: 'fourStraight' }] } })).includes('buildingBlocks'));
    assert.ok(idsOf(ctx({ score: { ...ctx().score, extraBonuses: [{ id: 'threeStraight' }] } })).includes('buildingBlocks'));
    assert.ok(!idsOf(ctx({ score: { ...ctx().score, extraBonuses: [{ id: 'rainbow' }] } })).includes('buildingBlocks'));
  });

  test('buildingBlocks also fires when Three/Four Straight IS the hand itself', () => {
    assert.ok(
      idsOf(ctx({ score: { ...ctx().score, handResult: { id: 'THREE_STRAIGHT', score: 613 } } })).includes(
        'buildingBlocks',
      ),
    );
    assert.ok(
      idsOf(ctx({ score: { ...ctx().score, handResult: { id: 'FOUR_STRAIGHT', score: 2726 } } })).includes(
        'buildingBlocks',
      ),
    );
  });

  test('monochromeMaster fires only for the monochrome bonus', () => {
    assert.ok(idsOf(ctx({ score: { ...ctx().score, extraBonuses: [{ id: 'monochrome' }] } })).includes('monochromeMaster'));
    assert.ok(!idsOf(ctx({ score: { ...ctx().score, extraBonuses: [] } })).includes('monochromeMaster'));
  });
});

describe('cumulative achievements', () => {
  test('firstSteps, dedicated, veteran scale with games played', () => {
    assert.ok(idsOf(ctx({ stats: { ...ctx().stats, gamesPlayed: 1 } })).includes('firstSteps'));
    assert.ok(!idsOf(ctx({ stats: { ...ctx().stats, gamesPlayed: 1 } })).includes('dedicated'));
    assert.ok(idsOf(ctx({ stats: { ...ctx().stats, gamesPlayed: 7 } })).includes('dedicated'));
    assert.ok(!idsOf(ctx({ stats: { ...ctx().stats, gamesPlayed: 7 } })).includes('veteran'));
    assert.ok(idsOf(ctx({ stats: { ...ctx().stats, gamesPlayed: 30 } })).includes('veteran'));
  });

  test('collector requires every poker hand category', () => {
    const allHands = HAND_RANKS.map((r) => r.id);
    assert.ok(idsOf(ctx({ stats: { ...ctx().stats, handsSeen: allHands } })).includes('collector'));
    assert.ok(!idsOf(ctx({ stats: { ...ctx().stats, handsSeen: allHands.slice(0, -1) } })).includes('collector'));
  });

  test('multiplePersonalities and personalityCollector scale with distinct personalities seen', () => {
    const fivePersonalities = ['shark', 'gambler', 'hoarder', 'optimist', 'dreamer'];
    assert.ok(idsOf(ctx({ stats: { ...ctx().stats, personalitiesSeen: fivePersonalities } })).includes('multiplePersonalities'));
    assert.ok(!idsOf(ctx({ stats: { ...ctx().stats, personalitiesSeen: fivePersonalities } })).includes('personalityCollector'));

    const allPersonalities = PERSONALITIES.map((p) => p.id);
    assert.ok(idsOf(ctx({ stats: { ...ctx().stats, personalitiesSeen: allPersonalities } })).includes('personalityCollector'));
  });

  test('newPersonalBest requires more than one game played, and excludes a trivial first-game "best"', () => {
    assert.ok(
      idsOf(ctx({ score: { ...ctx().score, total: 200 }, stats: { ...ctx().stats, gamesPlayed: 2, bestScore: 200 } })).includes(
        'newPersonalBest',
      ),
    );
    assert.ok(
      !idsOf(ctx({ score: { ...ctx().score, total: 200 }, stats: { ...ctx().stats, gamesPlayed: 1, bestScore: 200 } })).includes(
        'newPersonalBest',
      ),
    );
  });
});

describe('evaluateAchievements', () => {
  test('returns only satisfied achievements, in registry order', () => {
    // baseScore kept close to total so centuryBonus's "Two-Pair-worth+ from
    // bonuses alone" doesn't also fire — isolating this to just highRoller +
    // firstSteps among the NON-grade achievements.
    const highRollerThreshold = scoreForHandId('FULL_HOUSE');
    const context = ctx({
      score: { ...ctx().score, baseScore: highRollerThreshold, total: highRollerThreshold + 200 },
      stats: { ...ctx().stats, gamesPlayed: 1 },
    });
    // Score-grade achievements (§11k) fire off the same total and are asserted
    // separately below, so they're excluded here to keep this focused on what it
    // was written to check: the non-grade set, in registry order.
    const ids = idsOf(context).filter((id) => !id.startsWith('grade_'));
    assert.deepEqual(ids, ['highRoller', 'firstSteps']);
  });

  // Score grades (§11k, DESIGN.md): one achievement per grade, "or better" for
  // every tier except the floor.
  test('a run unlocks its grade achievement and every grade below it', () => {
    const context = ctx({ score: { ...ctx().score, total: scoreForHandId('FULL_HOUSE') } });
    const ids = idsOf(context).filter((id) => id.startsWith('grade_'));
    assert.ok(ids.includes('grade_highRoller'), 'the grade actually reached');
    assert.ok(ids.includes('grade_blessed') && ids.includes('grade_hot') && ids.includes('grade_average'), 'and every tier below');
    assert.ok(!ids.includes('grade_whale'), 'but nothing above');
    assert.ok(!ids.includes('grade_busted'), 'and not the floor, which is exact-match only');
  });

  test('the floor grade is exact-match, so a good run does not also earn it', () => {
    const busted = idsOf(ctx({ score: { ...ctx().score, total: 0 } })).filter((id) => id.startsWith('grade_'));
    assert.deepEqual(busted, ['grade_busted'], 'a whiff earns exactly the wooden spoon');
    const good = idsOf(ctx({ score: { ...ctx().score, total: scoreForHandId('STRAIGHT') } }));
    assert.ok(!good.includes('grade_busted'));
  });

  test('every achievement id is unique', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
