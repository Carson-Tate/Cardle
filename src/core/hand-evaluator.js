// Evaluates a fixed 5-card hand (no best-of-7 selection — Cardle hands are
// always exactly 5 cards). Returns the poker category and its base score
// per DESIGN.md §3a.
//
// A card with rarity 'joker' (src/core/rarity.js) is wild: evaluateHand()
// tries every possible rank/suit in its place and returns whichever
// substitution scores highest. This is the only rarity tier that affects
// hand evaluation — bronze/silver/gold are pure bonus points, applied in
// scoring.js, and never change what poker hand you have.

import { SUITS, RANKS } from './deck.js';

// Scores are ODDS-PROPORTIONAL (owner request: "a pair gives 200 but a royal
// flush gives 5000 which is a lot more rare and only gives 25x more points"
// — the old table was a flat ×5 rescale of arbitrary numbers, never actually
// derived from real hand odds). Anchored at Pair = 200: every other score is
// 200 × (P(Pair) / P(that hand)), using real 5-card poker probabilities out
// of C(52,5) = 2,598,960 possible hands. Since score ∝ 1/probability, this
// makes each hand rank's average payoff proportional to how rare it actually
// is, rather than a hand-picked step ladder — Royal Flush ends up ~274,000x
// rarer than Pair, so it scores ~274,000x more instead of the old 25x.
// Three Straight and Four Straight (owner request: these used to be a
// stacking "extra bonus" only, which meant a hand whose best feature was a
// near-straight still displayed as plain High Card at the top — "i just got
// a three straight and the top said the hand was a high card"). Promoted to
// real hand categories, slotted in by actual rarity (§3w) rather than
// intuition — a Three Straight (13.78% of hands) is genuinely rarer than a
// Pair (42.26%), so it outranks Pair; a Four Straight (3.10%) outranks Two
// Pair but not Three of a Kind (2.11%, rarer still).
export const HAND_RANKS = [
  { id: 'ROYAL_FLUSH', label: 'Royal Flush', score: 54_800_000 },
  { id: 'STRAIGHT_FLUSH', label: 'Straight Flush', score: 6_080_000 },
  { id: 'FOUR_OF_A_KIND', label: 'Four of a Kind', score: 351_000 },
  { id: 'FULL_HOUSE', label: 'Full House', score: 58_700 },
  { id: 'FLUSH', label: 'Flush', score: 42_900 },
  { id: 'STRAIGHT', label: 'Straight', score: 21_600 },
  { id: 'THREE_OF_A_KIND', label: 'Three of a Kind', score: 4_000 },
  { id: 'FOUR_STRAIGHT', label: 'Four Straight', score: 2_726 },
  { id: 'TWO_PAIR', label: 'Two Pair', score: 1_780 },
  { id: 'THREE_STRAIGHT', label: 'Three Straight', score: 613 },
  { id: 'PAIR', label: 'Pair', score: 200 },
  { id: 'HIGH_CARD', label: 'High Card', score: 0 },
];

const RANK_BY_ID = Object.fromEntries(HAND_RANKS.map((r) => [r.id, r]));

// Rank-scaling (owner request: "it should actually matter what it pairs
// with... a joker paired with a jack will be worth more than a joker paired
// with a 2"). Every category whose 5 cards aren't fully symmetric — one
// defined by a specific matching rank (Pair/Two Pair/Three & Four of a
// Kind/Full House) or a run's high card (Straight/Flush/Straight Flush) —
// now scores along a small range instead of one flat number, linear in that
// category's "decisive rank" (2..14). HIGH_CARD stays flat at 0 (it's
// deliberately worthless regardless of cards) and ROYAL_FLUSH stays flat at
// its HAND_RANKS value (always Ace-high by definition — no rank to vary).
//
// Each range is centered on that category's existing odds-proportional
// HAND_RANKS value (used as the rank-8 midpoint, i.e. the "average" hand of
// that type still scores ~exactly what it used to) and its half-width is a
// conservative 40% of the SMALLER gap to its nearest neighbor category —
// e.g. Pair (200, gap up to Three Straight's 613 = 413, gap down to High
// Card's 0 = 200) gets a ±80 range, nowhere near wide enough to threaten the
// weakest Three Straight (445). This guarantees strict poker-hand-category
// ordering can never invert, no matter which specific ranks form the hand —
// verified for every adjacent pair (now including THREE_STRAIGHT/
// FOUR_STRAIGHT, §3w) in DESIGN.md §3u/§3w. TWO_PAIR and THREE_OF_A_KIND's
// constants shifted from §3u's original values because their NEIGHBORS
// changed (Four Straight now sits between Two Pair and Three of a Kind) —
// PAIR's stayed identical since its neighbors (High Card, Three Straight)
// still produce the same binding (smaller) gap.
const RANK_SCALE = {
  PAIR: { base: 96, perRank: 13 },
  THREE_STRAIGHT: { base: 389, perRank: 28 },
  TWO_PAIR: { base: 1276, perRank: 63 },
  FOUR_STRAIGHT: { base: 2222, perRank: 63 },
  THREE_OF_A_KIND: { base: 3320, perRank: 85 },
  STRAIGHT: { base: 12216, perRank: 1173 },
  FLUSH: { base: 34476, perRank: 1053 },
  FULL_HOUSE: { base: 50276, perRank: 1053 },
  FOUR_OF_A_KIND: { base: 195104, perRank: 19487 },
  STRAIGHT_FLUSH: { base: 3024536, perRank: 381933 },
};

