// One-off calibration script (not part of the app runtime) — samples random
// deals, runs the real EV solver against each, and reports the bestEV
// distribution plus typical actual-vs-chosenEV deviation. Used to re-tune
// meters.js's DEAL_QUALITY_CEILING/DRAW_FORTUNE_SCALE after HAND_RANKS was
// rebalanced to be odds-proportional (see hand-evaluator.js). Run with:
//   node tools/calibrate-meters.js
import { createDeck, createRng, shuffle } from '../src/core/deck.js';
import { evaluateHand } from '../src/core/hand-evaluator.js';
import { solveOptimalDiscard } from '../src/core/ev-solver.js';

const SAMPLES = 1_000;
const bestEVs = [];
const deviations = [];

const rng = createRng(12345);

for (let i = 0; i < SAMPLES; i++) {
  const deck = shuffle(createDeck(), rng);
  const hand = deck.slice(0, 5);
  const drawPile = deck.slice(5);

  const { evByDiscard, best } = solveOptimalDiscard(hand, drawPile);
  bestEVs.push(best.ev);

  // Simulate the player taking the best discard and an actual random draw,
  // to sample realistic actualScore - chosenEV deviation (drawFortune's input).
  const chosen = best;
  const keptIndices = hand.map((_, idx) => idx).filter((idx) => !chosen.indices.includes(idx));
  const kept = keptIndices.map((idx) => hand[idx]);
  const drawn = drawPile.slice(0, chosen.indices.length);
  const actualScore = evaluateHand([...kept, ...drawn]).score;
  deviations.push(Math.abs(actualScore - chosen.ev));
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

console.log('bestEV: p50=%d p75=%d p90=%d p95=%d p99=%d max=%d', percentile(bestEVs, 0.5), percentile(bestEVs, 0.75), percentile(bestEVs, 0.9), percentile(bestEVs, 0.95), percentile(bestEVs, 0.99), Math.max(...bestEVs));
console.log('|actual-chosenEV|: p50=%d p75=%d p90=%d p95=%d p99=%d max=%d', percentile(deviations, 0.5), percentile(deviations, 0.75), percentile(deviations, 0.9), percentile(deviations, 0.95), percentile(deviations, 0.99), Math.max(...deviations));
