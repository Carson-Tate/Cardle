// Daily Modifiers (DESIGN.md §4) — first pass of 5, deliberately picked to
// exercise different hook points without inverting the hand hierarchy other
// systems (achievements, personality, meters) all assume "higher = better"
// against; then a second pass of 3 more (§4d): Second Look (a genuinely new
// two-round discard mechanic, owner request), Clean Slate (reuses the
// discardLimit hook), High Roller (reuses the scoring-multiplier hook,
// unconditionally this time); then Double or Nothing (§4e, owner request) — a
// third genuinely new mechanic, a 2-card peek followed by an all-or-nothing
// gamble. Lowball/Reverse Rankings and the rest of the full §4 roster are
// still a later pass, once this pattern is proven.
//
// Every day has exactly one active modifier (GAME_PLAN.md: "Every day
// should include one modifier that changes strategy") — there's no
// "vanilla" day. `getDailyModifier()` is the single entry point; everything
// else here is either the registry or private helpers.

import { hashSeed, createRng, shuffle, SUITS, suitGlyph } from './deck.js';
import { handStrengthIndex } from './hand-evaluator.js';

// Owner request: modifiers should MULTIPLY the total when their condition is
// in the winning hand, not add flat points that get lost against the
// rank-scaled hand-rank table (§3u/§3w put most winning totals in the
// thousands — a flat +60 stopped being noticeable). Both constants below are
// multiplier inputs, not point amounts — see modifierScoringMultiplier().
// Bumped higher per owner follow-up ("i think it should be a higher
// multiplier than it currently is") — a full 5-card suit match now nearly
// quadruples the total instead of just under doubling it.
const SUIT_BONUS_MULTIPLIER_PER_CARD = 0.5; // +50% per matching card in the final hand (a full 5-card flush of the bonus suit = 3.5x)
const FLUSH_FRENZY_MULTIPLIER = 4; // quadruples the WHOLE total, not just the Flush's own base score
const HIGH_ROLLER_MULTIPLIER = 1.5; // flat, unconditional — the first "always-on" scoring modifier
const SECOND_LOOK_ROUND_1_MAX_DISCARDS = 3; // matches the normal daily default
const SECOND_LOOK_ROUND_2_MAX_DISCARDS = 1; // fewer, per owner request: "the second should be less than the first"
// Double or Nothing (§4e, owner request) — the threshold hand quality needed
// to keep the double after committing to the gamble on just 2 cards' worth
// of information. Pair or better ("not just a bare High Card") lands ×2,
// reusing HIGH_CARD's own "deliberately worthless" framing (hand-evaluator.js
// §3s) so the "or nothing" half of the name isn't an arbitrary new cutoff —
// it's exactly the boundary the hand-rank table already treats as a miss.
const DOUBLE_OR_NOTHING_THRESHOLD_ID = 'PAIR';
const DOUBLE_OR_NOTHING_MULTIPLIER = 2;

