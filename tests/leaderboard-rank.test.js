import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { viewerPositionIn, ordinal, boardSummary } from '../src/core/leaderboard-rank.js';

const list = (n) => Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, value: 1000 - i }));

describe('viewerPositionIn', () => {
  test('returns nothing when the viewer is already on the visible page', () => {
    assert.equal(viewerPositionIn(list(80), 'u1', 50), null);
    // The boundary in the "shown" direction: index 49 is the 50th row.
    assert.equal(viewerPositionIn(list(80), 'u50', 50), null);
  });

  test('returns the position when the viewer falls just past the page', () => {
    const found = viewerPositionIn(list(80), 'u51', 50);
    assert.equal(found.position, 51);
    assert.equal(found.total, 80);
    assert.equal(found.row.userId, 'u51');
  });

  test('carries the whole row, so the trailing entry renders like any other', () => {
    assert.equal(viewerPositionIn(list(80), 'u64', 50).row.value, 1000 - 63);
  });

  // Absent is NOT position 0 and not "last". Friends filtering happens on a
  // fetched page, so a viewer missing from it means we genuinely do not know
  // their rank — and a made-up number is worse than no row at all.
  test('an absent viewer gets nothing rather than a guessed position', () => {
    assert.equal(viewerPositionIn(list(80), 'nobody', 50), null);
  });

  test('a signed-out viewer or a missing list is not an error', () => {
    assert.equal(viewerPositionIn(list(80), null, 50), null);
    assert.equal(viewerPositionIn(null, 'u1', 50), null);
    assert.equal(viewerPositionIn(undefined, 'u1', 50), null);
  });
});

describe('ordinal', () => {
  test('the ordinary endings', () => {
    assert.equal(ordinal(1), '1st');
    assert.equal(ordinal(2), '2nd');
    assert.equal(ordinal(3), '3rd');
    assert.equal(ordinal(4), '4th');
    assert.equal(ordinal(51), '51st');
    assert.equal(ordinal(143), '143rd');
  });

  // The whole reason this is a function: the teens break the last-digit rule,
  // and 111 breaks it a second time at a place a naive fix would miss.
  test('the teens are all th, at every hundred', () => {
    assert.equal(ordinal(11), '11th');
    assert.equal(ordinal(12), '12th');
    assert.equal(ordinal(13), '13th');
    assert.equal(ordinal(111), '111th');
    assert.equal(ordinal(112), '112th');
    assert.equal(ordinal(113), '113th');
  });

  test('21st and 101st still take the short ending', () => {
    assert.equal(ordinal(21), '21st');
    assert.equal(ordinal(101), '101st');
    assert.equal(ordinal(102), '102nd');
  });

  test('a large position is grouped for readability', () => {
    assert.equal(ordinal(1234), '1,234th');
  });

  test('nonsense in, empty string out', () => {
    assert.equal(ordinal(NaN), '');
    assert.equal(ordinal(undefined), '');
  });
});

describe('boardSummary', () => {
  test('a normal board counts down from the top', () => {
    assert.equal(boardSummary({ size: 50 }), 'Top 50');
  });

  // "Top 50" is false on an Upside Down day — these are the 50 LOWEST scores,
  // which is the entire point of that modifier.
  test('an ascending board says Bottom, because that is what it shows', () => {
    assert.equal(boardSummary({ size: 50, ascending: true }), 'Bottom 50');
  });

  test('the friends scope is named so the number is not read as global', () => {
    assert.equal(boardSummary({ size: 50, friendsOnly: true }), 'Top 50 among you and your friends');
    assert.equal(
      boardSummary({ size: 50, ascending: true, friendsOnly: true }),
      'Bottom 50 among you and your friends',
    );
  });
});
