import { evaluateHand, handStrengthIndex, contributingIndices, longestConsecutiveRunIndices } from './hand-evaluator.js';
import { evaluateBonuses } from './bonus-registry.js';
import { RARITY_BY_ID, pointsForRarity, multiplierForRarity } from './rarity.js';

const ACE = 14;
const FACE_RANKS = new Set([11, 12, 13]); // Jack, Queen, King (Ace excluded — scored separately)

// All point constants in this file (and rarity.js, bonus-registry.js) are
// scaled ×5 from their original values (owner request, RNGDLE-inspired
// rescale: typical great runs should land in the low thousands, not
// hundreds). The ×5 factor is uniform across every additive component so
// all the existing relative balancing — flavor staying minor, suit synergy
// never outscoring a made hand, pity staying a small safety net — holds
// exactly as before, just at a bigger scale. See rarityMultiplier() below
// for the separate multiplicative layer that makes rare pulls swing much
// harder than a flat add-on ever could.
const FLAVOR_ACE_POINTS = 25;
const FLAVOR_ACE_CAP = 100;
const FLAVOR_FACE_POINTS = 10;
const FLAVOR_FACE_CAP = 50;
const FLAVOR_TOTAL_CAP = 125;

const PERFECT_KEEP_BONUS = 50;
// Three of a Kind or better counts as "excellent". Compared by CATEGORY
// (handStrengthIndex), not raw score — hand-evaluator.js's rank-scaling
// means two hands in the same category no longer share one flat score (a
// low-rank Three of a Kind can score less than scoreForHandId('THREE_OF_A_KIND')
// itself), so a score-threshold comparison would wrongly exclude a genuine
// low-rank Three of a Kind from "at least Three of a Kind."
const PERFECT_KEEP_THRESHOLD_INDEX = handStrengthIndex('THREE_OF_A_KIND');
const LONG_SHOT_BONUS = 75;
const LONG_SHOT_MIN_RANK_JUMP = 3;
const CLEAN_FINISH_BONUS = 50;
const CLEAN_FINISH_HANDS = new Set(['FULL_HOUSE', 'FLUSH', 'STRAIGHT', 'STRAIGHT_FLUSH', 'ROYAL_FLUSH']);
// Exported so personality.js can anchor "The Statistician" to the literal
// max instead of a hardcoded copy of this number (§7a fix).
export const OPTIMAL_DISCARD_MAX_BONUS = 200;

const PITY_THRESHOLD = 250;
const PITY_MAX_BONUS = 150;

// Flat points per suit-matched group, keyed by group size. Kept modest
// relative to the hand-rank table: even a maximally-suited High Card (5
// broadway cards, one suit) tops out well under Three of a Kind — this
// seasons the score without reordering which poker hand wins.
const SUIT_GROUP_BONUS = { 2: 40, 3: 80, 4: 140, 5: 200 };
const SUIT_NUMBER_SCALE = 5;
// Reused by cardValueBonus() below for the same rank-to-points conversion,
// rather than inventing a separate constant — keeps the two "sum of ranks"
// bonuses on the same, already-balanced scale.
const CARD_VALUE_SCALE = SUIT_NUMBER_SCALE;

// Flavor bonuses per DESIGN.md §3b — deliberately minor, capped, seasoning
// rather than swinging the score. `aceIndices`/`faceIndices` (card
// positions, not point values) feed the score-breakdown UI's card-proof
// strip (DESIGN.md §3p) — they don't affect scoring, just which cards get
// highlighted as "why this fired".
export function flavorBonus(cards) {
  const aceIndices = [];
  const faceIndices = [];
  cards.forEach((c, i) => {
    if (c.rank === ACE) aceIndices.push(i);
    else if (FACE_RANKS.has(c.rank)) faceIndices.push(i);
  });

  const aceBonus = Math.min(aceIndices.length * FLAVOR_ACE_POINTS, FLAVOR_ACE_CAP);
  const faceBonus = Math.min(faceIndices.length * FLAVOR_FACE_POINTS, FLAVOR_FACE_CAP);
  const total = Math.min(aceBonus + faceBonus, FLAVOR_TOTAL_CAP);

  return { aceBonus, faceBonus, total, aceIndices, faceIndices };
}