function rankScaledScore(id, decisiveRank) {
  const scale = RANK_SCALE[id];
  return scale.base + scale.perRank * decisiveRank;
}

// Looks up a HAND_RANKS score by id — used by other modules (scoring.js,
// achievements.js, personality.js, meters.js) to anchor their own
// thresholds to a specific hand rank instead of hardcoding a copy of the
// number, which would silently drift out of sync whenever this table
// changes (as happened when the table above was odds-proportionally
// rescaled — every dependent threshold had been a bare magic number that
// just happened to equal some old HAND_RANKS score).
export function scoreForHandId(id) {
  return RANK_BY_ID[id].score;
}

// 0 = High Card ... 9 = Royal Flush, for comparing "how many ranks did it
// improve by" (Long Shot bonus) rather than comparing raw point values.
export function handStrengthIndex(id) {
  const position = HAND_RANKS.findIndex((r) => r.id === id);
  return HAND_RANKS.length - 1 - position;
}

function countBy(cards, key) {
  const counts = new Map();
  for (const card of cards) {
    counts.set(card[key], (counts.get(card[key]) ?? 0) + 1);
  }
  return counts;
}

function isFlush(cards) {
  return new Set(cards.map((c) => c.suit)).size === 1;
}

// Returns the sorted-descending distinct ranks used for straight detection,
// treating Ace (14) as both high and low (wheel: A-2-3-4-5).
function straightHighCard(cards) {
  const ranks = [...new Set(cards.map((c) => c.rank))];
  if (ranks.length !== 5) return null;

  const sorted = ranks.slice().sort((a, b) => a - b);
  const isSequential = sorted.every((r, i) => i === 0 || r === sorted[i - 1] + 1);
  if (isSequential) return sorted[4];

  // Wheel: A,2,3,4,5
  const wheel = [14, 2, 3, 4, 5];
  if (wheel.every((r) => ranks.includes(r))) return 5;

  return null;
}

export function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error('evaluateHand requires exactly 5 cards');
  }

  const jokerIndices = [];
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].rarity === 'joker') jokerIndices.push(i);
  }
  if (jokerIndices.length > 0) {
    return evaluateHandWithWildJokers(cards, jokerIndices);
  }

  return evaluateFixedHand(cards);
}

// Which suits are worth trying for a wild card, given the cards it's sitting
// alongside. evaluateFixedHand() only ever consults suit via isFlush(), so
// unless EVERY other card already shares one suit, a flush is impossible no
// matter what the wild becomes and the suit cannot affect the resulting
// category or score at all — leaving 13 substitutions to check instead of 52.
//
// This is behavior-preserving, not an approximation: the search below keeps a
// candidate only on a STRICTLY greater score, and when suit is irrelevant
// every suit yields identical scores for a given rank, so the first suit tried
// (SUITS[0]) already won every tie before this pruning existed. It matters
// because ev-solver.js calls evaluateHand() tens of thousands of times per
// solve, and the wild search multiplies every one of them.
function candidateSuitsFor(others) {
  const suits = new Set();
  for (const card of others) suits.add(card.suit);
  return suits.size === 1 ? SUITS : [SUITS[0]];
}