// `type` says which system's hook this modifier plugs into:
//   'scoring'         → contributes via modifierScoringMultiplier() below (scoring.js's modifierMultiplier param)
//   'discardLimit'    → board.js reads `.maxDiscards` to override the default of 3
//   'lockedCard'      → board.js reads `.lockedIndex` (added at selection time, see getDailyModifier) to disable one card's discard toggle
//   'twoRoundDiscard' → board.js reads `.round1MaxDiscards`/`.round2MaxDiscards` and runs an extra discard/draw pass before the normal single-round flow (§4d)
//   'peekWager'       → board.js reveals only 2 cards, offers a wager, then reveals the rest with no discards (gamble) or a normal discard round (safe) (§4e)
export const MODIFIERS = [
  {
    id: 'suitBonus',
    emoji: '♠️',
    label: 'Suit Bonus',
    type: 'scoring',
    describe: (ctx) =>
      `Every ${suitGlyph(ctx.bonusSuit)} card in your final hand adds +${Math.round(SUIT_BONUS_MULTIPLIER_PER_CARD * 100)}% to your final score today.`,
  },
  {
    id: 'flushFrenzy',
    emoji: '🌊',
    label: 'Flush Frenzy',
    type: 'scoring',
    describe: () => `Flushes score ${FLUSH_FRENZY_MULTIPLIER}x today.`,
  },
  {
    id: 'oneSwap',
    emoji: '🔂',
    label: 'One Swap',
    type: 'discardLimit',
    maxDiscards: 1,
    describe: () => 'Only 1 discard allowed today.',
  },
  {
    id: 'fourthChance',
    emoji: '➕',
    label: 'Fourth Chance',
    type: 'discardLimit',
    maxDiscards: 4,
    describe: () => 'Discard up to 4 cards today.',
  },
  {
    id: 'lockedCard',
    emoji: '🔒',
    label: 'Locked Card',
    type: 'lockedCard',
    describe: () => "One of your cards is locked in — 🔒 — and can't be discarded today.",
  },
  {
    id: 'cleanSlate',
    emoji: '🧽',
    label: 'Clean Slate',
    type: 'discardLimit',
    maxDiscards: 5,
    describe: () => 'Discard up to all 5 cards today.',
  },
  {
    id: 'highRoller',
    emoji: '🎩',
    label: 'High Roller',
    type: 'scoring',
    describe: () => `Every hand scores ×${HIGH_ROLLER_MULTIPLIER} today, no matter what you land.`,
  },
  {
    id: 'secondLook',
    emoji: '👀',
    label: 'Second Look',
    type: 'twoRoundDiscard',
    round1MaxDiscards: SECOND_LOOK_ROUND_1_MAX_DISCARDS,
    round2MaxDiscards: SECOND_LOOK_ROUND_2_MAX_DISCARDS,
    describe: () =>
      `Two rounds of discards today — Round 1: discard up to ${SECOND_LOOK_ROUND_1_MAX_DISCARDS}, then draw. Round 2: discard up to ${SECOND_LOOK_ROUND_2_MAX_DISCARDS} more from your new hand, then lock in.`,
  },
  {
    id: 'doubleOrNothing',
    emoji: '🎲',
    label: 'Double or Nothing',
    type: 'peekWager',
    describe: () =>
      `You'll see 2 cards first, then choose: 🎲 go for it — no discards, but land at least a Pair and your score doubles, whiff into a bare High Card and it's zero — or 🛡️ play it safe, a completely normal round.`,
  },
];

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// Same project epoch as src/state/persistence.js's dayNumber() (not
// imported from there — src/core/ deliberately never depends on
// src/state/, which builds on top of it) — reused here purely so the
// rotation's own day-counter starts somewhere meaningful instead of 1970,
// keeping the loop below short.
const EPOCH = new Date('2026-07-27T00:00:00Z');

function daysSinceEpoch(date) {
  const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startOfEpoch = Date.UTC(EPOCH.getUTCFullYear(), EPOCH.getUTCMonth(), EPOCH.getUTCDate());
  return Math.max(0, Math.floor((startOfDay - startOfEpoch) / 86_400_000));
}

// Greedy sliding-window construction: day D's modifier is a seeded pick
// among whichever modifiers did NOT appear in the immediately preceding
// (roster size − 1) days — guaranteeing every window of `roster size`
// consecutive days is a full permutation (no repeats), which is the
// strongest guarantee possible with exactly this many modifiers. An earlier
// version of this function independently reshuffled fixed non-overlapping
// blocks of `roster size` days instead (bug, caught before shipping): that
// only guaranteed uniqueness *within* each block, not across the seam
// between blocks — two independently-shuffled blocks can easily place the
// same modifier 1-2 days apart straddling the boundary. Walking forward one
// day at a time and excluding the true trailing window avoids that
// regardless of alignment. Still a pure function of the date (no
// persistence) — just an in-memory loop from EPOCH forward, cheap even for
// a day count in the tens of thousands.
//
// Side effect of the guarantee, not a bug: with exactly `roster size`
// modifiers, excluding the previous (roster size − 1) days always leaves
// exactly ONE legal candidate once the window fills — there is no other
// way to guarantee a repeat-free 5-day window with only 5 possible values.
// The sequence settles into a fixed repeating cycle (period = roster size)
// after a short seeded ramp-up. This stops being deterministic once the
// roster grows past its own window size — more modifiers than the no-repeat
// target means real choice remains at every day.
function modifierForDay(day) {
  const windowSize = MODIFIERS.length;
  const recentIds = [];
  let modifier;
  for (let d = 0; d <= day; d++) {
    const excluded = new Set(recentIds);
    const candidates = MODIFIERS.filter((m) => !excluded.has(m.id));
    const rng = createRng(hashSeed(`cardle-modifier-day-${d}`));
    modifier = candidates[Math.floor(rng() * candidates.length)];
    recentIds.push(modifier.id);
    if (recentIds.length >= windowSize) recentIds.shift();
  }
  return modifier;
}

// A separate seed namespace from the deck's own dealing RNG (deck.js) — a
// modifier's own daily random pick (Suit Bonus's bonus suit, Locked Card's
// locked index) must never interleave with or consume from the hand-
// dealing RNG stream, or the existing daily-hand-determinism guarantee
// (and every test built around its exact call sequence) would silently
// break.
function modifierRng(date, purpose) {
  return createRng(hashSeed(`cardle-modifier-${isoDay(date)}-${purpose}`));
}

