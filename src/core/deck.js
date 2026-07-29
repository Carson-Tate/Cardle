// Card representation: { rank: 2-14 (14 = Ace), suit: 'S'|'H'|'D'|'C', rarity: null | 'bronze' | 'silver' | 'gold' | 'joker' }

import { RARITIES, TOTAL_SPECIAL_CHANCE, jokerTierForRoll } from './rarity.js';

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

// Deterministic 32-bit hash of a string (FNV-1a), used to turn a date
// string into a numeric seed so every player gets the same deal that day.
export function hashSeed(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function dailySeed(date = new Date()) {
  const isoDate = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC day
  return hashSeed(`cardle-${isoDate}`);
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
// consumed right after the shuffle, so the same daily seed always deals the
// same rarities to everyone. Two rng() calls per card, always both consumed
// regardless of outcome (rarity roll, then a joker-sub-tier roll) so the
// sequencing a given seed produces never depends on which cards happened to
// land rare — only *which* rarity/tier a card gets does.
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
    const rarity = rarityForRoll(rng(), luckMultiplier);
    const jokerTierRoll = rng();
    const jokerTier = rarity === 'joker' ? jokerTierForRoll(jokerTierRoll) : null;
    return { ...card, rarity, jokerTier };
  });
  return {
    hand: withRarity.slice(0, count),
    drawPile: withRarity.slice(count),
  };
}