// Tries each wild card as every plausible rank/suit and keeps whichever
// combination scores highest. The winning substitution is exposed as
// `wildSubstitution` so callers (scoring.js's logicalCardsFor /
// contributingIndices lookup) can reason about "what the wild effectively is"
// without re-running the search themselves; with more than one wild,
// `wildSubstitutions` carries them all keyed by hand position.
//
// Previously this used `findIndex` and so only ever substituted the FIRST
// wild — any second one kept the meaningless rank/suit it happened to be
// dealt as, making the hand strictly weaker than the player's cards actually
// allowed. Two wilds plus 9♠ J♠ K♠ evaluated as a Three Straight (613) when
// the real best hand is a Straight Flush (6,080,000).
function evaluateHandWithWildJokers(cards, jokerIndices) {
  const fixed = cards.filter((_, i) => !jokerIndices.includes(i));

  // Exhaustive for one or two wilds — the only counts reachable in real play
  // (a second wild is already ~1 in 25,000 hands, a third ~1 in 12 million).
  // Three or more is only reachable through the test-mode admin panel's
  // custom hand builder, where a full 52^n search would hang the page, so
  // those resolve one wild at a time instead: each pass picks the best card
  // for one wild with the rest held at their current best guess. Not provably
  // optimal, but bounded, and still far better than leaving them literal.
  if (jokerIndices.length > 2) {
    return evaluateHandWithWildJokersGreedy(cards, jokerIndices, fixed);
  }

  let best = null;
  let bestSubstitution = null;
  const firstSuits = candidateSuitsFor(fixed);

  if (jokerIndices.length === 1) {
    for (const suit of firstSuits) {
      for (const rank of RANKS) {
        const candidate = evaluateFixedHand([...fixed, { rank, suit }]);
        if (!best || candidate.score > best.score) {
          best = candidate;
          bestSubstitution = [{ rank, suit }];
        }
      }
    }
  } else {
    for (const suitA of SUITS) {
      for (const rankA of RANKS) {
        const a = { rank: rankA, suit: suitA };
        for (const suitB of SUITS) {
          for (const rankB of RANKS) {
            const b = { rank: rankB, suit: suitB };
            const candidate = evaluateFixedHand([...fixed, a, b]);
            if (!best || candidate.score > best.score) {
              best = candidate;
              bestSubstitution = [a, b];
            }
          }
        }
      }
    }
  }

  return withWildMetadata(best, jokerIndices, bestSubstitution);
}

function evaluateHandWithWildJokersGreedy(cards, jokerIndices, fixed) {
  // Start every wild at a harmless placeholder, then improve one at a time.
  const subs = jokerIndices.map(() => ({ rank: RANKS[0], suit: SUITS[0] }));
  let best = evaluateFixedHand([...fixed, ...subs]);
  for (let pass = 0; pass < 2; pass++) {
    for (let w = 0; w < subs.length; w++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          const trial = subs.slice();
          trial[w] = { rank, suit };
          const candidate = evaluateFixedHand([...fixed, ...trial]);
          if (candidate.score > best.score) {
            best = candidate;
            subs[w] = { rank, suit };
          }
        }
      }
    }
  }
  return withWildMetadata(best, jokerIndices, subs);
}

function withWildMetadata(best, jokerIndices, substitutions) {
  const byIndex = {};
  jokerIndices.forEach((handIndex, n) => {
    byIndex[handIndex] = substitutions[n];
  });
  return {
    ...best,
    hasWildJoker: true,
    // Kept for the single-wild case every existing caller was written
    // against; `wildSubstitutions` is the position-keyed form that stays
    // correct when a hand holds more than one.
    wildSubstitution: substitutions[0],
    wildSubstitutions: byIndex,
  };
}

// Full-board hands where every one of the 5 cards is load-bearing (no
// "dead" kicker) — see contributingIndices() below.
const FULL_BOARD_HANDS = new Set(['FLUSH', 'STRAIGHT', 'FULL_HOUSE', 'STRAIGHT_FLUSH', 'ROYAL_FLUSH']);

// Given the 5 cards that produced `handResult` and the result itself,
// returns which card INDICES (0-4) actually form the scoring pattern —
// e.g. for a Pair, just the 2 matching cards, not the 3 kickers; for a
// Flush/Straight/Full House/Straight Flush/Royal Flush, all 5 (every card
// is load-bearing). Used by scoring.js to tell whether a rare card
// genuinely helped build the hand rather than just being dealt alongside it
// (owner request — the rarity multiplier should only apply to the whole
// score when the rare card is part of the actual combination).
//
// If the hand used a wild Joker, pass "logical" cards — the joker's slot
// replaced by `handResult.wildSubstitution` — so the rank-count logic below
// sees the real pattern the joker completed, not an unrelated placeholder
// rank/suit.
export function contributingIndices(cards, handResult) {
  if (handResult.id === 'HIGH_CARD') return [];
  if (FULL_BOARD_HANDS.has(handResult.id)) return [0, 1, 2, 3, 4];
  if (handResult.id === 'THREE_STRAIGHT' || handResult.id === 'FOUR_STRAIGHT') {
    return longestConsecutiveRunIndices(cards).indices;
  }

  const rankCounts = new Map();
  cards.forEach((c) => rankCounts.set(c.rank, (rankCounts.get(c.rank) ?? 0) + 1));
  const indices = [];
  cards.forEach((c, i) => {
    if (rankCounts.get(c.rank) >= 2) indices.push(i);
  });
  return indices;
}