// ⭐ Perfect Keep — held all five cards and still landed an excellent hand.
export function perfectKeepBonus(discardedCount, finalHandResult) {
  if (discardedCount === 0 && handStrengthIndex(finalHandResult.id) >= PERFECT_KEEP_THRESHOLD_INDEX) {
    return PERFECT_KEEP_BONUS;
  }
  return 0;
}

// 🔥 Long Shot — improved by three or more hand ranks after drawing.
export function longShotBonus(originalHandResult, finalHandResult) {
  const jump = handStrengthIndex(finalHandResult.id) - handStrengthIndex(originalHandResult.id);
  return jump >= LONG_SHOT_MIN_RANK_JUMP ? LONG_SHOT_BONUS : 0;
}

// 💎 Clean Finish — every card in the final hand contributes; no dead weight
// (categories that don't leave an unused kicker: straights, flushes, full house).
export function cleanFinishBonus(finalHandResult) {
  return CLEAN_FINISH_HANDS.has(finalHandResult.id) ? CLEAN_FINISH_BONUS : 0;
}

// 🎯 Optimal Discard — scaled credit for how close the chosen discard's EV
// was to the best possible EV among all discard choices for this hand.
export function optimalDiscardBonus({ chosenEV, bestEV, worstEV }) {
  if (bestEV === worstEV) return OPTIMAL_DISCARD_MAX_BONUS;
  const percentile = (chosenEV - worstEV) / (bestEV - worstEV);
  return Math.round(clamp(percentile, 0, 1) * OPTIMAL_DISCARD_MAX_BONUS);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ♥ Suit Synergy — 2 or more cards sharing a suit score the sum of their
// ranks ("the numbers") plus a flat bonus for the group size. E.g. 2♥ + 3♥
// scores 5 for the numbers, plus the size-2 group bonus.
//
// Only the single best-scoring suit group counts (a hand can't have two
// groups of the same size sharing cards, but ties are possible — e.g. two
// different suits both appearing twice — so we take whichever scores higher
// rather than picking one arbitrarily).
export function suitSynergyBonus(cards) {
  const bySuit = new Map();
  cards.forEach((card, i) => {
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit).push(i);
  });

  // indices (card positions, not point values) feed the score-breakdown
  // UI's card-proof strip (DESIGN.md §3p) — the specific cards sharing the
  // winning suit.
  let best = { suit: null, count: 0, numberBonus: 0, groupBonus: 0, total: 0, indices: [] };
  for (const [suit, indices] of bySuit) {
    if (indices.length < 2) continue;
    const numberBonus = indices.reduce((sum, i) => sum + cards[i].rank, 0) * SUIT_NUMBER_SCALE;
    const groupBonus = SUIT_GROUP_BONUS[indices.length] ?? 0;
    const total = numberBonus + groupBonus;
    if (total > best.total) {
      best = { suit, count: indices.length, numberBonus, groupBonus, total, indices };
    }
  }

  return best;
}

// 🎴 Card Value — every card in the final hand contributes its rank,
// unconditionally (owner request: "base points for each card in the hand,
// make it balanced with the current points system"). Unlike Flavor Bonus
// (aces/faces only) or Suit Synergy (needs 2+ matching suit), this always
// fires — even five unrelated low cards contribute *something* just for
// being dealt. Uses the same ×5 rank-to-points conversion as Suit Synergy's
// number bonus (CARD_VALUE_SCALE === SUIT_NUMBER_SCALE) rather than a new,
// unrelated constant, so it sits on the same already-calibrated scale:
// roughly 50-350 for a realistic hand, the same order of magnitude as
// Flavor Bonus (cap 125) and a single Suit Synergy group (40-240) — a
// meaningful new layer, not one that swamps the hand-rank table (0-5000).
export function cardValueBonus(cards) {
  const total = cards.reduce((sum, card) => sum + card.rank, 0) * CARD_VALUE_SCALE;
  return { total };
}

