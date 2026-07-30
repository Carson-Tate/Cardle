import { evaluateHand } from './hand-evaluator.js';

// Yields index combinations of size k from [0, n). Yields the SAME mutable
// array each time (callers here only read it before the next advance) —
// `indices.slice()` per yield was allocating up to 1.5M throwaway arrays per
// solve. solveOptimalDiscard below is the one caller that keeps a combination
// past the next iteration, and copies it explicitly.
function* combinationIndices(n, k) {
  if (k > n || k < 0) return;
  const indices = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield indices;
    let i = k - 1;
    while (i >= 0 && indices[i] === i + n - k) i--;
    if (i < 0) return;
    indices[i]++;
    for (let j = i + 1; j < k; j++) indices[j] = indices[j - 1] + 1;
  }
}

// NOTE ON WHY THIS STAYS EXHAUSTIVE (and is run in a Web Worker instead —
// see solve-worker.js / board.js). Enumerating every draw is combinatorial in
// the discard size: against a real 47-card pile, discarding 3 is C(47,3) =
// 16,215 draws, 4 is 178,365, and 5 is 1,533,939 — and the Fourth Chance (4)
// and Clean Slate (5) modifiers make the two worst cases everyday
// occurrences, on ~22% of days between them.
//
// Monte Carlo sampling was tried first and REJECTED on measurement, not
// taste: sampling 10,000 draws per option gave up to 78% relative EV error
// and moved the Optimal Discard bonus by as much as 71 points out of 200.
// The reason is structural, and specific to this game — HAND_RANKS is
// deliberately odds-proportional (score ∝ 1/probability, hand-evaluator.js),
// which by construction makes EVERY hand category contribute roughly equally
// to the expected value. So the EV depends on rare-but-enormous categories
// (a Four of a Kind at ~0.024% and 351,000 points contributes about as much
// as a Pair does), and a sample that happens to contain one extra quad swings
// the estimate wildly. Variance reduction would need per-category
// stratification, i.e. most of the way to solving it analytically. Exact
// enumeration off the main thread is simpler and correct.

function complement(indices, size) {
  const discardSet = new Set(indices);
  const kept = [];
  for (let i = 0; i < size; i++) {
    if (!discardSet.has(i)) kept.push(i);
  }
  return kept;
}

// Expected value of discarding the cards at `discardIndices` and drawing
// replacements from every possible combination remaining in the draw pile.
// `drawn` and the kept array are hoisted out of the loop and reused rather
// than rebuilt per combination — at up to 1.5M iterations, the two array
// allocations per iteration were pure garbage-collector pressure.
function evForDiscard(originalHand, drawPile, discardIndices) {
  const keptIndices = complement(discardIndices, originalHand.length);
  const kept = keptIndices.map((i) => originalHand[i]);

  const drawCount = discardIndices.length;
  if (drawCount === 0) {
    return evaluateHand(kept).score;
  }

  const candidate = kept.slice();
  candidate.length = 5;
  let sum = 0;
  let count = 0;
  for (const drawIndices of combinationIndices(drawPile.length, drawCount)) {
    for (let i = 0; i < drawCount; i++) candidate[kept.length + i] = drawPile[drawIndices[i]];
    sum += evaluateHand(candidate).score;
    count++;
  }
  return sum / count;
}

/**
 * Solves for the EV of every legal discard choice given the opening hand
 * and the remaining (undealt) deck.
 *
 * @param {Card[]} originalHand - exactly 5 cards
 * @param {Card[]} drawPile - remaining undealt cards, order irrelevant
 * @param {{minDiscards?: number, maxDiscards?: number, excludedIndices?: number[]}} [options]
 *   `excludedIndices` (Daily Modifiers' Locked Card, DESIGN.md §4) — indices
 *   that may never appear in any candidate discard combination, e.g. a
 *   locked starting card. Without this, "best possible EV" would silently
 *   include combinations the player was never actually allowed to choose,
 *   giving a wrong baseline for Decision Rating.
 * @returns {{ evByDiscard: Array<{indices: number[], ev: number}>, best: {indices:number[], ev:number}, worst: {indices:number[], ev:number} }}
 */
export function solveOptimalDiscard(originalHand, drawPile, options = {}) {
  const { minDiscards = 0, maxDiscards = 3, excludedIndices = [] } = options;
  const excluded = new Set(excludedIndices);

  const evByDiscard = [];
  for (let k = minDiscards; k <= maxDiscards; k++) {
    for (const discardIndices of combinationIndices(originalHand.length, k)) {
      if (discardIndices.some((i) => excluded.has(i))) continue;
      const ev = evForDiscard(originalHand, drawPile, discardIndices);
      // .slice() because combinationIndices now yields one reused array (see
      // its comment) and these entries outlive the loop.
      evByDiscard.push({ indices: discardIndices.slice(), ev });
    }
  }

  let best = evByDiscard[0];
  let worst = evByDiscard[0];
  for (const entry of evByDiscard) {
    if (entry.ev > best.ev) best = entry;
    if (entry.ev < worst.ev) worst = entry;
  }

  return { evByDiscard, best, worst };
}

function sameIndices(a, b) {
  return a.length === b.length && a.slice().sort().join(',') === b.slice().sort().join(',');
}

export function findEV(evByDiscard, discardIndices) {
  const match = evByDiscard.find((entry) => sameIndices(entry.indices, discardIndices));
  if (!match) throw new Error(`No EV entry for discard indices [${discardIndices}]`);
  return match.ev;
}

// Decision Rating per DESIGN.md §3d: actual score ÷ EV of the best possible
// discard strategy for this exact starting hand. Can exceed 100% on a lucky
// draw — that's expected, not clamped.
export function decisionRating(actualScore, bestEV) {
  if (bestEV === 0) return actualScore === 0 ? 1 : Infinity;
  return actualScore / bestEV;
}
