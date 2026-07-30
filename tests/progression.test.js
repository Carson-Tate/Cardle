import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  xpForRun,
  totalXpForLevel,
  levelForXp,
  levelProgress,
  XP_BASE_PER_RUN,
  XP_PER_HAND_STRENGTH,
  XP_PER_DECISION_RATING,
  XP_PER_BONUS,
  XP_PER_ACHIEVEMENT,
  XP_PER_LEVEL_STEP,
} from '../src/core/progression.js';
import { handStrengthIndex } from '../src/core/hand-evaluator.js';

const run = (overrides = {}) => ({
  score: { handResult: { id: 'HIGH_CARD' }, total: 0, extraBonuses: [] },
  decisionRating: 0,
  newlyUnlocked: [],
  ...overrides,
});

describe('xpForRun', () => {
  test('a minimal run still earns the base, so a bad day never stalls progression', () => {
    assert.equal(xpForRun(run()), XP_BASE_PER_RUN);
  });

  test('scales with hand category', () => {
    const pair = xpForRun(run({ score: { handResult: { id: 'PAIR' }, extraBonuses: [] } }));
    const royal = xpForRun(run({ score: { handResult: { id: 'ROYAL_FLUSH' }, extraBonuses: [] } }));
    assert.equal(pair, XP_BASE_PER_RUN + handStrengthIndex('PAIR') * XP_PER_HAND_STRENGTH);
    assert.equal(royal, XP_BASE_PER_RUN + handStrengthIndex('ROYAL_FLUSH') * XP_PER_HAND_STRENGTH);
    assert.ok(royal > pair);
  });

  // The whole reason XP isn't derived from points: a Royal Flush is worth
  // 274,000x a Pair in POINTS, but must not be worth anything like that in XP.
  test('the best hand is worth only a few times the worst in XP, not 274,000x', () => {
    const worst = xpForRun(run());
    const best = xpForRun(run({ score: { handResult: { id: 'ROYAL_FLUSH' }, extraBonuses: [] } }));
    assert.ok(best / worst < 5, `best/worst XP ratio was ${best / worst}, expected well under 5x`);
  });

  test('rewards Decision Rating, clamped at 1 so a lucky draw is not paid twice', () => {
    assert.equal(xpForRun(run({ decisionRating: 0.5 })), XP_BASE_PER_RUN + 0.5 * XP_PER_DECISION_RATING);
    const atOne = xpForRun(run({ decisionRating: 1 }));
    const wayOver = xpForRun(run({ decisionRating: 12 }));
    assert.equal(atOne, wayOver);
  });

  test('counts bonuses and newly-unlocked achievements', () => {
    const withBonuses = xpForRun(run({ score: { handResult: { id: 'HIGH_CARD' }, extraBonuses: [{}, {}, {}] } }));
    assert.equal(withBonuses, XP_BASE_PER_RUN + 3 * XP_PER_BONUS);
    const withAchievements = xpForRun(run({ newlyUnlocked: ['a', 'b'] }));
    assert.equal(withAchievements, XP_BASE_PER_RUN + 2 * XP_PER_ACHIEVEMENT);
  });

  // These run over STORED rows, including ones written before this module
  // existed. A missing or non-finite field must degrade, never throw — one bad
  // row would otherwise take out the entire profile page.
  test('tolerates missing, malformed, and non-finite fields', () => {
    assert.equal(xpForRun(undefined), 0);
    assert.equal(xpForRun(null), 0);
    assert.equal(xpForRun('nonsense'), 0);
    assert.equal(xpForRun({}), XP_BASE_PER_RUN);
    assert.equal(xpForRun({ score: {} }), XP_BASE_PER_RUN);
    assert.equal(xpForRun(run({ decisionRating: Infinity })), XP_BASE_PER_RUN);
    assert.equal(xpForRun(run({ decisionRating: NaN })), XP_BASE_PER_RUN);
    assert.equal(xpForRun(run({ decisionRating: -5 })), XP_BASE_PER_RUN);
  });

  test('is always a non-negative integer', () => {
    for (const r of [run(), run({ decisionRating: 0.333 }), run({ newlyUnlocked: ['x'] })]) {
      const xp = xpForRun(r);
      assert.ok(Number.isInteger(xp) && xp >= 0);
    }
  });
});