// 🥉🥈🥇🃏 Rarity bonuses — each card that rolled bronze/silver/gold/joker
// rarity (src/core/rarity.js, rolled deterministically per card in
// deck.js's dealHand) adds a flat, odds-calibrated bonus scaled by its rank
// (flat regardless of rank for Joker, whose points instead depend on which
// of Bronze/Silver/Gold it rolled as its jokerTier — see rarity.js).
// Independent per card, so a hand can have more than one. Deliberately the
// *modest*, unconditional reward for simply holding a rare card — see
// handSynergyBonus in scoreRun() below for the much larger payoff that
// requires the card to genuinely be part of a scoring combination.
export function rarityBonus(cards) {
  const items = [];
  let total = 0;
  cards.forEach((card, index) => {
    const tier = card.rarity ? RARITY_BY_ID[card.rarity] : null;
    if (!tier) return;
    const points = pointsForRarity(card.rarity, card.rank, card.jokerTier);
    const jokerFlavor = card.rarity === 'joker' ? (RARITY_BY_ID[card.jokerTier] ?? RARITY_BY_ID.bronze) : null;
    const label = jokerFlavor ? `${jokerFlavor.label} Wild` : tier.label;
    items.push({ card, index, rarity: tier.id, jokerTier: card.jokerTier ?? null, emoji: tier.emoji, label, points });
    total += points;
  });
  return { items, total };
}

// 🗑️ Discarded Rarity Bonus (owner request: "discarding rare cards should
// add a good amount of points") — letting go of a rare card for a better
// draw shouldn't feel like throwing points in the trash. Each discarded
// card that had rolled a rarity pays out DISCARD_RARITY_SHARE of what it
// would have earned had it stayed (pointsForRarity, same odds-calibrated
// formula as rarityBonus above) — deliberately *less* than keeping it,
// since keeping a rare card that ends up in the winning combo can multiply
// the WHOLE score (see hasRareCardInWinningCombo below), while a discard
// never can. `index` here is the position within `discardedCards` (not the
// original hand), since discarded cards never appear in the final hand's
// card-proof strip — see badge wiring in board.js.
const DISCARD_RARITY_SHARE = 0.5;

export function discardedRarityBonus(discardedCards) {
  const items = [];
  let total = 0;
  discardedCards.forEach((card, index) => {
    const tier = card.rarity ? RARITY_BY_ID[card.rarity] : null;
    if (!tier) return;
    const fullPoints = pointsForRarity(card.rarity, card.rank, card.jokerTier);
    const points = Math.round(fullPoints * DISCARD_RARITY_SHARE);
    const jokerFlavor = card.rarity === 'joker' ? (RARITY_BY_ID[card.jokerTier] ?? RARITY_BY_ID.bronze) : null;
    const label = jokerFlavor ? `${jokerFlavor.label} Wild` : tier.label;
    items.push({ card, index, rarity: tier.id, jokerTier: card.jokerTier ?? null, emoji: tier.emoji, label, points });
    total += points;
  });
  return { items, total };
}

// ✨ Rarity Multiplier — the combined multiplicative factor every rare card
// in the final hand contributes (rarity.js's multiplierForRarity, Joker
// tier-aware). STACKS (multiplies together) rather than picking only the
// best one — a hand with a bronze AND a gold is rarer, and more exciting,
// than either alone, so it should swing harder (1.2 * 2.5 = 3x), not just
// take the bigger of the two. Whether this actually gets APPLIED — and to
// how much of the score — depends on whether a rare card is part of the
// winning combination; see hasRareCardInWinningCombo() and scoreRun() below.
//
// On top of that multiplicative stack, MULTI_RARITY_KICKER adds a flat +25%
// per rare card beyond the first (owner request: "hands with multiple rare
// cards should be a higher multiplier than normal" — pulling two rare cards
// should feel like more than just the product of their individual tiers, on
// top of the already-stacked total). Two bronzes (1.2 * 1.2 = 1.44x on their
// own) become 1.44 * 1.25 = 1.8x; three rare cards get +50%, and so on.
// Rounded to 2 decimals so floating-point products of tier multipliers
// (e.g. 1.2 * 1.5) never display as 1.7999999999999998.
const MULTI_RARITY_KICKER = 0.25;

export function rarityMultiplier(cards) {
  let multiplier = 1;
  let rareCount = 0;
  for (const card of cards) {
    if (card.rarity) {
      multiplier *= multiplierForRarity(card.rarity, card.jokerTier);
      rareCount += 1;
    }
  }
  if (rareCount >= 2) multiplier *= 1 + MULTI_RARITY_KICKER * (rareCount - 1);
  return Math.round(multiplier * 100) / 100;
}

