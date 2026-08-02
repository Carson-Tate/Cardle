import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAndScoreRun, discardRoundLimitsFor } from '../src/core/verify-run.js';
import { dealHand, freshSeed } from '../src/core/deck.js';
import { scoreRun } from '../src/core/scoring.js';
import { getDailyModifier, modifierScoringMultiplier, buildModifierById, MODIFIERS } from '../src/core/modifiers.js';

// The whole point: the server must arrive at the SAME number the honest client
// did. If these ever diverge, every honest player's score is silently rewritten
// on submit — which is a far worse failure than the cheating this prevents.
// So this reproduces board.js's own scoring call and compares.
function clientScore(seed, discardIndices, modifier) {
  const { hand: originalHand, drawPile } = dealHand(seed);
  const replacements = drawPile.slice(0, discardIndices.length);
  const finalHand = originalHand.map((card, index) => {
    const position = discardIndices.indexOf(index);
    return position === -1 ? card : replacements[position];
  });
  return scoreRun({
    originalHand,
    finalHand,
    discardedCount: discardIndices.length,
    discardIndices,
    maxDiscards: modifier.maxDiscards ?? 3,
    modifierMultiplier: modifierScoringMultiplier(modifier),
  });
}

describe('verifyAndScoreRun agrees with the client for honest play', () => {
  const modifier = getDailyModifier(new Date('2026-03-05T18:00:00Z'));

  test('reproduces the client total exactly, across many seeds and discard choices', () => {
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const seed = freshSeed();
      const discardIndices = [...new Set([0, 1, 2, 3, 4].filter(() => Math.random() < 0.5))]
        .slice(0, modifier.maxDiscards ?? 3)
        .sort((a, b) => a - b);
      const mine = verifyAndScoreRun({ seed, discardRounds: [discardIndices], modifier });
      assert.ok(mine.ok, mine.errors.join('; '));
      assert.equal(mine.score.total, clientScore(seed, discardIndices, modifier).total, `seed ${seed}`);
      checked++;
    }
    assert.equal(checked, 300);
  });

  test('the same seed always verifies to the same score', () => {
    const seed = 123456;
    const a = verifyAndScoreRun({ seed, discardRounds: [[0, 2]], modifier });
    const b = verifyAndScoreRun({ seed, discardRounds: [[0, 2]], modifier });
    assert.deepEqual(a.score, b.score);
  });
});

describe('verifyAndScoreRun refuses what a cheater would claim', () => {
  const modifier = getDailyModifier(new Date('2026-03-05T18:00:00Z'));
  const seed = 987654;
  const verify = (discardRounds, extra) => verifyAndScoreRun({ seed, discardRounds, modifier, ...extra });

  test('more discards than the day allows', () => {
    const result = verify([[0, 1, 2, 3, 4]]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /only 3 were allowed/);
  });

  test('an index that is not a card position', () => {
    assert.equal(verify([[9]]).ok, false);
    assert.equal(verify([[-1]]).ok, false);
    assert.equal(verify([[1.5]]).ok, false);
  });

  test('the same card discarded twice, which would draw an extra replacement', () => {
    const result = verify([[1, 1]]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /twice/);
  });

  test('more discard rounds than the day has', () => {
    const result = verify([[0], [1]]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /allows 1/);
  });

  test('a locked card cannot be discarded even if the client asks', () => {
    const locked = { ...buildModifierById('lockedCard'), lockedIndex: 2 };
    const result = verifyAndScoreRun({ seed, discardRounds: [[2]], modifier: locked });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /locked/);
  });

  // The bounded slice. A degenerate context short-circuits optimalDiscardBonus
  // to the full 200, so it must be dropped rather than honoured.
  test('a degenerate evContext earns nothing rather than the maximum', () => {
    const free = verify([[0]], { evContext: { chosenEV: 5, bestEV: 5, worstEV: 5 } });
    const none = verify([[0]]);
    assert.equal(free.score.total, none.score.total);
    assert.equal(free.score.skillBonuses.optimalDiscard, 0);
  });

  test('a non-numeric evContext is ignored, not thrown on', () => {
    assert.equal(verify([[0]], { evContext: { chosenEV: 'lots', bestEV: 1, worstEV: 0 } }).ok, true);
    assert.equal(verify([[0]], { evContext: 'nonsense' }).ok, true);
  });

  // Even a fully honoured evContext cannot move the total by more than the cap,
  // which is what makes accepting it acceptable at all.
  test('the client-supplied slice is bounded by OPTIMAL_DISCARD_MAX_BONUS', () => {
    const best = verify([[0]], { evContext: { chosenEV: 1e9, bestEV: 1e9, worstEV: 0 } });
    const none = verify([[0]]);
    assert.ok(best.score.total - none.score.total <= 200, `moved by ${best.score.total - none.score.total}`);
  });

  test('a missing or malformed seed is refused rather than scored as zero', () => {
    assert.equal(verifyAndScoreRun({ seed: undefined, discardRounds: [[]], modifier }).ok, false);
    assert.equal(verifyAndScoreRun({ seed: NaN, discardRounds: [[]], modifier }).ok, false);
  });
});

describe('discardRoundLimitsFor', () => {
  test('an ordinary day is a single round of the modifier cap', () => {
    assert.deepEqual(discardRoundLimitsFor({ maxDiscards: 3 }), [3]);
    assert.deepEqual(discardRoundLimitsFor({}), [3]); // the default
  });

  test('a wager is a single round of zero, whatever the modifier says', () => {
    assert.deepEqual(discardRoundLimitsFor({ maxDiscards: 5 }, { wagered: true }), [0]);
  });

  test('Second Wind is two rounds with its own caps', () => {
    const twoRound = MODIFIERS.find((m) => m.type === 'twoRoundDiscard');
    assert.ok(twoRound, 'expected a twoRoundDiscard modifier to exist');
    assert.deepEqual(discardRoundLimitsFor(twoRound), [twoRound.round1MaxDiscards, twoRound.round2MaxDiscards]);
  });

  // The two-round replay is the subtle one: round one rebinds the hand AND
  // advances the draw pile, so round two draws replacements the first round did
  // not already consume.
  test('two rounds consume the draw pile in order', () => {
    const twoRound = MODIFIERS.find((m) => m.type === 'twoRoundDiscard');
    const seed = 24680;
    const { hand, drawPile } = dealHand(seed);
    const result = verifyAndScoreRun({ seed, discardRounds: [[0], [1]], modifier: twoRound });
    assert.ok(result.ok, result.errors.join('; '));
    // Slot 0 holds round one's replacement (the first pile card); slot 1 holds
    // round two's (the second), not the first again.
    assert.deepEqual(result.originalHand[0], drawPile[0]);
    assert.deepEqual(result.finalHand[1], drawPile[1]);
    // Untouched slots survive both rounds.
    assert.deepEqual(result.finalHand[4], hand[4]);
  });
});
