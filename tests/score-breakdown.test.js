import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreBadges, badgeCardHtml, breakdownListHtml } from '../src/ui/score-breakdown.js';
import { scoreRun } from '../src/core/scoring.js';
import { dealHand, freshSeed, rankLabel, suitGlyph } from '../src/core/deck.js';

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

// A WILD IS NAMED BY THE CARD IT PLAYED AS, NEVER BY ITS OWN DEALT ONE.
//
// Owner bug report, with a screenshot: "it says the wild counted as a 4 in the
// breakdown but was actually a 5 in his hand." The badge read "Wild 4♣" — the
// wild's own dealt rank and suit, which §3t established are meaningless
// leftover data from the shuffle — while the proof strip printed directly
// beneath that same badge read "🃏5♦", the card it actually played as.
//
// The cause was `item.rarity === 'joker'`, the LEGACY wild shape. §3x moved
// wildness onto the card as `wild: true`, so a modern wild missed that branch
// and fell through to the ordinary rare-card one, which appends the card's own
// rank and suit. miniCardStripHtml had already been caught by the identical
// check and fixed; this copy survived because a wild that prints no rank looks
// right either way.
describe('a wild badge names its substituted card, not its dealt one', () => {
  const wild = (rank, suit, rarity = null) => ({ rank, suit, rarity, jokerTier: null, wild: true });
  // The reported hand: dealt 2♥ 4♥ [wild printed as 4♣] Q♠ 3♥, threw the queen,
  // drew the 9♣. The wild plays as a 5 to complete 2-3-4-5.
  const original = [c(2, 'H'), c(4, 'H'), wild(4, 'C'), c(12, 'S'), c(3, 'H')];
  const finalHand = [c(2, 'H'), c(4, 'H'), wild(4, 'C'), c(9, 'C'), c(3, 'H')];
  const result = storedResult({ originalHand: original, discardIndices: [3], finalHand });
  const wildBadge = () =>
    buildScoreBadges(result.score, result.finalHand, result.discardIndices).find((b) => b.label.includes('Wild'));

  test('the hand really is a Four Straight built on the wild', () => {
    assert.equal(result.score.handResult.id, 'FOUR_STRAIGHT');
    assert.equal(result.score.logicalFinalHand[2].rank, 5, 'the wild should play as a 5');
  });

  test('does not name the wild by its dealt rank', () => {
    const badge = wildBadge();
    assert.ok(badge, 'a wild badge should exist');
    assert.ok(!badge.label.includes('4♣'), `badge named the dealt card: "${badge.label}"`);
  });

  // The defect stated directly: a badge and the proof strip under it are two
  // renderings of one card and must never disagree. This survives any future
  // change to which rank or suit the substitution search happens to pick,
  // which two hardcoded assertions would not.
  test('names the same card its own proof strip highlights', () => {
    const badge = wildBadge();
    const [index] = badge.highlightIndices;
    const shown = result.score.logicalFinalHand[index];
    assert.ok(
      badge.label.endsWith(`${rankLabel(shown.rank)}${suitGlyph(shown.suit)}`),
      `badge "${badge.label}" disagrees with its strip chip ${rankLabel(shown.rank)}${suitGlyph(shown.suit)}`,
    );
  });

  test('gets the wild description, not the generic rare-card one', () => {
    assert.match(wildBadge().description, /wild card/i);
  });

  test('an ordinary rare card is still named by the card it is', () => {
    const rare = [c(13, 'S', 'gold'), c(13, 'H'), c(13, 'D'), c(8, 'C'), c(8, 'S')];
    const res = storedResult({ originalHand: rare, finalHand: rare });
    const badge = buildScoreBadges(res.score, res.finalHand, res.discardIndices).find((b) => b.tag === 'GOLD');
    assert.ok(badge, 'a gold badge should exist');
    assert.ok(badge.label.endsWith('K♠'), `expected the card's own rank, got "${badge.label}"`);
  });

  test('a DISCARDED wild carries no rank at all — it never substituted for anything', () => {
    const dealt = [c(2, 'H'), c(4, 'H'), wild(4, 'C'), c(12, 'S'), c(3, 'H')];
    const kept = [c(2, 'H'), c(4, 'H'), c(7, 'D'), c(12, 'S'), c(3, 'H')];
    const res = storedResult({ originalHand: dealt, discardIndices: [2], finalHand: kept });
    const badge = buildScoreBadges(res.score, res.finalHand, res.discardIndices).find((b) => b.label.includes('Wild'));
    assert.ok(badge, 'a discarded-wild badge should exist');
    assert.equal(badge.label, 'Discarded Wild', `got "${badge.label}"`);
  });
});