// Builds the "logical" 5-card hand: identical to the real final hand, except
// a wild Joker's slot is replaced by whatever rank/suit the wild search
// decided it "is" (finalHandResult.wildSubstitution). A Joker's own
// rank/suit fields are meaningless leftover data from wherever it happened
// to land in the shuffled deck (rarity.js) — every function that detects a
// *pattern* (pairs, runs, suit clusters, rank sums, Aces/faces...) needs the
// substituted identity instead, or it ends up treating the same card as two
// contradictory things: e.g. a Joker that wild-completed a Pair as a Spade 3
// would still get counted as its literal, unrelated original suit for Suit
// Synergy — a real bug, not a design choice (DESIGN.md §3t fix). Exported so
// board.js can render the Joker's actual substituted rank/suit in the
// score-breakdown proof strip instead of that same meaningless leftover data.
export function logicalCardsFor(finalHand, finalHandResult) {
  if (!finalHandResult.hasWildJoker) return finalHand;
  return finalHand.map((card) =>
    card.rarity === 'joker'
      ? { rank: finalHandResult.wildSubstitution.rank, suit: finalHandResult.wildSubstitution.suit }
      : card,
  );
}

// The "proof" indices for the winning combination: which final-hand cards
// form the poker-hand pattern (contributingIndices — empty for High Card,
// all 5 for a full-board hand), and separately the longest consecutive
// run (for Three Straight / Near Miss). Computed once per scoreRun() call
// and used both to decide whether the rarity multiplier applies to the
// whole score (hasRareCardInWinningCombo below) and, exposed on the
// scoreRun() result, to drive the score-breakdown UI's card-highlight
// strip (DESIGN.md §3p) — "here are the actual cards that made this hand."
function comboIndicesFor(logicalCards, finalHandResult) {
  const handIndices = contributingIndices(logicalCards, finalHandResult);
  const run = longestConsecutiveRunIndices(logicalCards);
  return { handIndices, runIndices: run.indices, runLength: run.length };
}

// Owner request: the rarity multiplier should only apply to the WHOLE score
// when a rare card is genuinely part of what made the hand — not just
// present in it. "Part of the hand" means either (a) one of the cards
// forming the actual poker combination (contributingIndices — e.g. one of
// the two ranks in a Pair, not an unrelated kicker), or (b) one of the cards
// forming a Three Straight / Near Miss run (§3f), even when the overall
// hand is otherwise High Card — the owner explicitly included those as
// qualifying "real" combinations alongside standard poker hands. A rare
// card sitting as a dead kicker with no other synergy counts for neither.
function hasRareCardInWinningCombo(finalHand, comboIndices) {
  const rareIndices = [];
  finalHand.forEach((card, i) => {
    if (card.rarity) rareIndices.push(i);
  });
  if (rareIndices.length === 0) return false;

  if (comboIndices.handIndices.some((i) => rareIndices.includes(i))) return true;

  const { runLength, runIndices } = comboIndices;
  if ((runLength === 3 || runLength === 4) && runIndices.some((i) => rareIndices.includes(i))) return true;

  return false;
}

// 🎗️ Pity Points — a small, funny consolation bonus that grows the closer
// the run landed to a total whiff, and disappears entirely once the score
// clears a modest bar. Never large enough to matter strategically.
//
// The input is clamped at 0 because it CAN legitimately be negative: scoreRun
// passes `multipliedTotal - cardValue.total` (see its comment on why Card
// Value is excluded), and Double or Nothing's bust multiplies the total by 0
// while Card Value stays 50-350. Unclamped, that negative made the formula
// run straight past its own documented maximum — pityBonus(-350) returned
// 360, so a "Busted — Nothing" run paid out 270 points instead of the zero
// the modifier promises. Clamping keeps PITY_MAX_BONUS an actual maximum.
export function pityBonus(totalBeforePity) {
  const floored = Math.max(0, totalBeforePity);
  if (floored >= PITY_THRESHOLD) return 0;
  return Math.round(PITY_MAX_BONUS * (1 - floored / PITY_THRESHOLD));
}

