import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SCORE_GRADES, gradeForScore, gradeProgress } from '../src/core/score-grade.js';
import { scoreForHandId } from '../src/core/hand-evaluator.js';

describe('SCORE_GRADES', () => {
  test('is ordered best-first with strictly descending thresholds', () => {
    for (let i = 1; i < SCORE_GRADES.length; i++) {
      assert.ok(SCORE_GRADES[i].min < SCORE_GRADES[i - 1].min, `${SCORE_GRADES[i].id} is out of order`);
    }
  });

  test('the lowest grade has a floor of 0, so every run gets one', () => {
    assert.equal(SCORE_GRADES[SCORE_GRADES.length - 1].min, 0);
  });

  test('every grade has an id, label and emoji', () => {
    for (const grade of SCORE_GRADES) {
      assert.match(grade.id, /^[a-z]+$/);
      assert.ok(grade.label.length > 0);
      assert.ok(grade.emoji.length > 0);
    }
  });

  test('ids are unique', () => {
    const ids = SCORE_GRADES.map((g) => g.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('gradeForScore', () => {
  test('a zero or tiny score is Common', () => {
    assert.equal(gradeForScore(0).id, 'common');
    assert.equal(gradeForScore(100).id, 'common');
  });

  test('each threshold is inclusive, and one point below falls to the tier down', () => {
    for (let i = 0; i < SCORE_GRADES.length - 1; i++) {
      const grade = SCORE_GRADES[i];
      assert.equal(gradeForScore(grade.min).id, grade.id, `at exactly ${grade.min}`);
      assert.equal(gradeForScore(grade.min - 1).id, SCORE_GRADES[i + 1].id, `one below ${grade.min}`);
    }
  });

  test('grades are anchored to hand-rank values, not magic numbers', () => {
    assert.equal(gradeForScore(scoreForHandId('TWO_PAIR')).id, 'uncommon');
    assert.equal(gradeForScore(scoreForHandId('THREE_OF_A_KIND')).id, 'rare');
    assert.equal(gradeForScore(scoreForHandId('STRAIGHT')).id, 'epic');
    assert.equal(gradeForScore(scoreForHandId('FULL_HOUSE')).id, 'legendary');
    assert.equal(gradeForScore(scoreForHandId('FOUR_OF_A_KIND')).id, 'mythic');
  });

  test('a Royal Flush score lands at the top grade', () => {
    assert.equal(gradeForScore(scoreForHandId('ROYAL_FLUSH')).id, 'mythic');
  });

  test('never regresses as the score climbs', () => {
    let lastIndex = SCORE_GRADES.length;
    for (const score of [0, 500, 1780, 4000, 20000, 21600, 58700, 351000, 5e6, 5.48e7]) {
      const index = SCORE_GRADES.findIndex((g) => g.id === gradeForScore(score).id);
      assert.ok(index <= lastIndex, `grade went backwards at ${score}`);
      lastIndex = index;
    }
  });

  // These run over STORED results too (the profile history), including rows
  // written before this module existed — a bad value must degrade, not throw.
  test('tolerates non-finite, negative and missing input', () => {
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, -5000, 'nonsense']) {
      assert.equal(gradeForScore(bad).id, 'common', `gradeForScore(${String(bad)})`);
    }
  });
});

describe('gradeProgress', () => {
  test('reports the next grade and the gap to it', () => {
    const uncommon = SCORE_GRADES.find((g) => g.id === 'uncommon');
    const rare = SCORE_GRADES.find((g) => g.id === 'rare');
    const progress = gradeProgress(uncommon.min);
    assert.equal(progress.grade.id, 'uncommon');
    assert.equal(progress.next.id, 'rare');
    assert.equal(progress.pointsToNext, rare.min - uncommon.min);
  });

  test('the top grade has no next', () => {
    const progress = gradeProgress(scoreForHandId('ROYAL_FLUSH'));
    assert.equal(progress.grade.id, 'mythic');
    assert.equal(progress.next, null);
    assert.equal(progress.pointsToNext, null);
  });

  test('pointsToNext is never negative', () => {
    for (const score of [0, 1, 1779, 1780, 350999, 351000]) {
      const { pointsToNext } = gradeProgress(score);
      if (pointsToNext !== null) assert.ok(pointsToNext >= 0, `negative gap at ${score}`);
    }
  });

  test('tolerates junk input', () => {
    for (const bad of [undefined, NaN, -1]) {
      assert.equal(gradeProgress(bad).grade.id, 'common');
    }
  });
});
