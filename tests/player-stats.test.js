import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { derivePlayerStats, splitAchievements } from '../src/core/player-stats.js';
import { ACHIEVEMENTS } from '../src/core/achievements.js';
import { HAND_RANKS } from '../src/core/hand-evaluator.js';
import { PERSONALITIES } from '../src/core/personality.js';
import { xpForRun } from '../src/core/progression.js';

// A stored run result, shaped exactly like the object board.js's lockIn()
// persists to daily_plays.result.
function entry(playDate, overrides = {}) {
  const { handId = 'PAIR', total = 500, personalityId = 'grinder', ...rest } = overrides;
  return {
    playDate,
    result: {
      dayNumber: 1,
      originalHand: [],
      discardIndices: [],
      finalHand: [],
      score: {
        handResult: { id: handId, label: handId },
        total,
        extraBonuses: [],
        rarity: { items: [] },
      },
      decisionRating: 0.5,
      personalityId,
      newlyUnlocked: [],
      ...rest,
    },
  };
}

describe('derivePlayerStats', () => {
  test('an empty history produces a valid zeroed profile, not NaN or a crash', () => {
    const s = derivePlayerStats([]);
    assert.equal(s.gamesPlayed, 0);
    assert.equal(s.totalPoints, 0);
    assert.equal(s.bestScore, 0);
    assert.equal(s.averageScore, 0);
    assert.equal(s.averageDecisionRating, null);
    assert.equal(s.bestHandId, null);
    assert.equal(s.currentStreak, 0);
    assert.equal(s.longestStreak, 0);
    assert.equal(s.level, 1);
    assert.deepEqual(s.handsSeen, []);
  });

  test('tolerates a null/garbage history argument', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      assert.equal(derivePlayerStats(bad).gamesPlayed, 0);
    }
  });

  test('skips rows with no usable result rather than counting them', () => {
    const s = derivePlayerStats([
      entry('2026-07-01'),
      { playDate: '2026-07-02', result: null },
      { playDate: '2026-07-03' },
      null,
    ]);
    assert.equal(s.gamesPlayed, 1);
  });

  test('totals, best score, and average', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { total: 100 }),
      entry('2026-07-02', { total: 900 }),
      entry('2026-07-03', { total: 500 }),
    ]);
    assert.equal(s.gamesPlayed, 3);
    assert.equal(s.totalPoints, 1500);
    assert.equal(s.bestScore, 900);
    assert.equal(s.averageScore, 500);
    assert.equal(s.bestRun.score.total, 900);
  });

  // "Highest hand" means the best poker CATEGORY, not the biggest score —
  // rank-scaling plus bonuses means a Pair can out-SCORE a Straight.
  test('highest hand is the best category, even when a weaker hand scored more', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { handId: 'PAIR', total: 999_999 }),
      entry('2026-07-02', { handId: 'STRAIGHT', total: 10 }),
    ]);
    assert.equal(s.bestHandId, 'STRAIGHT');
    assert.equal(s.bestScore, 999_999, 'best SCORE is still tracked separately');
  });

  test('ties on category are broken by the higher-scoring example', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { handId: 'FLUSH', total: 4000 }),
      entry('2026-07-02', { handId: 'FLUSH', total: 9000 }),
    ]);
    assert.equal(s.bestHandId, 'FLUSH');
    assert.equal(s.bestHandScore, 9000);
  });

  test('collects distinct hand categories and personalities', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { handId: 'PAIR', personalityId: 'shark' }),
      entry('2026-07-02', { handId: 'PAIR', personalityId: 'ghost' }),
      entry('2026-07-03', { handId: 'FLUSH', personalityId: 'shark' }),
    ]);
    assert.deepEqual(s.handsSeen.sort(), ['FLUSH', 'PAIR']);
    assert.deepEqual(s.personalitiesSeen.sort(), ['ghost', 'shark']);
    assert.equal(s.totalHandCategories, HAND_RANKS.length);
    assert.equal(s.totalPersonalities, PERSONALITIES.length);
    assert.equal(s.totalAchievements, ACHIEVEMENTS.length);
  });

  test('total XP is the sum of every run’s XP', () => {
    const entries = [entry('2026-07-01', { handId: 'PAIR' }), entry('2026-07-02', { handId: 'FLUSH' })];
    const expected = entries.reduce((sum, e) => sum + xpForRun(e.result), 0);
    assert.equal(derivePlayerStats(entries).totalXp, expected);
    assert.ok(derivePlayerStats(entries).level >= 1);
  });

  test('decision rating average and best ignore non-finite values', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { decisionRating: 0.2 }),
      entry('2026-07-02', { decisionRating: 0.8 }),
      entry('2026-07-03', { decisionRating: Infinity }),
    ]);
    assert.ok(Math.abs(s.averageDecisionRating - 0.5) < 1e-9);
    assert.equal(s.bestDecisionRating, 0.8);
  });

  test('counts rare cards kept across runs', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { score: { handResult: { id: 'PAIR' }, total: 1, extraBonuses: [], rarity: { items: [{}, {}] } } }),
      entry('2026-07-02', { score: { handResult: { id: 'PAIR' }, total: 1, extraBonuses: [], rarity: { items: [{}] } } }),
    ]);
    assert.equal(s.rareCardsKept, 3);
  });

  test('history order does not matter — entries are sorted internally', () => {
    const forwards = derivePlayerStats([entry('2026-07-01', { total: 10 }), entry('2026-07-02', { total: 20 })]);
    const backwards = derivePlayerStats([entry('2026-07-02', { total: 20 }), entry('2026-07-01', { total: 10 })]);
    assert.equal(forwards.firstPlayDate, '2026-07-01');
    assert.equal(backwards.firstPlayDate, '2026-07-01');
    assert.equal(forwards.lastPlayDate, backwards.lastPlayDate);
    assert.deepEqual(forwards.achievementsUnlocked.sort(), backwards.achievementsUnlocked.sort());
  });
});