/**
 * Scores a complete run.
 *
 * @param {object} params
 * @param {Card[]} params.originalHand - the 5 cards dealt before any discard
 * @param {Card[]} params.finalHand - the 5 cards after discard/draw
 * @param {number} params.discardedCount - how many cards were discarded
 * @param {number[]} [params.discardIndices] - which positions in originalHand
 *   were discarded; needed for discard-aware bonuses (e.g. No Waste). Omit
 *   to skip those.
 * @param {number} [params.maxDiscards] - the day's discard cap, for bonuses
 *   like Full Send that key off discarding the maximum allowed
 * @param {{chosenEV: number, bestEV: number, worstEV: number}} [params.evContext]
 *   - from ev-solver; omit to skip the Optimal Discard bonus (e.g. when the
 *   solver hasn't run yet)
 * @param {number|((finalHandResult: object, logicalFinalHand: Card[]) => number)} [params.modifierMultiplier]
 *   scoring multiplier from the day's modifier (DESIGN.md §4), either a
 *   plain number or a `(finalHandResult, logicalFinalHand) => number`
 *   callback — the callback form lets a modifier (e.g. Flush Frenzy, which
 *   only pays out when the final hand IS a flush) compute its multiplier from
 *   the already-evaluated `finalHandResult` below instead of the caller
 *   needing to run evaluateHand() a second time itself, which would double
 *   the cost of a wild hand's substitution search (§3h). The second argument
 *   is the LOGICAL hand (any Wild resolved to what it actually plays as), not
 *   the raw dealt cards — a suit/rank-reading modifier must never see a
 *   Wild's meaningless dealt suit. Defaults to 1
 *   (no-op) — owner request: modifiers should MULTIPLY the total when their
 *   condition is in the winning hand, not add flat points that get lost
 *   against the rank-scaled hand-rank table.
 */
