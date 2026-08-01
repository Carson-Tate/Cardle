// Card rarity tiers (owner request): a rare cosmetic/bonus tier a dealt or
// drawn card can roll into, independent of its rank/suit. Single source of
// truth — deck.js rolls against `chance`, scoring.js awards points via
// pointsForRarity(), card-view.js/board.js use `emoji`/`label` for rare-card
// styling and the score breakdown.
//
// basePoints/perRankPoints/multiplier are ODDS-CALIBRATED (owner request:
// "do the math about the odds of different poker hands and compare them to
// the odds of the rarities" — see DESIGN.md §3m for the full derivation).
// The short version: with 5 cards independently rolling a `chance` each,
// the probability a hand contains AT LEAST one card of a tier works out to
// 1-(1-chance)^5. Comparing that to real 5-card poker hand probabilities
// (Two Pair 4.75%, Full House 0.14%, ...) shows gold (4.90%/hand) is
// actually about as rare as Two Pair, and a Joker (~1.0%/hand) sits between
// Three of a Kind and a Straight — nowhere near as rare as the old flat
// bonuses implied. Each tier's basePoints/perRankPoints is set so its
// *average* value (around rank 8) lands where that same probability would
// land on the hand-rank score table (hand-evaluator.js) — a bronze card is
// worth a bit more than a Pair, gold about a Two Pair, etc. This is
// deliberately just the "you got a rare card" reward, kept modest and
// unconditional — see scoring.js's handSynergyBonus for the *much* bigger
// payoff that requires the card to genuinely be part of a scoring
// combination (owner request, §3n).
//
// `multiplier` is a SEPARATE, multiplicative effect (scoring.js) applied to
// the whole run's total when a rare card is part of the actual winning
// combination, and stacks multiplicatively when more than one rare card
// qualifies (bronze+gold = 1.2 * 2.5).
//
// Joker is genuinely wild for hand evaluation (see hand-evaluator.js) and
// deliberately does NOT have its own separate rarity ladder (owner request:
// "i want the joker to just have the same rarities as the normal cards,
// bronze, silver and gold") — a Joker card additionally rolls which of
// Bronze/Silver/Gold it "is" for scoring purposes (deck.js, jokerTierForRoll
// below), reusing these exact tier objects. Its points stay flat regardless
// of the joker's own underlying rank, same reasoning as before: the rank is
// an implementation detail of the wild search, not something the player
// experiences directly.
//
// Diamond (owner request: "added rarities higher than gold like diamond at
// first to start, it should give a very insanely high multiplier but also
// be very rare") — deliberately rarer than Joker itself (0.1%/card vs
// Joker's 0.2%), the single rarest per-card roll in the game. Its
// basePoints/perRankPoints follow the same odds-calibration as the other
// tiers (DESIGN.md §3m/§3o): at 0.1%/card, a hand's chance of containing
// one works out to ~0.5%, which lands almost exactly between Three of a
// Kind and a Straight on the surprisal-interpolated hand-score curve — a
// fair value of ~1,410 at rank 8, hence basePoints=850/perRankPoints=70.
// Its ×15 multiplier is NOT odds-derived the same way — "insanely high" was
// an explicit design ask, not a probability-matching exercise, so it's a
// deliberate large jump over Gold's ×2.5 (this is the first tier above
// Gold; "first to start" implies more may follow later).
//
// Ordered common-to-rarest; rollRarity() in deck.js walks this list in
// order, so it doubles as the tier-boundary order for the cumulative roll.
export const RARITIES = [
  { id: 'bronze', emoji: '🥉', label: 'Bronze', chance: 0.07, basePoints: 150, perRankPoints: 12, multiplier: 1.2 },
  { id: 'silver', emoji: '🥈', label: 'Silver', chance: 0.03, basePoints: 210, perRankPoints: 18, multiplier: 1.5 },
  { id: 'gold', emoji: '🥇', label: 'Gold', chance: 0.01, basePoints: 300, perRankPoints: 25, multiplier: 2.5 },
  { id: 'diamond', emoji: '💎', label: 'Diamond', chance: 0.001, basePoints: 850, perRankPoints: 70, multiplier: 15 },
];

// ── WILD IS NO LONGER A RARITY TIER ────────────────────────────────────────
// Owner: "i want wilds to be normal cards that appear, not just rare cards, but
// i also still want it to have less of a chance of showing than a normal card by
// a little. it can still spawn with rarities tho."
//
// So wildness became its own axis. A card now rolls `wild` INDEPENDENTLY of
// `rarity`, which means a Wild can be plain, or Bronze, or Diamond — combinations
// the old model could not express, because being wild WAS the rarity.
//
// The frequency is the owner's pick of "like a 53rd card in the deck": an
// ordinary card is 1/52 = 1.92%, so 1.8% is a shade under it. That works out to
// a Wild in roughly one hand in eleven, against one in a hundred before.
export const WILD_CHANCE = 0.018;