describe('streaks', () => {
  const days = (...dates) => dates.map((d) => entry(d));

  test('consecutive days build a streak', () => {
    const s = derivePlayerStats(days('2026-07-01', '2026-07-02', '2026-07-03'), { today: '2026-07-03' });
    assert.equal(s.currentStreak, 3);
    assert.equal(s.longestStreak, 3);
  });

  test('a gap breaks the streak but the longest is remembered', () => {
    const s = derivePlayerStats(days('2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'), { today: '2026-07-06' });
    assert.equal(s.currentStreak, 1);
    assert.equal(s.longestStreak, 3);
  });

  test('a streak still counts when the last play was yesterday (today is not over yet)', () => {
    const s = derivePlayerStats(days('2026-07-01', '2026-07-02'), { today: '2026-07-03' });
    assert.equal(s.currentStreak, 2);
  });

  test('a lapsed streak reads as 0 rather than lingering', () => {
    const s = derivePlayerStats(days('2026-07-01', '2026-07-02'), { today: '2026-07-20' });
    assert.equal(s.currentStreak, 0);
    assert.equal(s.longestStreak, 2);
  });

  test('duplicate dates do not inflate a streak', () => {
    const s = derivePlayerStats(days('2026-07-01', '2026-07-01', '2026-07-02'), { today: '2026-07-02' });
    assert.equal(s.currentStreak, 2);
    assert.equal(s.longestStreak, 2);
  });

  test('handles a month boundary', () => {
    const s = derivePlayerStats(days('2026-07-30', '2026-07-31', '2026-08-01'), { today: '2026-08-01' });
    assert.equal(s.currentStreak, 3);
  });

  test('ignores unparseable play dates instead of throwing', () => {
    const s = derivePlayerStats([entry('not-a-date'), entry('2026-07-02')], { today: '2026-07-02' });
    assert.equal(s.currentStreak, 1);
  });
});

describe('achievements', () => {
  test('unlocks cumulative achievements by replaying history in order', () => {
    // firstSteps needs gamesPlayed >= 1; dedicated needs 7.
    const seven = Array.from({ length: 7 }, (_, i) => entry(`2026-07-0${i + 1}`));
    const s = derivePlayerStats(seven, { today: '2026-07-07' });
    assert.ok(s.achievementsUnlocked.includes('firstSteps'));
    assert.ok(s.achievementsUnlocked.includes('dedicated'));
    assert.ok(!s.achievementsUnlocked.includes('veteran'), '30 games not reached');
  });

  test('honours achievements recorded at the time, even if a rule no longer matches', () => {
    const s = derivePlayerStats([entry('2026-07-01', { newlyUnlocked: ['someRetiredAchievement'] })]);
    assert.ok(s.achievementsUnlocked.includes('someRetiredAchievement'));
  });

  test('unlocks a per-run achievement from the run that earned it', () => {
    const s = derivePlayerStats([entry('2026-07-01', { handId: 'ROYAL_FLUSH', total: 54_800_000 })]);
    assert.ok(s.achievementsUnlocked.includes('royalFlushClub'));
  });

  test('splitAchievements marks earned vs unearned and preserves registry order', () => {
    const split = splitAchievements(['firstSteps']);
    assert.equal(split.length, ACHIEVEMENTS.length);
    assert.deepEqual(
      split.map((a) => a.id),
      ACHIEVEMENTS.map((a) => a.id),
    );
    assert.equal(split.find((a) => a.id === 'firstSteps').unlocked, true);
    assert.ok(split.some((a) => a.unlocked === false));
  });

  test('splitAchievements tolerates no argument', () => {
    assert.ok(splitAchievements().every((a) => a.unlocked === false));
  });
});

// bestRunDate exists so the profile's clickable Best Hand plaque (§11ab) can
// label its modal without matching the result object back against `history` by
// reference. The failure it guards against is the assignment drifting outside
// the `if`, which would leave it tracking the LATEST run instead of the best —
// a bug that is invisible whenever the best run happens to be the most recent.
describe('bestRunDate', () => {
  test('names the day of the highest-scoring run, not the latest one', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { total: 100 }),
      entry('2026-07-02', { total: 9000 }),
      entry('2026-07-03', { total: 250 }),
    ]);
    assert.equal(s.bestScore, 9000);
    assert.equal(s.bestRunDate, '2026-07-02');
    assert.equal(s.bestRun.score.total, 9000);
  });

  test('is null when there is no history to have a best run in', () => {
    assert.equal(derivePlayerStats([]).bestRunDate, null);
  });

  test('stays with the first run to reach the top score, matching bestRun', () => {
    const s = derivePlayerStats([
      entry('2026-07-01', { total: 500 }),
      entry('2026-07-02', { total: 500 }),
    ]);
    // `>` not `>=`, so a later tie does not steal the title — and the date must
    // agree with whichever run bestRun actually kept.
    assert.equal(s.bestRunDate, '2026-07-01');
  });
});