// entries: [{i, key}], one per card. Duplicate keys (a pair) collapse to the
// FIRST occurrence's index — a repeated rank can't extend a "consecutive
// distinct ranks" run further, so only one representative index per rank
// value is ever part of the run.
function longestRunIndicesIn(entries) {
  const indexByKey = new Map();
  for (const entry of entries) {
    if (!indexByKey.has(entry.key)) indexByKey.set(entry.key, entry.i);
  }
  const sortedKeys = [...indexByKey.keys()].sort((a, b) => a - b);

  let bestStart = 0;
  let bestLen = sortedKeys.length > 0 ? 1 : 0;
  let curStart = 0;
  let curLen = bestLen;
  for (let k = 1; k < sortedKeys.length; k++) {
    if (sortedKeys[k] === sortedKeys[k - 1] + 1) {
      curLen++;
    } else {
      curStart = k;
      curLen = 1;
    }
    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
    }
  }

  const runKeys = sortedKeys.slice(bestStart, bestStart + bestLen);
  return {
    length: bestLen,
    indices: runKeys.map((key) => indexByKey.get(key)),
    highKey: runKeys.length > 0 ? runKeys[runKeys.length - 1] : null,
  };
}

// The longest run of consecutive ranks among the hand's distinct ranks
// (Ace-low aware — an Ace counts as 1 as well as 14, so A-2-3 still reads as
// a run), which card indices form it, and the run's "visual" high card
// (`highCard` — 3 for a low-Ace A-2-3 run, not 14, mirroring how
// straightHighCard() treats the wheel). Core classification logic: used
// below to detect Three Straight/Four Straight when nothing better applies,
// AND exported for scoring.js/bonus-registry.js to check whether a rare card
// is genuinely part of a run rather than just present in the hand. A genuine
// 5-card straight always has 5 distinct consecutive ranks, so `.length`
// naturally comes out 5 for those (already handled earlier in
// evaluateFixedHand, before this is ever consulted for category purposes).
export function longestConsecutiveRunIndices(cards) {
  const highEntries = cards.map((c, i) => ({ i, key: c.rank }));
  const lowEntries = cards.map((c, i) => ({ i, key: c.rank === 14 ? 1 : c.rank }));
  const highRun = longestRunIndicesIn(highEntries);
  const lowRun = longestRunIndicesIn(lowEntries);
  const winner = highRun.length >= lowRun.length ? highRun : lowRun;
  return { length: winner.length, indices: winner.indices, highCard: winner.highKey };
}

// Same result as longestConsecutiveRunIndices() but only {length, highCard}
// (no card indices) — evaluateFixedHand's classification below needs just
// those two to slot FOUR_STRAIGHT/THREE_STRAIGHT into the if-chain, and
// that classification runs on every single evaluateHand() call (up to 52x
// per hand for a wild Joker, times thousands of discard/draw combinations
// in ev-solver.js's exhaustive search — a genuinely hot path). Presence
// flags in a flat array + one linear scan avoids the Map allocations and two
// separate sorts longestConsecutiveRunIndices() needs to also track WHICH
// cards form the run — a real, measured win at that call volume, not
// premature optimization (perf regression caught by
// tests/ev-solver.test.js's joker-search bound after this file's
// Three/Four Straight classification fix started calling run-detection for
// every Pair/Two-Pair-shaped hand, not just bare High Card, §3w/§3x).
function runLengthAndHighCard(cards) {
  const present = new Uint8Array(15); // index 0 unused; 1 = ace-low, 2-14 = normal ranks
  for (const card of cards) {
    present[card.rank] = 1;
    if (card.rank === 14) present[1] = 1;
  }
  let bestLen = 0;
  let bestHigh = null;
  let curLen = 0;
  let curHigh = null;
  for (let r = 1; r <= 14; r++) {
    if (present[r]) {
      curLen++;
      curHigh = r;
    } else {
      curLen = 0;
      curHigh = null;
    }
    if (curLen > bestLen) {
      bestLen = curLen;
      bestHigh = curHigh;
    }
  }
  return { length: bestLen, highCard: bestHigh };
}