// Resolves a bare registry entry into the full shape callers get — filling
// in whichever extra random pick it needs (`bonusSuit` for Suit Bonus,
// `lockedIndex` for Locked Card) via the given `random()` source (0-1) and
// building the player-facing `description` from it. Shared by both
// `getDailyModifier` (seeded, once per real calendar day) and
// `buildModifierById` (plain `Math.random()`, for the admin panel's on-
// demand preview) — only one of the two `if` branches below ever fires for
// a given modifier, so a single random source is enough either way.
function resolveModifier(modifier, random) {
  const context = {};
  if (modifier.id === 'suitBonus') {
    context.bonusSuit = SUITS[Math.floor(random() * SUITS.length)];
  }
  if (modifier.id === 'lockedCard') {
    context.lockedIndex = Math.floor(random() * 5);
  }
  return { ...modifier, ...context, description: modifier.describe(context) };
}

// The single entry point for real daily play: today's (or `date`'s) active
// modifier, fully resolved and seeded from the calendar date.
export function getDailyModifier(date = new Date()) {
  const modifier = modifierForDay(daysSinceEpoch(date));
  const random = modifierRng(date, modifier.id);
  return resolveModifier(modifier, random);
}

// Test-mode admin panel only (owner request: "a thing in the admin page to
// change the modifiers") — builds a fully-resolved modifier straight from
// an id, for previewing any of the roster on demand instead of waiting for the
// calendar to cycle to it. Deliberately plain `Math.random()`, not date-
// seeded — this is an ad-hoc preview action, not "today's puzzle," same
// precedent as the admin panel's existing rarity Force buttons (`board.js`,
// `Math.floor(Math.random() * ...)` for their random slot pick).
export function buildModifierById(id) {
  const modifier = MODIFIERS.find((m) => m.id === id);
  return modifier ? resolveModifier(modifier, Math.random) : null;
}

// Returns a `(finalHandResult, finalHand) => number` callback — exactly the
// shape scoring.js's `modifierMultiplier` param accepts — for the day's
// scoring multiplier, applied to the WHOLE total (owner request: modifiers
// should multiply, not add flat points that get lost against the
// rank-scaled hand-rank table). Curried so board.js can just pass
// `modifierMultiplier: modifierScoringMultiplier(dailyModifier)` straight
// into scoreRun() without needing to evaluate the final hand itself first
// (that evaluation already happens once inside scoreRun(); doing it again
// here would double the cost of a wild-Joker hand's 52-substitution search,
// §3h). Always returns 1 (no-op) when the modifier's condition isn't
// actually in the winning hand — Suit Bonus with 0 matching cards, Flush
// Frenzy on a non-Flush, or a non-scoring modifier (discardLimit/lockedCard
// types, whose whole effect lives in board.js's discard rules instead) — so
// callers can always multiply by the result unconditionally.
export function modifierScoringMultiplier(dailyModifier) {
  return (finalHandResult, finalHand) => {
    if (!dailyModifier) return 1;
    if (dailyModifier.id === 'suitBonus') {
      const matchingCards = finalHand.filter((card) => card.suit === dailyModifier.bonusSuit).length;
      return 1 + matchingCards * SUIT_BONUS_MULTIPLIER_PER_CARD;
    }
    if (dailyModifier.id === 'flushFrenzy' && finalHandResult.id === 'FLUSH') {
      return FLUSH_FRENZY_MULTIPLIER;
    }
    if (dailyModifier.id === 'highRoller') {
      return HIGH_ROLLER_MULTIPLIER; // unconditional — the only modifier so far that isn't gated on a hand condition
    }
    if (dailyModifier.id === 'doubleOrNothing') {
      // `.wagered` isn't part of the resolved-modifier shape from
      // resolveModifier() — board.js sets it in place the moment the player
      // picks a side, the same pattern as Locked Card's `.lockedIndex`
      // living on the object it resolves at selection time. Declining the
      // wager (`wagered` false/undefined, including "haven't decided yet")
      // is always a no-op, same as every other modifier when its condition
      // isn't met.
      if (!dailyModifier.wagered) return 1;
      return handStrengthIndex(finalHandResult.id) >= handStrengthIndex(DOUBLE_OR_NOTHING_THRESHOLD_ID)
        ? DOUBLE_OR_NOTHING_MULTIPLIER
        : 0;
    }
    return 1;
  };
}
