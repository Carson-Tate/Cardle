// Web Worker entry point for the EV solver (DESIGN.md §3d).
//
// solveOptimalDiscard() is exhaustive by necessity — see ev-solver.js's own
// long comment on why sampling was measured and rejected — which means it
// legitimately takes seconds on the days that allow 4 or 5 discards
// (Fourth Chance, Clean Slate), and longer again with a Wild card in hand.
// board.js used to call it directly inside lockIn(), so all of that time was
// a frozen page: no animation, no scrolling, no response to input.
//
// Running it here instead keeps the main thread free, so the "Crunching the
// odds…" state board.js shows can actually animate while the work happens.
// The math is identical — this file adds no logic of its own, it only moves
// where the existing function runs.
import { solveOptimalDiscard } from './ev-solver.js';

self.addEventListener('message', (event) => {
  const { id, originalHand, drawPile, options } = event.data;
  try {
    // Structured-cloned plain objects come back in, plain objects go out —
    // Card is `{rank, suit, rarity, jokerTier}` with no methods or identity
    // the caller depends on, so nothing is lost across the boundary.
    self.postMessage({ id, result: solveOptimalDiscard(originalHand, drawPile, options) });
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
});