// Every Wild pays this flat, whatever it rolled for rarity (owner's pick over
// "no bonus"). Flat rather than rank-scaled for the reason the old joker tier
// was: a wild's underlying rank is an implementation detail of the substitution
// search, not something the player experiences. Sized at roughly what a Bronze
// pays, which is what the choice described.
//
// Deliberately NO multiplier of its own. Wilds are ~9x more common than they
// were, and their real payoff is completing a hand they had no business
// completing — stacking a whole-score multiplier on top of that as well would
// make them the dominant scoring force rather than a lucky break. A wild that
// ALSO rolls Bronze/Gold/etc still gets that tier's multiplier, because that is
// the rarity paying out, not the wildness.
export const WILD_POINTS = 200;

// The legacy 'joker' rarity, kept out of RARITIES so nothing can roll it again,
// but still resolvable by id.
//
// STORED RESULTS PREDATE THIS SPLIT. Every hand already saved — in localStorage
// and in `daily_plays` — has its wild recorded as `rarity: 'joker'` with a
// `jokerTier`, and those rows are still read back: the profile's hand history
// renders them, and the leaderboard RE-EVALUATES them to name the hand (§11n).
// Drop this and every historical wild silently stops being wild, quietly
// downgrading old hands on the boards.
// The label is "Wild" rather than "Joker" per the owner's "rename the joker to a
// wild, i think it makes more sense" — a DISPLAY-only rename. The internal id
// stays 'joker' on purpose: renaming it would silently mismatch every
// already-saved result that recorded `rarity: 'joker'`. (This note used to sit
// in the RARITIES array above, where it had been stranded next to the Diamond
// tier after the joker entry it described was removed — so it read as
// documentation for Diamond, which it has nothing to do with.)
export const LEGACY_JOKER_RARITY = { id: 'joker', emoji: '🃏', label: 'Wild', chance: 0 };

/**
 * Whether a card plays as wild — the ONE definition, used by the evaluator, the
 * scorer and both card renderers.
 *
 * Accepts both shapes on purpose: the new `wild` flag, and the old
 * `rarity: 'joker'` that every stored hand still uses.
 */
export function isWild(card) {
  return Boolean(card) && (card.wild === true || card.rarity === 'joker');
}

export const RARITY_BY_ID = Object.fromEntries(RARITIES.map((tier) => [tier.id, tier]));

// LEGACY. A wild used to roll a nested "which tier am I" sub-roll, because being
// wild occupied the rarity slot itself. Wilds now roll rarity directly like any
// other card, so nothing produces a jokerTier any more — this survives only to
// keep already-stored results scoring the way they did when they were played.
const JOKER_SUB_TIERS = RARITIES;
const JOKER_SUB_TIER_WEIGHT_TOTAL = JOKER_SUB_TIERS.reduce((sum, tier) => sum + tier.chance, 0);

// Combined odds of landing on any special tier at all, for reference/tests.
export const TOTAL_SPECIAL_CHANCE = RARITIES.reduce((sum, tier) => sum + tier.chance, 0);

// Maps a 0-1 roll to which of Bronze/Silver/Gold/Diamond a Joker "is",
// walking the same tiers in the same order as rarityForRoll() but
// renormalized to their relative proportions (bronze:silver:gold:diamond =
// 70:30:10:1) so "most Jokers are bronze-flavored, a Diamond Joker is
// vanishingly rare" reads the same way rarity does everywhere else in the
// game.
//
// NEVER CALLED ANY MORE. RARITIES no longer contains a 'joker' entry, so
// rarityForRoll() cannot return one and nothing can "roll joker on the outer
// tier roll" — grep confirms zero call sites in src/. Kept, like deck.js's
// dailySeed, only so the old distribution stays documented and testable for
// reasoning about stored rows that still carry a jokerTier. Delete it if that
// stops being useful; nothing in the shipped game depends on it.
export function jokerTierForRoll(roll) {
  let cumulative = 0;
  for (const tier of JOKER_SUB_TIERS) {
    cumulative += tier.chance / JOKER_SUB_TIER_WEIGHT_TOTAL;
    if (roll < cumulative) return tier.id;
  }
  return JOKER_SUB_TIERS[JOKER_SUB_TIERS.length - 1].id; // floating-point safety net at roll ~1
}

// Bronze(rank2) ≈ 174 ... Diamond(rank14) = 1830 ... a Gold Joker = 300
// flat, regardless of rank — jokerTier selects which non-joker tier's
// basePoints applies. See scoring.js rarityBonus().
export function pointsForRarity(rarityId, rank, jokerTier = null) {
  // Legacy stored wilds only — nothing rolls this id any more.
  if (rarityId === 'joker') {
    const tier = RARITY_BY_ID[jokerTier] ?? RARITY_BY_ID.bronze;
    return tier.basePoints;
  }
  const tier = RARITY_BY_ID[rarityId];
  if (!tier) return 0;
  return tier.basePoints + tier.perRankPoints * rank;
}

// The multiplicative factor a single rare card contributes (scoring.js's
// rarityMultiplier() stacks these across every rare card in the hand).
export function multiplierForRarity(rarityId, jokerTier = null) {
  // Legacy stored wilds only — see pointsForRarity.
  if (rarityId === 'joker') {
    const tier = RARITY_BY_ID[jokerTier] ?? RARITY_BY_ID.bronze;
    return tier.multiplier;
  }
  const tier = RARITY_BY_ID[rarityId];
  return tier ? tier.multiplier : 1;
}
