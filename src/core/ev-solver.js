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

/**
 * Decision Rating per DESIGN.md §3d — WHERE YOUR CHOICE SAT AMONG THE CHOICES
 * YOU ACTUALLY HAD. 1 = you found the discard with the highest expected value
 * for this exact starting hand; 0 = you found the worst one.
 *
 * THIS USED TO BE `actualScore / bestEV`, and that formula did not measure a
 * decision at all — it measured the draw. `actualScore` is one realised deal
 * off the top of the pile; `bestEV` is a mean over EVERY possible draw. The
 * two are not comparable quantities, and the mismatch is not subtle because
 * HAND_RANKS is deliberately odds-proportional (score ∝ 1/probability, see the
 * long note above): the EV is dominated by rare enormous categories, so it
 * sits far above the median outcome by construction. Measured over 200 real
 * deals played three ways each:
 *
 *   - playing the mathematically OPTIMAL discard produced a median rating of
 *     0.069, and read under 50% on 82.5% of deals;
 *   - on 6% of deals the WORST legal discard scored HIGHER than the optimal
 *     one, because it drew better;
 *   - the rating correlated only 0.36 with the quality of the actual choice.
 *
 * A "did you play well" number that a perfect player fails 82% of the time is
 * measuring something else. The draw half of it is now Luck's job, measured
 * exactly by drawPercentile() below, and the two are independent by
 * construction rather than both being driven by `actualScore`.
 *
 * This is the same quantity optimalDiscardBonus() (scoring.js) has always
 * scored — personality.js already documented that percentile as "the correct
 * signal for found the mathematically optimal discard". Both now derive from
 * this one function so they cannot drift apart.
 *
 * @param {{chosenEV: number, bestEV: number, worstEV: number}} evContext
 * @returns {number|null} 0-1, or null when every legal choice had the same EV
 *   (a Double or Nothing round, or a hand where the discard cannot matter) —
 *   there was no decision to grade, and null is how the rest of the codebase
 *   already spells "not measured".
 */
export function choiceQuality({ chosenEV, bestEV, worstEV } = {}) {
  if (![chosenEV, bestEV, worstEV].every((v) => Number.isFinite(v))) return null;
  if (bestEV === worstEV) return null;
  const quality = (chosenEV - worstEV) / (bestEV - worstEV);
  return Math.max(0, Math.min(1, quality));
}

/**
 * Luck's draw half, measured EXACTLY rather than approximated: of every hand
 * that could have come off the pile for the discard the player actually made,
 * what fraction did the one they got beat?
 *
 * This replaces a hand-tuned `(actualScore - chosenEV) / DRAW_FORTUNE_SCALE`
 * constant, which had two problems. It went stale silently every time
 * HAND_RANKS moved (it was last fitted against a sampler that has never rolled
 * a wild card — see tools/calibrate-meters.js), and because it graded the draw
 * against the player's OWN chosen EV it paid out more for a worse decision:
 * picking a bad discard lowers the bar you are then measured against. Measured
 * over the same 200 deals, Luck correlated -0.49 with choice quality — playing
 * well made you look unluckier. The percentile below is skill-independent by
 * construction (measured spread across optimal/random/worst play: 2.6 points).
 *
 * Ties count as half, the standard mid-rank convention — the realised draw is
 * itself one of the combinations being counted, so it can never read 100%
 * unless nothing in the pile could have beaten it.
 *
 * COST: one discard option's worth of enumeration, i.e. at most 1/32nd of the
 * full solve, and only over the ONE combination set the player committed to.
 * C(47,3) = 16,215 evaluations in the common case.
 *
 * @returns {number|null} 0-1, or null when no cards were drawn (holding pat —
 *   there was no draw to be lucky about).
 */
export function drawPercentile(originalHand, drawPile, discardIndices, actualScore) {
  const drawCount = discardIndices.length;
  if (drawCount === 0) return null;
  if (!Number.isFinite(actualScore)) return null;

  const kept = complement(discardIndices, originalHand.length).map((i) => originalHand[i]);
  // Same hoisting as evForDiscard: one reused array, not one per combination.
  const candidate = kept.slice();
  candidate.length = 5;

  let below = 0;
  let equal = 0;
  let total = 0;
  for (const drawIndices of combinationIndices(drawPile.length, drawCount)) {
    for (let i = 0; i < drawCount; i++) candidate[kept.length + i] = drawPile[drawIndices[i]];
    const score = evaluateHand(candidate).score;
    if (score < actualScore) below++;
    else if (score === actualScore) equal++;
    total++;
  }
  if (total === 0) return null;
  return (below + equal / 2) / total;
}
