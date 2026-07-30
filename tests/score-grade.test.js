import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORE_GRADES,
  SCORE_GRADES_ASCENDING,
  gradeForScore,
  gradeRank,
  reachesGrade,
  gradeProgress,
} from '../src/core/score-grade.js';
import { scoreForHandId } from '../src/core/hand-evaluator.js';

// The ladder the owner specified, worst to best.
const EXPECTED_ORDER = ['busted', 'average', 'hot', 'blessed', 'highRoller', 'whale', 'casinoLegend', 'impossible', 'unknown'];
const EXPECTED_LABELS = ['Busted', 'Average', 'Hot', 'Blessed', 'High Roller', 'Whale', 'Casino Legend', 'Impossible', '???'];

describe('SCORE_GRADES', () => {
  test('is exactly the ladder that was asked for, in order', () => {
    assert.deepEqual(
      SCORE_GRADES_ASCENDING.map((g) => g.id),
      EXPECTED_ORDER,
    );
    assert.deepEqual(
      SCORE_GRADES_ASCENDING.map((g) => g.label),
      EXPECTED_LABELS,
    );
  });

  test('the exported list is best-first and the ascending one is its reverse', () => {
    assert.deepEqual(
      SCORE_GRADES.map((g) => g.id),
      [...EXPECTED_ORDER].reverse(),
    );
  });

  test('thresholds strictly descend best-to-worst', () => {
    for (let i = 1; i < SCORE_GRADES.length; i++) {
      assert.ok(SCORE_GRADES[i].min < SCORE_GRADES[i - 1].min, `${SCORE_GRADES[i].id} is out of order`);
    }
  });

  test('the floor is 0, so every run gets a grade', () => {
    assert.equal(SCORE_GRADES_ASCENDING[0].min, 0);
  });

  test('every grade has an id, label and emoji', () => {
    for (const grade of SCORE_GRADES) {
      assert.match(grade.id, /^[A-Za-z]+$/, `bad id: ${grade.id}`);
      assert.ok(grade.label.length > 0);
      assert.ok(grade.emoji.length > 0);
    }
  });

  test('ids and labels are both unique', () => {
    for (const key of ['id', 'label']) {
      const values = SCORE_GRADES.map((g) => g[key]);
      assert.equal(new Set(values).size, values.length, `duplicate ${key}`);
    }
  });
});