describe('level curve', () => {
  test('level 1 is the starting point and costs nothing', () => {
    assert.equal(totalXpForLevel(1), 0);
    assert.equal(levelForXp(0), 1);
  });

  test('each level costs progressively more than the last', () => {
    const bands = [2, 3, 4, 5, 6].map((l) => totalXpForLevel(l) - totalXpForLevel(l - 1));
    for (let i = 1; i < bands.length; i++) {
      assert.ok(bands[i] > bands[i - 1], `band ${i + 2} was not larger than the one before it`);
    }
    assert.equal(bands[0], XP_PER_LEVEL_STEP);
  });

  test('levelForXp is the exact inverse of totalXpForLevel at every boundary', () => {
    for (let level = 1; level <= 60; level++) {
      const needed = totalXpForLevel(level);
      assert.equal(levelForXp(needed), level, `at exactly the level-${level} threshold`);
      if (level > 1) {
        assert.equal(levelForXp(needed - 1), level - 1, `one XP short of level ${level}`);
      }
    }
  });

  test('never regresses as XP grows', () => {
    let last = 0;
    for (let xp = 0; xp <= 60_000; xp += 137) {
      const level = levelForXp(xp);
      assert.ok(level >= last);
      last = level;
    }
  });

  test('tolerates nonsense input rather than returning NaN', () => {
    for (const bad of [undefined, null, NaN, -1, -99999, 'abc']) {
      assert.equal(levelForXp(bad), 1, `levelForXp(${String(bad)})`);
    }
  });
});

describe('levelProgress', () => {
  test('reports position within the current level, not a cumulative total', () => {
    const atLevel3Start = totalXpForLevel(3);
    const p = levelProgress(atLevel3Start);
    assert.equal(p.level, 3);
    assert.equal(p.xpIntoLevel, 0);
    assert.equal(p.progress, 0);
    assert.equal(p.xpForNextLevel, totalXpForLevel(4) - totalXpForLevel(3));
  });

  test('progress reaches but never exceeds 1 within a level', () => {
    for (let xp = 0; xp <= 20_000; xp += 97) {
      const p = levelProgress(xp);
      assert.ok(p.progress >= 0 && p.progress <= 1, `progress ${p.progress} out of range at ${xp} xp`);
    }
  });

  test('halfway through a level reads as ~0.5', () => {
    const floorXp = totalXpForLevel(4);
    const band = totalXpForLevel(5) - floorXp;
    const p = levelProgress(floorXp + band / 2);
    assert.ok(Math.abs(p.progress - 0.5) < 1e-9);
  });

  // Roughly one run per day by design (§9.2), so the curve's pacing is
  // measured in days. Locks in the intent described in progression.js rather
  // than leaving it as a comment that could silently drift.
  test('pacing: a typical run levels you fast early and slowly later', () => {
    const typicalRun = xpForRun(run({ score: { handResult: { id: 'PAIR' }, extraBonuses: [{}, {}] }, decisionRating: 0.6 }));
    const runsToReach = (level) => Math.ceil(totalXpForLevel(level) / typicalRun);
    assert.ok(runsToReach(2) <= 2, `level 2 took ${runsToReach(2)} runs, expected to feel immediate`);
    assert.ok(runsToReach(10) > 20 && runsToReach(10) < 90, `level 10 took ${runsToReach(10)} runs`);
    assert.ok(runsToReach(20) > 120, `level 20 took ${runsToReach(20)} runs, expected a long-term goal`);
  });
});
