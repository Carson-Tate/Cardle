import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeStanding, MIN_STANDING_FIELD } from '../src/core/standing.js';

const at = (rank, total) => describeStanding({ rank, total });

describe('describeStanding', () => {
  test('the best run in the field is TOP 1%', () => {
    assert.equal(at(1, 100).label, 'TOP 1%');
    assert.equal(at(1, 100).side, 'top');
    assert.equal(at(1, 100).tier, 'elite');
  });

  test('the worst run in the field is BOTTOM 1%', () => {
    assert.equal(at(100, 100).label, 'BOTTOM 1%');
    assert.equal(at(100, 100).side, 'bottom');
    assert.equal(at(100, 100).tier, 'poor');
  });

  test('the halfway point stays on the TOP side', () => {
    assert.equal(at(50, 100).label, 'TOP 50%');
    assert.equal(at(51, 100).side, 'bottom');
  });

  // "TOP 90%" is a euphemism; nobody reads it as bad news.
  test('the worse half is phrased from the bottom, not as a large TOP number', () => {
    for (let rank = 51; rank <= 100; rank++) {
      const s = at(rank, 100);
      assert.equal(s.side, 'bottom', `rank ${rank}`);
      assert.ok(s.percent <= 50, `rank ${rank} reported BOTTOM ${s.percent}%`);
    }
  });

  test('a better rank is never described as worse than a poorer one', () => {
    // Compare on percentile-from-top, which is what the tier is keyed on.
    const order = ['elite', 'strong', 'middling', 'weak', 'poor'];
    let lastTier = 0;
    for (let rank = 1; rank <= 100; rank++) {
      const index = order.indexOf(at(rank, 100).tier);
      assert.ok(index >= lastTier, `tier went backwards at rank ${rank}`);
      lastTier = index;
    }
  });

  // Percentages of a tiny field are noise: first of three is "TOP 33%", and the
  // same run reads differently an hour later purely because more people showed up.
  test('says nothing at all until the field is big enough to mean something', () => {
    for (let total = 0; total < MIN_STANDING_FIELD; total++) {
      assert.equal(at(1, total), null, `field of ${total}`);
    }
    assert.ok(at(1, MIN_STANDING_FIELD) !== null);
  });

  test('rejects impossible placings rather than rendering nonsense', () => {
    assert.equal(at(0, 10), null);
    assert.equal(at(11, 10), null);
    assert.equal(at(-1, 10), null);
    assert.equal(describeStanding(null), null);
    assert.equal(describeStanding({}), null);
    assert.equal(describeStanding({ rank: 1.5, total: 10 }), null);
    assert.equal(describeStanding({ rank: '1', total: 'lots' }), null);
  });

  test('percent is always a whole number between 1 and 100', () => {
    for (let total = MIN_STANDING_FIELD; total <= 60; total++) {
      for (let rank = 1; rank <= total; rank++) {
        const s = at(rank, total);
        assert.ok(Number.isInteger(s.percent), `rank ${rank}/${total}`);
        assert.ok(s.percent >= 1 && s.percent <= 100, `rank ${rank}/${total} gave ${s.percent}`);
      }
    }
  });

  test('carries the raw placing through, so a caller can show "3rd of 40" if it wants', () => {
    const s = at(3, 40);
    assert.equal(s.rank, 3);
    assert.equal(s.total, 40);
  });
});