describe('gradeForScore', () => {
  test('a whiff is Busted', () => {
    assert.equal(gradeForScore(0).id, 'busted');
    assert.equal(gradeForScore(100).id, 'busted');
  });

  test('each threshold is inclusive, and one point below drops a tier', () => {
    for (let i = 0; i < SCORE_GRADES.length - 1; i++) {
      const grade = SCORE_GRADES[i];
      assert.equal(gradeForScore(grade.min).id, grade.id, `at exactly ${grade.min}`);
      assert.equal(gradeForScore(grade.min - 1).id, SCORE_GRADES[i + 1].id, `one below ${grade.min}`);
    }
  });

  test('grades are anchored to hand-rank values, not magic numbers', () => {
    assert.equal(gradeForScore(scoreForHandId('THREE_STRAIGHT')).id, 'average');
    assert.equal(gradeForScore(scoreForHandId('FOUR_STRAIGHT')).id, 'hot');
    assert.equal(gradeForScore(scoreForHandId('STRAIGHT')).id, 'blessed');
    assert.equal(gradeForScore(scoreForHandId('FULL_HOUSE')).id, 'highRoller');
    assert.equal(gradeForScore(scoreForHandId('FOUR_OF_A_KIND')).id, 'whale');
    assert.equal(gradeForScore(scoreForHandId('STRAIGHT_FLUSH')).id, 'casinoLegend');
    assert.equal(gradeForScore(scoreForHandId('ROYAL_FLUSH')).id, 'impossible');
  });

  // "???" must need more than the best possible hand on its own, or it would
  // just be a synonym for Impossible.
  test('??? needs more than a bare Royal Flush', () => {
    const royal = scoreForHandId('ROYAL_FLUSH');
    assert.equal(gradeForScore(royal).id, 'impossible', 'a plain Royal is Impossible, not ???');
    assert.equal(gradeForScore(royal * 4).id, 'unknown');
  });

  // ...but it must still be genuinely reachable: a Royal Flush with a rare card
  // in the winning combo, or on a Flush Frenzy day, multiplies well past it.
  test('??? is reachable with a Royal Flush plus a realistic multiplier', () => {
    const royal = scoreForHandId('ROYAL_FLUSH');
    assert.equal(gradeForScore(royal * 4).id, 'unknown', 'Flush Frenzy alone (x4) gets there');
    assert.equal(gradeForScore(Math.round(royal * 15)).id, 'unknown', 'a Diamond in the combo (x15) gets there');
  });

  test('never regresses as the score climbs', () => {
    let last = -1;
    for (const score of [0, 500, 613, 2726, 21600, 58700, 351000, 6.08e6, 5.48e7, 5e8]) {
      const rank = gradeRank(gradeForScore(score).id);
      assert.ok(rank >= last, `grade went backwards at ${score}`);
      last = rank;
    }
  });

  // These run over STORED results too, including rows written before this
  // existed — a bad value must degrade, not throw.
  test('tolerates non-finite, negative and missing input', () => {
    // Infinity is included deliberately: it isn't a reachable score, so it's
    // garbage input, and grading garbage as the FLOOR is the safe direction.
    // Treating it as the top tier would hand out the "???" achievement — and
    // therefore a badge and a title — off a corrupt row.
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, -5000, 'nonsense']) {
      assert.equal(gradeForScore(bad).id, 'busted', `gradeForScore(${String(bad)})`);
    }
  });
});

describe('gradeRank / reachesGrade', () => {
  test('rank runs 0..8 worst to best', () => {
    EXPECTED_ORDER.forEach((id, index) => assert.equal(gradeRank(id), index));
  });

  test('an unknown id ranks at the floor rather than throwing', () => {
    assert.equal(gradeRank('nonsense'), 0);
    assert.equal(gradeRank(undefined), 0);
  });

  test('reachesGrade is true for the grade hit and everything below it', () => {
    const total = scoreForHandId('FULL_HOUSE'); // High Roller
    assert.ok(reachesGrade(total, 'highRoller'));
    assert.ok(reachesGrade(total, 'blessed'));
    assert.ok(reachesGrade(total, 'average'));
    assert.ok(reachesGrade(total, 'busted'), 'the floor is always reached');
    assert.ok(!reachesGrade(total, 'whale'));
    assert.ok(!reachesGrade(total, 'unknown'));
  });
});

describe('gradeProgress', () => {
  test('reports the next grade and the gap to it', () => {
    const hot = SCORE_GRADES.find((g) => g.id === 'hot');
    const blessed = SCORE_GRADES.find((g) => g.id === 'blessed');
    const progress = gradeProgress(hot.min);
    assert.equal(progress.grade.id, 'hot');
    assert.equal(progress.next.id, 'blessed');
    assert.equal(progress.pointsToNext, blessed.min - hot.min);
  });

  test('the top grade has no next', () => {
    const progress = gradeProgress(scoreForHandId('ROYAL_FLUSH') * 10);
    assert.equal(progress.grade.id, 'unknown');
    assert.equal(progress.next, null);
    assert.equal(progress.pointsToNext, null);
  });

  test('pointsToNext is never negative', () => {
    for (const score of [0, 1, 612, 613, 350999, 351000, 6.08e7]) {
      const { pointsToNext } = gradeProgress(score);
      if (pointsToNext !== null) assert.ok(pointsToNext >= 0, `negative gap at ${score}`);
    }
  });

  test('tolerates junk input', () => {
    for (const bad of [undefined, NaN, -1]) {
      assert.equal(gradeProgress(bad).grade.id, 'busted');
    }
  });
});
