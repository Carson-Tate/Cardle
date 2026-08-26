// Card representation: { rank: 2-14 (14 = Ace), suit: 'S'|'H'|'D'|'C',
//   rarity: null | 'bronze' | 'silver' | 'gold' | 'diamond', wild: boolean }
// `wild` is INDEPENDENT of `rarity` (rarity.js) — a wild can be plain or any
// tier. Older stored cards instead carry `rarity: 'joker'` with a `jokerTier`;
// read wildness through `isWild()` so both shapes work.

import { RARITIES, TOTAL_SPECIAL_CHANCE, WILD_CHANCE } from './rarity.js';

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function rankLabel(rank) {
  return RANK_LABELS[rank] ?? String(rank);
}

export function suitGlyph(suit) {
  return SUIT_GLYPHS[suit];
}

export function cardId(card) {
  return `${rankLabel(card.rank)}${card.suit}`;
}

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// mulberry32: small, fast, deterministic PRNG — good enough for shuffling,
// not cryptographic. Same seed always produces the same sequence.
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 32-bit hash of a string (FNV-1a) — turns any string (a date,
// a test-mode label, ...) into a reproducible numeric seed.
export function hashSeed(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// A deterministic seed for a UTC calendar day.
//
// ⚠️ THIS IS NOT THE GAME DAY, and nothing in the shipped game calls it. The
// modifier rotation and the caption pools both moved to `gameDayFor()` (§11l),
// which rolls at 19:00 New York rather than midnight UTC — this comment used to
// claim they derived their seeds "the same way" as this function, and that is
// how a UTC/game-day mismatch got copied into the modifier override lookup and
// silently un-pinned a scheduled modifier (§11q).
//
// Kept because the tests use it as a stable, dependency-free seed source, and
// because "identical for every player on a given UTC day" is still a coherent
// thing to want. If you need "the same for everyone playing TODAY'S hand", use
// `gameDayFor()` — not this. The player's own deal uses neither: each player
// gets their own random hand via persistence.js's getOrCreateTodaySeed().
export function dailySeed(date = new Date()) {
  const isoDate = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC day — see above
  return hashSeed(`cardle-${isoDate}`);
}

// A one-off, non-reproducible seed sourced from wall-clock time and
// Math.random() together — used anywhere a *fresh* random deal is wanted
// rather than a reproducible one (a player's daily hand, the test-mode admin
// panel's "redeal" button).
export function freshSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/**
 * The most cards a stacked deal may pin (DESIGN.md §11al) — 5 in the opening
 * hand, 5 off the top of the draw pile. Five draws covers every single-round
 * day including the modifiers that raise the cap to 4 or 5; a Second Look
 * round two draws normally, which is stated in the admin panel rather than
 * silently true.
 */
export const STACK_HAND_SIZE = 5;
export const STACK_MAX_DRAWS = 5;

const RARITY_IDS = new Set(RARITIES.map((tier) => tier.id));

/**
 * Validates and normalizes an admin-authored stacked deal.
 *
 * ADMIN-AUTHORED CONTENT IS UNTRUSTED CONTENT (§11y's rule, stated there for
 * the word bank and true here for the same reason): this JSON is written by
 * one privileged account and then flows into a scorer on the server and a
 * renderer in someone else's browser. A malformed row must be REFUSED, not
 * partly believed — a hand of four cards would throw inside evaluateHand and
 * take the board down with it, and a duplicated card would let the same
 * physical card exist twice in one deal.
 *
 * Validated on READ as well as on write, for the reason §11g gives: the row
 * could predate a shape change or be hand-edited in the SQL editor, and both
 * the board and the Edge Function read it at the worst possible moment.
 *
 * @returns {{ok: boolean, errors: string[], deal: {hand: object[], draws: object[]}|null}}
 */
export function normalizeStackedDeal(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['no stacked deal'], deal: null };

  const hand = Array.isArray(raw.hand) ? raw.hand : [];
  // PER-SLOT, NOT IN DISCARD ORDER (owner: "i pick the third slot as what i
  // want it because they will discard the third slot"). `slotDraws[i]` is the
  // card that arrives if hand slot `i` is thrown away — so pinning a straight
  // means putting the card you want opposite the card they will drop, and
  // nothing depends on guessing how many cards they discard or in what order.
  //
  // The first shape stored an ORDERED draw pile, which only did what you
  // wanted if the player discarded exactly the slots you expected. Old rows
  // carry `draws` and no `slotDraws`; they normalize to "no pinned
  // replacements" rather than being reinterpreted, because silently treating a
  // positional list as a slot map would deal the right cards to the wrong
  // slots — worse than not rigging at all.
  const slots = Array.isArray(raw.slotDraws) ? raw.slotDraws : [];
  if (hand.length !== STACK_HAND_SIZE) errors.push(`the opening hand must be exactly ${STACK_HAND_SIZE} cards`);
  if (slots.length > STACK_HAND_SIZE) errors.push(`there are only ${STACK_HAND_SIZE} slots to pin a replacement for`);

  const seen = new Set();
  const readCard = (card, where) => {
    const rank = Number(card?.rank);
    const suit = String(card?.suit ?? '');
    if (!RANKS.includes(rank)) errors.push(`${where}: "${card?.rank}" is not a rank`);
    if (!SUITS.includes(suit)) errors.push(`${where}: "${card?.suit}" is not a suit`);
    // An unknown tier is refused rather than dropped to null: silently
    // downgrading a card the admin deliberately made Diamond would change the
    // score without saying so.
    const rarity = card?.rarity == null || card.rarity === '' ? null : String(card.rarity);
    if (rarity !== null && !RARITY_IDS.has(rarity)) errors.push(`${where}: "${rarity}" is not a rarity tier`);

    const key = `${rank}${suit}`;
    // ONE PHYSICAL DECK. A card pinned into the hand cannot also be pinned as a
    // replacement, or discarding would deal you a card that is already on the
    // table.
    if (seen.has(key)) errors.push(`${where}: ${rankLabel(rank)}${suitGlyph(suit) ?? suit} is used more than once`);
    seen.add(key);
    return { rank, suit, rarity, wild: card?.wild === true };
  };

  const cleanHand = hand.map((card, i) => readCard(card, `hand slot ${i + 1}`));
  // Length-5 and sparse: index IS the hand slot, so a hole must stay a hole.
  const cleanSlots = Array.from({ length: STACK_HAND_SIZE }, (_, i) =>
    slots[i] == null ? null : readCard(slots[i], `slot ${i + 1} replacement`),
  );

  if (errors.length > 0) return { ok: false, errors, deal: null };
  return { ok: true, errors: [], deal: { hand: cleanHand, slotDraws: cleanSlots } };
}

/**
 * Applies one round of discards — the single definition of what replaces what.
 *
 * EXTRACTED BECAUSE THERE WERE FOUR COPIES: two in board.js (the live discard
 * and the already-played re-render) and two in verify-run.js (the mid-round and
 * final-round replays). Four copies of "which card lands where" is exactly the
 * shape §11y warned about — two functions answering the same question will
 * eventually disagree — and here a disagreement means the player is shown one
 * hand and paid for another.
 *
 * WITHOUT `slotDraws` THIS IS BYTE-IDENTICAL to the logic it replaces. Both
 * callers sort their indices ascending (board.js before scoring, normalizeRound
 * on the server), and this consumes the pile in ascending slot order, so every
 * ordinary deal maps exactly as before.
 *
 * A pinned replacement is dealt ONCE. Second Look discards twice, and a slot
 * thrown away in both rounds takes its pinned card in round one and an ordinary
 * one in round two — the alternative is the same card arriving twice, which no
 * deck can do.
 *
 * @returns {{hand: object[], pile: object[], slotDraws: (object|null)[]|null}}
 */
export function applyDiscards({ hand, pile, indices, slotDraws = null }) {
  let taken = 0;
  const remaining = slotDraws ? [...slotDraws] : null;
  const nextHand = hand.map((card, index) => {
    if (!indices.includes(index)) return card;
    const pinned = remaining?.[index] ?? null;
    if (pinned) {
      remaining[index] = null;
      return pinned;
    }
    return pile[taken++];
  });
  return { hand: nextHand, pile: pile.slice(taken), slotDraws: remaining };
}

/**
 * Builds a deal whose opening hand — and the top of whose draw pile — were
 * chosen by an admin instead of rolled (§11al).
 *
 * DETERMINISTIC FROM `seed`, WHICH IS THE ENTIRE POINT. The board and
 * `verifyAndScoreRun` both call this with the same row's seed and the same
 * stored stack, so they build the identical deal. Anything random in here that
 * did not come from `seed` — `freshSeed()`, `Math.random()` — would make the
 * server reject every rigged run as a mismatch, and it would do so only in
 * production, where the two halves are actually different machines. (The
 * test-mode Custom Hand Builder in board.js CAN use a fresh seed, because
 * nothing ever verifies it.)
 *
 * Cards the admin did not pin are drawn from the rest of the deck, shuffled
 * and rarity-rolled from that same seed, so an un-pinned draw is an ordinary
 * random card rather than a blank.
 */
export function dealFromStack(seed, stack) {
  const { ok, deal } = normalizeStackedDeal(stack);
  if (!ok) throw new Error('dealFromStack needs a valid stacked deal');

  const rng = createRng(seed);
  const pinnedCards = [...deal.hand, ...deal.slotDraws.filter(Boolean)];
  const pinned = new Set(pinnedCards.map((card) => `${card.rank}${card.suit}`));
  const rest = shuffle(
    createDeck().filter((card) => !pinned.has(`${card.rank}${card.suit}`)),
    rng,
  ).map((card) => {
    // Same two-calls-per-card shape dealHand uses, so the filler behaves like
    // any other draw.
    const rarity = rarityForRoll(rng());
    const wild = rng() < WILD_CHANCE;
    return { ...card, rarity, wild };
  });

  // The pinned replacements are NOT pushed onto the front of the pile — they
  // are handed back separately and consulted by slot (see applyDiscards). The
  // pile holds only the cards an un-pinned discard draws from.
  return { hand: deal.hand, drawPile: rest, slotDraws: deal.slotDraws };
}

export function shuffle(deck, rng) {
  const shuffled = deck.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Maps a 0-1 roll to a rarity tier id (or null for common), walking
// RARITIES common-to-rarest and taking the first tier whose cumulative
// range the roll falls in. Pure/exported so it's directly testable without
// needing to reverse-engineer an RNG sequence.
//
// `luckMultiplier` (default 1, i.e. every tier's own real chance, unchanged
// from before this existed) scales the COMBINED chance of landing on ANY
// rarity at all — capped at 1 (guaranteed some rarity) — while preserving
// each tier's RELATIVE share of that combined chance, the same
// proportional-renormalization jokerTierForRoll() already uses for a
// Joker's own sub-tier. This replaced an earlier, broken approach (owner bug
// report: "i set the luck slider to 500x and i only get bronze cards, rarely
// silver gold or diamond") that shrank the RAW roll by dividing it by
// luckMultiplier before this same lookup — since every tier's cumulative
// boundary sits early in [0, 1) and bronze is checked first, any
// luckMultiplier past about 14x (1 / bronze's own 0.07 chance) shrank the
// roll's whole possible range to fit entirely inside bronze's slice, making
// bronze literally the ONLY reachable outcome — a NULLIFIED chance at every
// rarer tier, and one that got LESS fair as luck went UP, the opposite of
// what a luck slider should do. Scaling the combined chance instead of the
// roll fixes this: a high luckMultiplier makes EVERY tier more likely,
// still rarer-tiers-rarer relative to each other, same as luck=1.
export function rarityForRoll(roll, luckMultiplier = 1) {
  const scaledTotal = Math.min(TOTAL_SPECIAL_CHANCE * luckMultiplier, 1);
  let cumulative = 0;
  for (const tier of RARITIES) {
    const scaledChance = luckMultiplier === 1 ? tier.chance : scaledTotal * (tier.chance / TOTAL_SPECIAL_CHANCE);
    cumulative += scaledChance;
    if (roll < cumulative) return tier.id;
  }
  return null;
}

// Draws the first `count` cards as the opening hand and returns both the
// hand and the remaining deck (the draw pile replacements come from). Every
// card's rarity is rolled here too, deterministically from the same seed —
// consumed right after the shuffle, so a given seed always deals the exact
// same hand and rarities again. Two rng() calls per card, always both consumed
// regardless of outcome (rarity roll, then a wildness roll) so the
// sequencing a given seed produces never depends on which cards happened to
// land rare — only *which* rarity/tier a card gets does.
//
// `luckMultiplier` also scales the wild chance, so the admin panel's luck
// slider previews wilds as readily as it previews rare tiers.
//
// `luckMultiplier` (default 1, i.e. no effect) is forwarded straight to
// rarityForRoll()'s own proportional scaling — see that function's comment
// for why the roll itself is no longer shrunk before the lookup (that
// approach broke down catastrophically at high luckMultiplier values, owner
// bug report). Only ever passed by the test-mode admin panel (board.js) so
// real/daily deals are always exactly as fair as before; this exists purely
// so rarities can be previewed on demand without hunting through seeds.
export function dealHand(seed, count = 5, { luckMultiplier = 1 } = {}) {
  const rng = createRng(seed);
  const shuffled = shuffle(createDeck(), rng);
  const withRarity = shuffled.map((card) => {
    // STILL EXACTLY TWO rng() CALLS PER CARD, always both consumed. The second
    // used to pick a joker's sub-tier and now decides wildness, but keeping the
    // count identical means a given seed deals the same ranks and suits as it
    // always did — only what those cards rolled has changed.
    const rarity = rarityForRoll(rng(), luckMultiplier);
    const wild = rng() < Math.min(WILD_CHANCE * luckMultiplier, 1);
    return { ...card, rarity, wild };
  });
  return {
    hand: withRarity.slice(0, count),
    drawPile: withRarity.slice(count),
  };
}
