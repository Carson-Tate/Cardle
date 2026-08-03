import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreBadges, badgeCardHtml, breakdownListHtml } from '../src/ui/score-breakdown.js';
import { scoreRun } from '../src/core/scoring.js';
import { dealHand, freshSeed } from '../src/core/deck.js';

// score-breakdown.js is pure string building over a stored result, which is the
// whole reason it could be lifted out of board.js — so it is testable in Node
// even though it is a UI module. Every other src/ui file needs a browser.

const c = (rank, suit, rarity = null, jokerTier = null) => ({ rank, suit, rarity, jokerTier });

// A stored `result` blob, the shape daily_plays.result actually holds — which
// is what all three callers (the live board, the already-played panel, and the
// hand modal) pass in.
function storedResult({ originalHand, discardIndices = [], finalHand }) {
  const score = scoreRun({
    originalHand,
    finalHand,
    discardedCount: discardIndices.length,
    discardIndices,
    maxDiscards: 3,
  });
  return { originalHand, discardIndices, finalHand, score };
}

const FULL_HOUSE = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(8, 'C'), c(8, 'S')];

describe('buildScoreBadges', () => {
  const result = storedResult({ originalHand: FULL_HOUSE, finalHand: FULL_HOUSE });

  test('always leads with the hand itself', () => {
    const badges = buildScoreBadges(result.score, result.finalHand, result.discardIndices);
    const hand = badges.find((b) => b.key === 'hand');
    assert.ok(hand);
    assert.equal(hand.label, 'Full House');
    assert.equal(hand.value, result.score.baseScore);
  });

  test('returns ASCENDING — the reveal order the animated path depends on', () => {
    const values = buildScoreBadges(result.score, result.finalHand, result.discardIndices).map((b) => b.value);
    assert.deepEqual(values, [...values].sort((a, b) => a - b));
  });

  test('every badge carries the description and proof the badge card renders', () => {
    for (const badge of buildScoreBadges(result.score, result.finalHand, result.discardIndices)) {
      assert.equal(typeof badge.label, 'string', badge.key);
      assert.equal(typeof badge.tag, 'string', badge.key);
      assert.ok(Array.isArray(badge.highlightIndices), `${badge.key} must name its proof cards`);
    }
  });
});

describe('breakdownListHtml', () => {
  const result = storedResult({ originalHand: FULL_HOUSE, finalHand: FULL_HOUSE });

  // The load-bearing assertion for the shared module: the static callers want
  // biggest-first, the animated one wants smallest-first, and the reverse lives
  // in exactly one place now. If it were dropped, the modal would silently show
  // the breakdown upside down — a bug with no error and no failing render.
  test('renders DESCENDING — biggest badge at the top', () => {
    const html = breakdownListHtml(result);
    const values = [...html.matchAll(/score-badge-value">([+-])([\d,]+)</g)].map(
      ([, sign, digits]) => Number(digits.replaceAll(',', '')) * (sign === '-' ? -1 : 1),
    );
    assert.ok(values.length > 1, 'expected several badges');
    assert.deepEqual(values, [...values].sort((a, b) => b - a));
  });

  test('renders one <li> per badge', () => {
    const badges = buildScoreBadges(result.score, result.finalHand, result.discardIndices);
    const items = breakdownListHtml(result).match(/<li class="score-badge">/g) ?? [];
    assert.equal(items.length, badges.length);
  });

  // These blobs come out of the database and now render on OTHER players' rows,
  // so one malformed historical row must lose its own breakdown rather than
  // throw and take down the board that lists it — the same guard the
  // leaderboard already puts around evaluateHand().
  test('a malformed result yields nothing instead of throwing', () => {
    for (const bad of [null, undefined, {}, { score: null }, { score: {} }, { score: { handResult: {} } }]) {
      assert.doesNotThrow(() => breakdownListHtml(bad), `threw on ${JSON.stringify(bad)}`);
    }
    assert.equal(breakdownListHtml(null), '');
    assert.equal(breakdownListHtml({ score: {} }), '');
  });

  test('survives every seed the game can actually deal', () => {
    for (let i = 0; i < 200; i++) {
      const { hand, drawPile } = dealHand(freshSeed());
      const discardIndices = [0, 1].slice(0, i % 3);
      const finalHand = hand.map((card, index) => {
        const position = discardIndices.indexOf(index);
        return position === -1 ? card : drawPile[position];
      });
      const html = breakdownListHtml(storedResult({ originalHand: hand, discardIndices, finalHand }));
      assert.ok(html.includes('score-breakdown'), 'expected a rendered list');
    }
  });
});

describe('badgeCardHtml escapes what it renders', () => {
  // Hand labels and bonus descriptions are code-authored today, but the word
  // bank became admin-editable once already (§11y) and these strings now render
  // inside OTHER players' browsers via the leaderboard modal. Escaping is
  // pinned rather than assumed.
  test('a hostile label cannot break out into markup', () => {
    const badge = {
      key: 'x',
      tag: 'HAND',
      emoji: null,
      label: '<img src=x onerror=alert(1)>',
      value: 10,
      description: '"><script>alert(1)</script>',
      highlightIndices: [],
    };
    const html = badgeCardHtml(badge, [], [], 10);
    assert.ok(!html.includes('<img'), 'label was not escaped');
    assert.ok(!html.includes('<script'), 'description was not escaped');
    assert.ok(html.includes('&lt;img'));
  });

  // Double or Nothing (§4e) is the one component that can subtract, so the sign
  // has to follow the value rather than always being "+".
  test('a negative value renders with a minus, not a plus', () => {
    const badge = { key: 'modifier', tag: 'MODIFIER', emoji: '💥', label: 'Busted', value: -500, description: '', highlightIndices: [] };
    assert.ok(badgeCardHtml(badge, [], [], -500).includes('>-500<'));
  });
});