export function scoreRun({
  originalHand,
  finalHand,
  discardedCount,
  discardIndices = [],
  maxDiscards = 3,
  evContext,
  modifierMultiplier: modifierMultiplierInput = 1,
}) {
  const originalHandResult = evaluateHand(originalHand);
  const finalHandResult = evaluateHand(finalHand);
  // Every pattern-detecting bonus below reads the LOGICAL hand (Joker
  // resolved to its actual wild substitution), not the raw dealt cards — see
  // logicalCardsFor()'s comment. rarityBonus()/discardedRarityBonus() below
  // deliberately stay on the raw hand: those reward the physical card's own
  // rolled rarity, which has nothing to do with what it wild-substituted to.
  const logicalFinalHand = logicalCardsFor(finalHand, finalHandResult);
  // Computed AFTER logicalFinalHand and handed the logical hand, not the raw
  // one. Suit Bonus counts cards of the day's bonus suit, so passing the raw
  // hand made it read a Wild card's meaningless dealt suit — the exact bug
  // §3t fixed for Suit Synergy, reintroduced here through a different door. A
  // Wild dealt as 2♥ but playing as a spade to complete a spade flush scored
  // as a heart on a hearts-bonus day.
  // The third argument carries what the hand alone cannot answer — Held Card
  // needs to know which SLOTS were thrown away, and a replacement occupies the
  // same index as the card it replaced.
  const modifierMultiplier =
    typeof modifierMultiplierInput === 'function'
      ? modifierMultiplierInput(finalHandResult, logicalFinalHand, { discardIndices })
      : modifierMultiplierInput;
  const flavor = flavorBonus(logicalFinalHand);
  const suitSynergy = suitSynergyBonus(logicalFinalHand);
  const cardValue = cardValueBonus(logicalFinalHand);

  const skillBonuses = {
    perfectKeep: perfectKeepBonus(discardedCount, finalHandResult),
    longShot: longShotBonus(originalHandResult, finalHandResult),
    cleanFinish: cleanFinishBonus(finalHandResult),
    optimalDiscard: evContext ? optimalDiscardBonus(evContext) : 0,
  };
  const skillTotal = Object.values(skillBonuses).reduce((a, b) => a + b, 0);

  const discardedCards = discardIndices.map((index) => originalHand[index]);
  const extraBonuses = evaluateBonuses({
    originalHand,
    finalHand: logicalFinalHand,
    discardedCards,
    discardedCount,
    maxDiscards,
    originalHandResult,
    finalHandResult,
  });
  const extraBonusTotal = extraBonuses.reduce((sum, bonus) => sum + bonus.points, 0);
  const rarity = rarityBonus(finalHand);
  const discardedRarity = discardedRarityBonus(discardedCards);
  const multiplier = rarityMultiplier(finalHand);

  const additiveTotal =
    finalHandResult.score +
    flavor.total +
    suitSynergy.total +
    cardValue.total +
    skillTotal +
    extraBonusTotal +
    rarity.total +
    discardedRarity.total;

  // ✨ Hand-Rarity Synergy Bonus (owner request, refined three times — see
  // DESIGN.md §3m/§3n/§3o). Two tiers, both gated on how many rare cards
  // are in the final hand and whether any of them actually helped build it:
  //
  //   1. If a rare card is genuinely part of the winning combination
  //      (hasRareCardInWinningCombo — a matched pair/trips/quads card, any
  //      card in a Flush/Straight/Full House/Straight Flush/Royal Flush, or
  //      part of a Three Straight/Near Miss run), the FULL stacked
  //      multiplier applies to the ENTIRE additive total — base hand score,
  //      flavor, suit synergy, card value, skill bonuses, extra bonuses,
  //      the rare cards' own flat bonuses, everything. This already scales
  //      with however many rare cards are present, since rarityMultiplier()
  //      stacks all of them multiplicatively regardless of which one
  //      qualified the hand.
  //   2. Otherwise — no rare card is part of anything — but if 2+ rare
  //      cards still landed in the hand (pure luck, unused), the stacked
  //      multiplier applies just to their own flat rarityBonus() total, not
  //      the rest of the score. Ensures "more than one rarity in the hand"
  //      always scores strictly more than a single stray rare card, even
  //      when neither is doing anything useful (owner request).
  //   3. A single rare card that isn't part of anything gets no multiplier
  //      effect at all — just its flat rarityBonus(), same as before.
  //
  // Owner's own example for tier 1: a Pair of 2s with an unrelated silver
  // 3♠ kicker gets no multiplier; the same hand with a second, normal 3♦
  // (making Two Pair, with the silver 3♠ now genuinely one of the pair)
  // multiplies the *whole* hand.
  const rareCardCount = finalHand.filter((card) => card.rarity).length;
  const comboIndices = comboIndicesFor(logicalFinalHand, finalHandResult);
  const wholeHandMultiply = hasRareCardInWinningCombo(finalHand, comboIndices);

  let multipliedTotal;
  if (wholeHandMultiply) {
    multipliedTotal = Math.round(additiveTotal * multiplier);
  } else if (rareCardCount >= 2) {
    const multipliedRarityTotal = Math.round(rarity.total * multiplier);
    multipliedTotal = additiveTotal - rarity.total + multipliedRarityTotal;
  } else {
    multipliedTotal = additiveTotal;
  }
  const handSynergyBonus = multipliedTotal - additiveTotal;

  // 🧭 Daily Modifier Multiplier (owner request: modifiers should MULTIPLY
  // the total when their condition is in the winning hand, not add flat
  // points that get lost against the rank-scaled hand-rank table). Applied
  // on top of the rarity-synergy multiply above — a Flush Frenzy day with a
  // rare card genuinely in the Flush stacks both multipliers, same "more
  // exciting things happening at once should feel like more" principle as
  // MULTI_RARITY_KICKER. Always 1 (no-op) when the modifier's own condition
  // isn't met — see modifiers.js's modifierScoringMultiplier() — so this is
  // safe to apply unconditionally.
  const preModifierTotal = multipliedTotal;
  multipliedTotal = Math.round(multipliedTotal * modifierMultiplier);
  const modifierBonusAmount = multipliedTotal - preModifierTotal;

  // Card Value (above) is unconditional — every hand gets it, so it isn't
  // "luck that needs rescuing" the way a whiffed hand-rank/bonus mix is.
  // Since it added a guaranteed floor to every run's total, pity is
  // evaluated with it subtracted back out (still included in the real,
  // displayed `total` below) — otherwise the new floor alone would push
  // most hands above PITY_THRESHOLD and make pity effectively unreachable.
  const pity = pityBonus(multipliedTotal - cardValue.total);
  const total = multipliedTotal + pity;

  return {
    handResult: finalHandResult,
    baseScore: finalHandResult.score,
    // The Joker resolved to its actual wild substitution (not its own
    // meaningless dealt rank/suit) — board.js uses this instead of the raw
    // final hand when rendering the score-breakdown's card-proof strip, so a
    // Joker that completed a Pair as, say, a Jack visibly shows as a Jack.
    logicalFinalHand,
    flavor,
    suitSynergy,
    cardValue,
    skillBonuses,
    extraBonuses,
    rarity,
    discardedRarity,
    multiplier,
    handSynergyBonus,
    handContributingIndices: comboIndices.handIndices,
    runIndices: comboIndices.runIndices,
    runLength: comboIndices.runLength,
    additiveTotal,
    pity,
    modifierMultiplier,
    modifierBonusAmount,
    total,
  };
}
