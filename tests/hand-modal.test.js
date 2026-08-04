import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { drawHtml } from '../src/ui/hand-modal.js';
import { scoreRun } from '../src/core/scoring.js';
import { rankLabel } from '../src/core/deck.js';

// hand-modal.js only touches `document` inside openModal, so the string-building
// half imports and runs fine under plain Node — same arrangement as
// score-breakdown.js.

const c = (rank, suit, rarity = null) => ({ rank, suit, rarity, jokerTier: null });
const wild = (rank, suit, rarity = null) => ({ rank, suit, rarity, jokerTier: null, wild: true });

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

// Owner bug report: the modal's Dealt and Kept rows printed a wild's own dealt
// rank — "4♣" — for a card that played as a 5, while every proof strip further
// down the same modal showed "🃏5♦". §3t established that a wild's dealt
// rank/suit are meaningless leftovers of the shuffle; the board never shows
// them either, rendering a wild as a rankless jester.
describe('the Dealt/Kept rows never label a wild with its dealt rank', () => {
  const original = [c(2, 'H'), c(4, 'H'), wild(4, 'C'), c(12, 'S'), c(3, 'H')];
  const finalHand = [c(2, 'H'), c(4, 'H'), wild(4, 'C'), c(9, 'C'), c(3, 'H')];
  const result = storedResult({ originalHand: original, discardIndices: [3], finalHand });
  const html = () => drawHtml(result);

  test('the fixture really does play the wild as something other than its dealt rank', () => {
    assert.equal(result.score.logicalFinalHand[2].rank, 5);
    assert.notEqual(result.score.logicalFinalHand[2].rank, finalHand[2].rank);
  });

  test('the dealt rank never appears anywhere in the rows', () => {
    assert.ok(!html().includes('4♣'), 'the wild\'s meaningless dealt card leaked into the modal');
  });

  test('the Kept row names the card the wild actually played as', () => {
    const logical = result.score.logicalFinalHand[2];
    const suitChar = { S: '♠', H: '♥', D: '♦', C: '♣' }[logical.suit];
    // A wild-marked chip carrying the substituted rank AND suit — not merely
    // "a 5 appears somewhere in the markup", which the rest of the hand would
    // have satisfied on its own.
    assert.match(html(), new RegExp(`mini-card--wild[^>]*>${rankLabel(logical.rank)}\\${suitChar}<`));
  });

  test('the Dealt row shows a bare wild marker — it had not substituted yet', () => {
    // The dealt chip is wild-marked and carries no rank at all; `.mini-card--wild`
    // supplies the 🃏 itself.
    assert.match(html(), /mini-card--wild[^>]*><\/span>/);
  });

  test('ordinary cards are unaffected', () => {
    const out = html();
    for (const face of ['2♥', '4♥', '3♥', '9♣', 'Q♠']) {
      assert.ok(out.includes(face), `${face} should still render`);
    }
  });

  test('a hand with no wild renders every card normally', () => {
    const plain = [c(13, 'S'), c(13, 'H'), c(13, 'D'), c(8, 'C'), c(8, 'S')];
    const out = drawHtml(storedResult({ originalHand: plain, finalHand: plain }));
    assert.ok(!out.includes('mini-card--wild'));
    for (const face of ['K♠', 'K♥', 'K♦', '8♣', '8♠']) assert.ok(out.includes(face));
  });

  test('falls back to the raw final hand when a stored row predates logicalFinalHand', () => {
    const legacy = { ...result, score: { ...result.score, logicalFinalHand: undefined } };
    // No substitution is known, so the wild shows no rank rather than its dealt
    // one — still never "4♣".
    const out = drawHtml(legacy);
    assert.ok(!out.includes('4♣'));
  });
});
