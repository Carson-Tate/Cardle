import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMeters, dealQualityPercent } from '../src/core/meters.js';
import { scoreForHandId } from '../src/core/hand-evaluator.js';
import { dealHand, createRng } from '../src/core/deck.js';
import { solveOptimalDiscard } from '../src/core/ev-solver.js';

const weakOriginal = { score: 0 }; // High Card opener
// Any decent made hand now moves Risk's chase component visibly. This used to
// need a STRAIGHT_FLUSH: the chase term was normalized against ROYAL_FLUSH
// (~55 million), so everything below a straight flush contributed under a
// single point and rounded away entirely. That was the bug, not the fixture —
// see meters.js's RISK_CHASE_CEILING comment.
const strongOriginal = { score: scoreForHandId('TWO_PAIR') };

// A median-ish deal, so tests that are not about deal quality hold it still.
const MEDIAN_DEAL_EV = 5982;

function meters(overrides = {}) {
  return computeMeters({
    originalHandResult: weakOriginal,
    decisionRating: 0.5,
    dealBestEV: MEDIAN_DEAL_EV,
    drawPercentile: 0.5,
    discardedCount: 1,
    maxDiscards: 3,
    ...overrides,
  });
}

describe('skill', () => {
  test('scales directly with decision rating', () => {
    assert.equal(meters({ decisionRating: 0.5 }).skill, 50);
    assert.equal(meters({ decisionRating: 1 }).skill, 100);
    assert.equal(meters({ decisionRating: 0 }).skill, 0);
  });

  // THE REGRESSION THIS FILE EXISTS TO PREVENT REPEATING. computeMeters used to
  // read `Number.isFinite(decisionRating) ? decisionRating : 1`, so a run with
  // no decision to grade — a Double or Nothing wager, which locks in with zero
  // discards — displayed a full 100% Skill bar. board.js had already decided
  // that case should not claim anything, and hid the Decision Rating line for
  // it; the meter underneath went on claiming perfection anyway.
  test('is null, not 100, when there was no decision to grade', () => {
    assert.equal(meters({ decisionRating: null }).skill, null);
    assert.equal(meters({ decisionRating: undefined }).skill, null);
    assert.equal(meters({ decisionRating: NaN }).skill, null);
  });

  test('clamps into 0-100 rather than trusting its input', () => {
    assert.equal(meters({ decisionRating: 1.8 }).skill, 100);
    assert.equal(meters({ decisionRating: -0.4 }).skill, 0);
  });

  // Skill is now a function of the choice alone. Nothing about the outcome is
  // even in scope — which is the property that the old actualScore/bestEV
  // formula could not have had.
  test('does not move with the draw', () => {
    const cold = meters({ decisionRating: 0.75, drawPercentile: 0.01 }).skill;
    const hot = meters({ decisionRating: 0.75, drawPercentile: 0.99 }).skill;
    assert.equal(cold, hot);
  });
});

describe('luck', () => {
  test('rises with a better draw, holding the deal constant', () => {
    const cold = meters({ drawPercentile: 0.1 }).luck;
    const hot = meters({ drawPercentile: 0.9 }).luck;
    assert.ok(hot > cold, `${hot} should beat ${cold}`);
  });

  test('rises with a stronger deal, holding the draw constant', () => {
    const weakDeal = meters({ dealBestEV: 2216 }).luck;
    const strongDeal = meters({ dealBestEV: 44779 }).luck;
    assert.ok(strongDeal > weakDeal, `${strongDeal} should beat ${weakDeal}`);
  });

  // The defect the percentile replaced: drawFortune graded the result against
  // the player's OWN chosen EV, so choosing badly lowered the bar and inflated
  // Luck. Measured correlation with choice quality was -0.49 — playing well
  // made you look unluckier. Luck must now be flat in Skill.
  test('is completely unmoved by how well the discard was chosen', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((decisionRating) => meters({ decisionRating }).luck);
    assert.equal(new Set(values).size, 1, `luck varied with skill: ${values.join(', ')}`);
  });

  test('is the deal alone when the player held pat — there was no draw', () => {
    const pat = meters({ discardedCount: 0, drawPercentile: null });
    assert.equal(pat.luck, Math.round(dealQualityPercent(MEDIAN_DEAL_EV)));
  });

  // A pat Straight Flush is the luckiest thing that can happen to you. Blending
  // it against a missing draw half would drag it to the middle of the dial.
  test('a superb deal held pat still reads as extremely lucky', () => {
    const pat = meters({ discardedCount: 0, drawPercentile: null, dealBestEV: 7_989_665 });
    assert.ok(pat.luck >= 95, `held a monster deal and Luck read ${pat.luck}%`);
  });

  test('stays within 0-100 for extreme inputs', () => {
    assert.equal(meters({ dealBestEV: 0, drawPercentile: 0 }).luck, 0);
    assert.equal(meters({ dealBestEV: Number.MAX_SAFE_INTEGER, drawPercentile: 1 }).luck, 100);
  });

  test('falls back to the draw alone rather than inventing a deal quality', () => {
    const noDeal = meters({ dealBestEV: NaN, drawPercentile: 0.8 });
    assert.equal(noDeal.luck, 80);
  });
});