function evaluateFixedHand(cards) {
  const flush = isFlush(cards);
  const straightHigh = straightHighCard(cards);
  const straight = straightHigh !== null;

  const countsByRank = countBy(cards, 'rank');
  const rankCounts = [...countsByRank.values()].sort((a, b) => b - a);
  const sortedRanks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const maxRank = sortedRanks[0];
  // [rank, count] pairs, highest COUNT first, then highest RANK — so for a
  // Full House this is [[tripRank, 3], [pairRank, 2]], and for Two Pair it's
  // [[higherPairRank, 2], [lowerPairRank, 2], [kickerRank, 1]], letting each
  // branch below just read `ranksByCountDesc[0][0]` for "the rank that
  // defines this category" (Pair/Full House's trip/Two Pair's HIGHER pair,
  // per standard poker tiebreak convention).
  const ranksByCountDesc = [...countsByRank.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  // Lazily computed (memoized via `run`, below) so the checks further down
  // can slot FOUR_STRAIGHT/THREE_STRAIGHT into the if-chain at the exact
  // position their HAND_RANKS rarity demands, instead of only ever being
  // reachable via a catch-all "else" at the bottom. A single pair or
  // two-pair pattern can genuinely coexist with a longer consecutive run
  // than the pattern itself implies — e.g. 5,5,6,7,8 is "a Pair of 5s" AND "a
  // 5-6-7-8 four-straight" at once (the pair's own rank doubles as one end of
  // the run) — and since Four Straight (2,726) is odds-proportionally rarer
  // than Two Pair (1,780), which is rarer than Three Straight (613), which is
  // rarer than Pair (200), whichever ONE of those categories is rarest must
  // win, not whichever the if-chain happens to test first (owner bug report:
  // a hand like this displayed as "Pair" worth ~150 points, with the run
  // demoted to a throwaway +30 "extra bonus" badge instead of being the
  // headline Three/Four Straight it actually ranks as, DESIGN.md §3w/§3x).
  //
  // Lazy rather than eager: computing it unconditionally for every hand
  // (including Flushes/Straights/Quads that never need it) was a measured
  // perf regression under ev-solver's exhaustive discard search, which calls
  // this thousands of times per run. `getRun()` only pays the cost for hands
  // that reach this deep into the chain, same as before this fix.
  let run = null;
  function getRun() {
    if (run === null) run = runLengthAndHighCard(cards);
    return run;
  }

  let result;
  let score;
  if (straight && flush && straightHigh === 14) {
    result = RANK_BY_ID.ROYAL_FLUSH;
    score = result.score;
  } else if (straight && flush) {
    result = RANK_BY_ID.STRAIGHT_FLUSH;
    score = rankScaledScore('STRAIGHT_FLUSH', straightHigh);
  } else if (rankCounts[0] === 4) {
    result = RANK_BY_ID.FOUR_OF_A_KIND;
    score = rankScaledScore('FOUR_OF_A_KIND', ranksByCountDesc[0][0]);
  } else if (rankCounts[0] === 3 && rankCounts[1] === 2) {
    result = RANK_BY_ID.FULL_HOUSE;
    score = rankScaledScore('FULL_HOUSE', ranksByCountDesc[0][0]);
  } else if (flush) {
    result = RANK_BY_ID.FLUSH;
    score = rankScaledScore('FLUSH', maxRank);
  } else if (straight) {
    result = RANK_BY_ID.STRAIGHT;
    score = rankScaledScore('STRAIGHT', straightHigh);
  } else if (rankCounts[0] === 3) {
    result = RANK_BY_ID.THREE_OF_A_KIND;
    score = rankScaledScore('THREE_OF_A_KIND', ranksByCountDesc[0][0]);
  } else if (getRun().length === 4) {
    result = RANK_BY_ID.FOUR_STRAIGHT;
    score = rankScaledScore('FOUR_STRAIGHT', run.highCard);
  } else if (rankCounts[0] === 2 && rankCounts[1] === 2) {
    result = RANK_BY_ID.TWO_PAIR;
    score = rankScaledScore('TWO_PAIR', ranksByCountDesc[0][0]);
  } else if (getRun().length === 3) {
    result = RANK_BY_ID.THREE_STRAIGHT;
    score = rankScaledScore('THREE_STRAIGHT', run.highCard);
  } else if (rankCounts[0] === 2) {
    result = RANK_BY_ID.PAIR;
    score = rankScaledScore('PAIR', ranksByCountDesc[0][0]);
  } else {
    result = RANK_BY_ID.HIGH_CARD;
    score = 0;
  }

  return {
    id: result.id,
    label: result.label,
    score,
    tiebreak: sortedRanks,
  };
}
