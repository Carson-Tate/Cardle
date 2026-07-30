// Runs the EV solver off the main thread, with a synchronous fallback.
//
// Lives in state/ rather than core/ for the same reason persistence.js and
// supabase-client.js do: it depends on browser APIs (Worker) that core/ is
// deliberately kept free of, so core/ stays pure and directly unit-testable
// under plain Node.
//
// Every failure path falls back to solving synchronously on the main thread —
// a browser without module-Worker support, a worker that fails to construct,
// or a worker that errors mid-solve. That's the pre-existing behavior (a
// frozen page for a few seconds), so the worst case here is no worse than
// before this file existed, and the common case is a responsive one.

import { solveOptimalDiscard } from '../core/ev-solver.js';

// null = not tried yet, false = unavailable (use the fallback), otherwise the
// live Worker. One worker is reused for the whole session — constructing it
// costs a module fetch, and solves never overlap in practice.
let worker = null;
let nextRequestId = 1;
const pending = new Map();

function failAllPending(message) {
  for (const { reject } of pending.values()) reject(new Error(message));
  pending.clear();
}

function getWorker() {
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') {
    worker = false;
    return worker;
  }
  try {
    worker = new Worker(new URL('../core/solve-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const { id, result, error } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    });
    worker.addEventListener('error', (event) => {
      // A worker-level error (e.g. the module failed to load) never resolves
      // the outstanding request, so reject it explicitly and stop using the
      // worker — otherwise lockIn() would hang forever waiting on a reply
      // that is never coming.
      console.warn('EV solver worker failed; falling back to main-thread solving:', event.message ?? event);
      worker = false;
      failAllPending('solver worker failed');
    });
  } catch (error) {
    console.warn('Could not start the EV solver worker; solving on the main thread:', error);
    worker = false;
  }
  return worker;
}

/**
 * Same contract as core/ev-solver.js's solveOptimalDiscard, but async and
 * (when possible) computed in a worker so the page stays responsive.
 *
 * @returns {Promise<{evByDiscard: Array<{indices:number[], ev:number}>, best: {indices:number[], ev:number}, worst: {indices:number[], ev:number}}>}
 */
export async function solveOptimalDiscardAsync(originalHand, drawPile, options = {}) {
  const activeWorker = getWorker();
  if (!activeWorker) return solveOptimalDiscard(originalHand, drawPile, options);

  const id = nextRequestId++;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      activeWorker.postMessage({ id, originalHand, drawPile, options });
    });
  } catch (error) {
    console.warn('EV solve via worker failed; retrying on the main thread:', error);
    pending.delete(id);
    return solveOptimalDiscard(originalHand, drawPile, options);
  }
}