describe('dealQualityPercent', () => {
  test('is monotonic across the whole table', () => {
    const evs = [0, 1000, 2216, 5982, 14890, 44779, 7_989_665, 20_000_000];
    const mapped = evs.map(dealQualityPercent);
    for (let i = 1; i < mapped.length; i++) {
      assert.ok(mapped[i] >= mapped[i - 1], `not monotonic at ${evs[i]}: ${mapped.join(', ')}`);
    }
  });

  test('interpolates between stops instead of stepping', () => {
    const low = dealQualityPercent(2216);
    const high = dealQualityPercent(2387);
    const mid = dealQualityPercent((2216 + 2387) / 2);
    assert.ok(mid > low && mid < high, `${mid} should sit strictly between ${low} and ${high}`);
  });

  test('is flat outside the sampled range rather than extrapolating off the end', () => {
    assert.equal(dealQualityPercent(1), 0);
    assert.equal(dealQualityPercent(Number.MAX_SAFE_INTEGER), 100);
  });

  test('returns null for an unmeasurable EV', () => {
    assert.equal(dealQualityPercent(NaN), null);
    assert.equal(dealQualityPercent(undefined), null);
  });
});

// THE CALIBRATION STALENESS GUARD, and the reason this file is slow.
//
// DEAL_QUALITY_STOPS is fitted to the bestEV distribution, which moves whenever
// HAND_RANKS, the rarity odds or the wild chance move. The constant it replaced
// (a single DEAL_QUALITY_CEILING = 8000) had gone stale exactly that way and
// nothing noticed for months: it was fitted against a sampler that dealt with
// createDeck/shuffle and had therefore never rolled a wild card, which put it
// at roughly the 62nd percentile of real deals instead of the 90th. About 38%
// of deals showed that half of Luck pinned at a full 100%.
//
// A percentile table can only be checked by re-sampling, so this re-solves real
// deals and asserts the mapping still comes out roughly uniform. Deliberately
// seeded, so it is deterministic rather than occasionally red. Regenerate with
// `node tools/calibrate-meters.js` when it fails.
describe('deal-quality calibration is still current', () => {
  test('real deals map roughly uniformly across the dial', () => {
    const rng = createRng(20260803);
    const SAMPLES = 40;
    const mapped = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { hand, drawPile } = dealHand(Math.floor(rng() * 2 ** 31));
      const { best } = solveOptimalDiscard(hand, drawPile, { maxDiscards: 3 });
      mapped.push(dealQualityPercent(best.ev));
    }
    mapped.sort((a, b) => a - b);
    const median = mapped[Math.floor(SAMPLES / 2)];
    const mean = mapped.reduce((a, b) => a + b, 0) / SAMPLES;

    // Wide bounds: 40 samples of a heavy-tailed distribution are noisy, and the
    // failure this guards against is a table off by a factor of five, not by a
    // few points.
    assert.ok(median > 25 && median < 75, `median deal read ${median.toFixed(1)}% — table looks stale`);
    assert.ok(mean > 25 && mean < 75, `mean deal read ${mean.toFixed(1)}% — table looks stale`);

    // The specific old failure: a ceiling too low pins the top of the range.
    const pinned = mapped.filter((v) => v >= 99.5).length / SAMPLES;
    assert.ok(pinned < 0.2, `${(pinned * 100).toFixed(0)}% of deals maxed the dial — ceiling is too low`);
    const floored = mapped.filter((v) => v <= 0.5).length / SAMPLES;
    assert.ok(floored < 0.2, `${(floored * 100).toFixed(0)}% of deals bottomed the dial — floor is too high`);
  });
});

