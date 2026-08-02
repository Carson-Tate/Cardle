// SERVER-SIDE RUN VERIFICATION (DESIGN.md §11z).
//
// Re-derives a finished run from the one thing the player cannot forge — the
// `seed` — and scores it independently of whatever the client claimed.
//
// WHY THIS IS POSSIBLE AT ALL. Three properties line up:
//   1. `daily_plays.seed` is claimed before a card is touched and is write-once
//      (schema.sql revokes UPDATE on every column but `result`), so the server
//      already knows exactly which cards the player was dealt.
//   2. `dealHand(seed)` is a pure function of that seed — same seed, same 52
//      cards in the same order, same rarity and wild flags.
//   3. src/core/ never touches the network or the DOM, so this module and
//      everything it imports run unmodified outside a browser. That purity
//      boundary is what makes the server-side verifier a thin wrapper rather
//      than a reimplementation — and a reimplementation would drift from the
//      real scorer the first time either one changed.
//
// The only genuinely free input is which cards the player threw away, and every
// possible discard choice yields a legitimately computable score. So there is
// nothing a caller can claim that this cannot check.
//
// LIVES IN core/ ON PURPOSE. It is pure, so `npm test` covers it directly; the
// Edge Function (supabase/functions/submit-run) is only an HTTP shell that reads
// the seed, calls this, and writes the answer.

import { dealHand } from './deck.js';
import { scoreRun, OPTIMAL_DISCARD_MAX_BONUS } from './scoring.js';
import { modifierScoringMultiplier } from './modifiers.js';

const DEFAULT_MAX_DISCARDS = 3;

/**
 * How many cards may be thrown away in each round of a given day.
 *
 * Discarding is modelled as an ORDERED LIST OF ROUNDS because that is what the
 * board actually does: Second Wind (`twoRoundDiscard`) rebinds the hand after
 * round one and advances the draw pile, so round two discards from a hand that
 * already contains replacements. An ordinary day is simply one round, and a
 * Double or Nothing wager is one round of zero — so a single code path covers
 * all three instead of three special cases.
 */
export function discardRoundLimitsFor(modifier, { wagered = false } = {}) {
  // The wager resolves the whole hand immediately with no discard at all (§4e).
  if (wagered) return [0];
  if (modifier?.type === 'twoRoundDiscard') {
    return [modifier.round1MaxDiscards ?? 0, modifier.round2MaxDiscards ?? 0];
  }
  return [modifier?.maxDiscards ?? DEFAULT_MAX_DISCARDS];
}

/** Discards must be a set of distinct, in-range, unlocked card positions. */
function normalizeRound(raw, handSize, limit, lockedIndex) {
  if (raw === undefined || raw === null) return { indices: [], errors: [] };
  if (!Array.isArray(raw)) return { indices: null, errors: ['each discard round must be an array'] };
  if (raw.length > limit) {
    return { indices: null, errors: [`discarded ${raw.length} cards but only ${limit} were allowed`] };
  }
  const seen = new Set();
  for (const value of raw) {
    if (!Number.isInteger(value) || value < 0 || value >= handSize) {
      return { indices: null, errors: [`discard index ${String(value)} is not a card position`] };
    }
    if (seen.has(value)) return { indices: null, errors: [`card ${value} was discarded twice`] };
    // A Locked Card (§4) cannot be thrown away. Enforced here and not only in
    // the UI that greys it out.
    if (Number.isInteger(lockedIndex) && value === lockedIndex) {
      return { indices: null, errors: [`card ${value} was locked and could not be discarded`] };
    }
    seen.add(value);
  }
  // Sorted so the replacement mapping is deterministic regardless of the order
  // the client happened to send — matching what board.js does before scoring.
  return { indices: [...seen].sort((a, b) => a - b), errors: [] };
}

/**
 * The unverifiable slice, bounded rather than trusted.
 *
 * `optimalDiscardBonus` needs the full exhaustive EV solve — the "Crunching the
 * odds…" wait, millions of hand evaluations. Re-running that per submission is
 * the one genuinely expensive part of scoring, and it is not worth it: the bonus
 * caps at OPTIMAL_DISCARD_MAX_BONUS (200) against an odds-proportional table
 * where a Royal Flush is 54,800,000. So the client's evContext is accepted and
 * the damage it can do is capped at 200 points — a rounding error beside the
 * hand score, which IS verified exactly.
 *
 * A degenerate context (bestEV === worstEV) is dropped rather than honoured:
 * optimalDiscardBonus short-circuits that case to the full bonus, so accepting
 * it would hand over the maximum for free. Same rule board.js applies to a
 * Double or Nothing round, where there was no decision to grade.
 */
function sanitizeEvContext(evContext) {
  if (!evContext || typeof evContext !== 'object') return undefined;
  const { chosenEV, bestEV, worstEV } = evContext;
  if (![chosenEV, bestEV, worstEV].every((v) => Number.isFinite(v))) return undefined;
  if (bestEV === worstEV) return undefined;
  return { chosenEV, bestEV, worstEV };
}

/**
 * Re-deals from `seed`, replays the claimed discard rounds, and scores the
 * result — the authoritative answer, regardless of what the client reported.
 *
 * @param {object} params
 * @param {number} params.seed - from daily_plays; write-once and server-held
 * @param {number[][]} params.discardRounds - the player's only free input, one
 *   entry per discard round (`[[]]` for a wager, `[[a],[b]]` for Second Wind)
 * @param {object} params.modifier - the day's modifier, resolved SERVER-side
 *   from the game day plus any admin override. Never taken from the client: it
 *   carries both the scoring multiplier and the discard caps.
 * @param {boolean} [params.wagered] - whether Double or Nothing was taken
 * @param {object} [params.evContext] - client-supplied, bounded (see above)
 * @returns {{ok: boolean, errors: string[], score?, originalHand?, finalHand?,
 *   discardIndices?, maxDiscards?}} `originalHand` is the hand as it stood at
 *   the START OF THE FINAL ROUND, which is what board.js stores and what
 *   scoreRun's discarded-card bonuses are computed against.
 */
export function verifyAndScoreRun({ seed, discardRounds, modifier, wagered = false, evContext }) {
  if (!Number.isFinite(seed)) return { ok: false, errors: ['seed is missing or not a number'] };
  if (!modifier) return { ok: false, errors: ['modifier is required'] };

  const limits = discardRoundLimitsFor(modifier, { wagered });
  const rounds = Array.isArray(discardRounds) ? discardRounds : [discardRounds];
  if (rounds.length > limits.length) {
    return { ok: false, errors: [`${rounds.length} discard rounds claimed but the day allows ${limits.length}`] };
  }

  const dealt = dealHand(seed);
  let hand = dealt.hand;
  let pile = dealt.drawPile;
  let finalRoundIndices = [];

  for (let round = 0; round < limits.length; round++) {
    const normalized = normalizeRound(rounds[round], hand.length, limits[round], modifier.lockedIndex);
    if (normalized.errors.length > 0) return { ok: false, errors: normalized.errors };

    finalRoundIndices = normalized.indices;
    // The LAST round's starting hand is what gets scored, so stop before
    // applying it — mirroring board.js, which scores against the hand the player
    // was looking at when they locked in.
    if (round === limits.length - 1) break;

    const replacements = pile.slice(0, normalized.indices.length);
    hand = hand.map((card, index) => {
      const position = normalized.indices.indexOf(index);
      return position === -1 ? card : replacements[position];
    });
    pile = pile.slice(normalized.indices.length);
  }

  const replacements = pile.slice(0, finalRoundIndices.length);
  const finalHand = hand.map((card, index) => {
    const position = finalRoundIndices.indexOf(index);
    return position === -1 ? card : replacements[position];
  });

  const maxDiscards = limits[limits.length - 1];
  const score = scoreRun({
    originalHand: hand,
    finalHand,
    discardedCount: finalRoundIndices.length,
    discardIndices: finalRoundIndices,
    maxDiscards,
    evContext: sanitizeEvContext(evContext),
    modifierMultiplier: modifierScoringMultiplier(modifier),
  });

  return {
    ok: true,
    errors: [],
    score,
    originalHand: hand,
    finalHand,
    discardIndices: finalRoundIndices,
    maxDiscards,
  };
}

export { OPTIMAL_DISCARD_MAX_BONUS };