describe('risk', () => {
  test('is zero when nothing was discarded, regardless of other inputs', () => {
    assert.equal(meters({ originalHandResult: strongOriginal, discardedCount: 0, drawPercentile: null }).risk, 0);
  });

  test('increases with how many cards were discarded', () => {
    const base = (discardedCount) => meters({ discardedCount }).risk;
    assert.ok(base(1) < base(2));
    assert.ok(base(2) < base(3));
  });

  test('is higher when abandoning an already-strong original hand than a weak one', () => {
    const weakChase = meters({ originalHandResult: weakOriginal, discardedCount: 2 }).risk;
    const strongChase = meters({ originalHandResult: strongOriginal, discardedCount: 2 }).risk;
    assert.ok(strongChase > weakChase);
  });

  test('never exceeds 100 even at max discards from a maxed-out original hand', () => {
    const { risk } = meters({
      originalHandResult: { score: scoreForHandId('ROYAL_FLUSH') },
      discardedCount: 3,
    });
    assert.ok(risk <= 100);
  });

  // Regression guard for a dead half of the formula: the chase component was
  // normalized against ROYAL_FLUSH, so at realistic scores it contributed
  // under 1 point of its 40 and Risk could never exceed 60 — which in turn
  // made "The Gambler" (personality.js, needs risk >= 65) unreachable.
  test('chasing from a real made hand pushes Risk past the discard-only ceiling of 60', () => {
    const risk = (score) => meters({ originalHandResult: { score }, discardedCount: 3 }).risk;
    assert.equal(risk(0), 60, 'discarding everything from nothing is the 60-point floor');
    assert.ok(risk(scoreForHandId('TWO_PAIR')) > 65, 'abandoning Two Pair should read as a real gamble');
    assert.equal(risk(scoreForHandId('THREE_OF_A_KIND')), 100, 'Three of a Kind and up saturates the chase term');
  });

  test('is unaffected by the two dials it sits beside', () => {
    const a = meters({ decisionRating: 0, drawPercentile: 0, discardedCount: 2 }).risk;
    const b = meters({ decisionRating: 1, drawPercentile: 1, discardedCount: 2 }).risk;
    assert.equal(a, b);
  });
});

// Double or Nothing (§4e) forbids discarding, so "what a perfect player could
// get out of this deal" is just the five cards as dealt — a small fraction of
// what the same deal is worth with three draws in hand. Scored against the
// three-discard table, every player on a wager day read a deal quality of
// about 3%.
describe('the no-discard yardstick', () => {
  test('a median pat hand reads mid-dial on a no-discard day, not near zero', () => {
    const MEDIAN_PAT_SCORE = 213; // p50 of 40,000 opening hands
    const wagerDay = dealQualityPercent(MEDIAN_PAT_SCORE, { maxDiscards: 0 });
    const ordinaryDay = dealQualityPercent(MEDIAN_PAT_SCORE, { maxDiscards: 3 });
    assert.ok(wagerDay > 35 && wagerDay < 65, `median pat hand read ${wagerDay.toFixed(1)}%`);
    assert.ok(ordinaryDay < 5, 'the same score against the 3-discard table is the old, wrong answer');
  });

  test('computeMeters picks the table from the day, not from what the player did', () => {
    // Holding pat by choice on an ordinary day still measures the deal by its
    // potential — the player declined to use it, which does not make the deal
    // worse. Only a day that forbids discarding changes what it was worth.
    const byChoice = computeMeters({
      originalHandResult: weakOriginal,
      decisionRating: 1,
      dealBestEV: MEDIAN_DEAL_EV,
      drawPercentile: null,
      discardedCount: 0,
      maxDiscards: 3,
    });
    const byRule = computeMeters({
      originalHandResult: weakOriginal,
      decisionRating: null,
      dealBestEV: MEDIAN_DEAL_EV,
      drawPercentile: null,
      discardedCount: 0,
      maxDiscards: 0,
    });
    assert.equal(byChoice.luck, Math.round(dealQualityPercent(MEDIAN_DEAL_EV, { maxDiscards: 3 })));
    assert.equal(byRule.luck, Math.round(dealQualityPercent(MEDIAN_DEAL_EV, { maxDiscards: 0 })));
    assert.notEqual(byChoice.luck, byRule.luck);
  });

  test('the pat table is monotonic like the other one', () => {
    const scores = [0, 135, 213, 473, 725, 2600, 54_800_000];
    const mapped = scores.map((s) => dealQualityPercent(s, { maxDiscards: 0 }));
    for (let i = 1; i < mapped.length; i++) {
      assert.ok(mapped[i] >= mapped[i - 1], `not monotonic at ${scores[i]}: ${mapped.join(', ')}`);
    }
  });
});
