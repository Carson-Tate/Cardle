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
import { handStrengthIndex, HAND_RANKS } from './hand-evaluator.js';
import { gameDayFor, gameDayNumber } from './game-day.js';

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
// §4f's batch (owner request). All four are multiplier inputs, sized against
// the existing ones rather than picked freshly: HIGH_ROLLER's unconditional
// 1.5x is the floor for "always available", and FLUSH_FRENZY's 4x is the
// ceiling for "one specific hand only".
//
// Held Card is conditional but easy — you simply decline to discard one slot —
// so it sits just above the unconditional floor.
const HELD_CARD_MULTIPLIER = 2;
// Rainbow needs all four suits among five cards, which actively fights every
// flush-shaped hand, so it pays more than Held Card.
const RAINBOW_MULTIPLIER = 2.5;
// Per-card like Suit Bonus, and deliberately smaller than its 0.5: roughly half
// the deck matches a parity, where only a quarter matches a suit.
const PARITY_MULTIPLIER_PER_CARD = 0.25;
// Hot Hand names ONE exact category, so it is priced like Flush Frenzy.
const HOT_HAND_MULTIPLIER = 4;

// The categories Hot Hand can name. HIGH_CARD is excluded because it is
// deliberately worth 0 (hand-evaluator.js §3s) — multiplying zero is still
// zero, so it would read as a broken day. ROYAL_FLUSH is excluded as
// unreachable often enough to matter: a day whose bonus effectively never pays
// out is indistinguishable from no modifier at all.
const HOT_HAND_EXCLUDED_IDS = new Set(['HIGH_CARD', 'ROYAL_FLUSH']);

// Every hand category that IS a flush. Flush Frenzy used to check
// `id === 'FLUSH'` exactly, which meant the two best flushes in the game —
// Straight Flush and Royal Flush — got no multiplier at all on a day whose
// own description reads "Flushes score 4x today." Landing the rarest hand in
// poker was silently worth less than landing an ordinary flush.
const FLUSH_HAND_IDS = new Set(['FLUSH', 'STRAIGHT_FLUSH', 'ROYAL_FLUSH']);

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
  // One Swap (a 1-discard day) was removed on owner request. Nothing migrates:
  // a stored admin override naming it is dropped by validateModifierOverrides
  // as an unknown id, which is exactly the "degrade to the rotation" behaviour
  // that validation exists for.
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
  // --- §4f (owner request) -------------------------------------------------
  {
    id: 'heldCard',
    emoji: '⭐',
    label: 'Held Card',
    // 'scoring', not a new type: the marked slot is a hint, not a rule. Unlike
    // Locked Card it stays fully discardable — you are being offered a bribe to
    // keep it, and the whole decision is whether the multiplier is worth the
    // hand you could have drawn instead.
    type: 'scoring',
    describe: () =>
      `One of your cards is marked ⭐. Keep it to the end and your whole score is multiplied by ×${HELD_CARD_MULTIPLIER} — discard it and you get nothing.`,
  },
  {
    id: 'rainbow',
    emoji: '🌈',
    label: 'Rainbow',
    type: 'scoring',
    describe: () =>
      `Land all four suits — ♠️ ♥️ ♦️ ♣️ — in your final hand and your score is multiplied by ×${RAINBOW_MULTIPLIER}.`,
  },
  {
    id: 'parity',
    emoji: '🔢',
    // The UNRESOLVED label, which is all the admin and test-mode pickers can
    // show: they list MODIFIERS directly, and which half this lands on is not
    // decided until resolveModifier() rolls it. `resolveLabel` below names the
    // actual day.
    //
    // Owner bug report: "the modifier 'even money' while the even/odd being
    // odd, should change the modifier name to 'odd money'". It read "Even
    // Money" over a description that rewarded odd cards — the describe() had
    // always handled both halves and only the label was hardcoded.
    label: 'Even / Odd Money',
    type: 'scoring',
    // Kept as ONE parameterised modifier rather than split into two entries.
    // Two would double how often a parity day comes up in the rotation, which
    // is a balance change nobody asked for — the same reasoning §4f used for
    // Hot Hand ("one parameterised modifier beats twelve near-identical ones").
    resolveLabel: (ctx) => (ctx.parity === 'odd' ? 'Odd Money' : 'Even Money'),
    describe: (ctx) =>
      `Every ${ctx.parity ?? 'even'}-ranked card in your final hand adds +${Math.round(
        PARITY_MULTIPLIER_PER_CARD * 100,
      )}% to your score today. ${ctx.parity === 'odd' ? 'Jacks and Kings count as odd; Queens and Aces are even.' : 'Queens and Aces count as even; Jacks and Kings are odd.'}`,
  },
  {
    id: 'hotHand',
    emoji: '🔥',
    label: 'Hot Hand',
    type: 'scoring',
    describe: (ctx) => `${ctx.hotHandLabel ?? 'One hand'} scores ×${HOT_HAND_MULTIPLIER} today — that exact hand, nothing else.`,
  },
  {
    id: 'flippedBoard',
    emoji: '🙃',
    label: 'Upside Down',
    // A leaderboard-only modifier: the FIRST one that changes nothing about how
    // a hand plays or scores. See modifierBoardIsAscending().
    type: 'leaderboardOrder',
    ascending: true,
    describe: () =>
      "Today's leaderboard is upside down — the LOWEST score sits on top. Your hand plays and scores exactly as normal, so career points still reward a big number. Winning today means going small.",
  },
];

// Game day, so the modifier changes at the same moment the hand does (§11l) —
// a modifier that rolled over hours before or after the new hand would be a
// visible inconsistency.
function isoDay(date) {
  return gameDayFor(date);
}

// Same project epoch as src/state/persistence.js's dayNumber() (not
// imported from there — src/core/ deliberately never depends on
// src/state/, which builds on top of it) — reused here purely so the
// rotation's own day-counter starts somewhere meaningful instead of 1970,
// keeping the loop below short.
const EPOCH = new Date('2026-07-27T00:00:00Z');

function daysSinceEpoch(date) {
  // gameDayNumber is 1-based from the same epoch; the rotation counts from 0.
  return Math.max(0, gameDayNumber(date) - 1);
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
  if (modifier.id === 'heldCard') {
    // Which SLOT carries the ⭐, same shape as Locked Card's lockedIndex. A slot
    // rather than a card identity, because "did you keep it?" is then exactly
    // "was this index discarded?" — no matching cards by rank and suit, and no
    // special case for a Wild whose logical suit differs from its dealt one.
    context.markedIndex = Math.floor(random() * 5);
  }
  if (modifier.id === 'parity') {
    context.parity = random() < 0.5 ? 'even' : 'odd';
  }
  if (modifier.id === 'hotHand') {
    // Picked from HAND_RANKS itself rather than a hand-written list, so a future
    // category is automatically eligible and can never fall out of step.
    const eligible = HAND_RANKS.filter((rank) => !HOT_HAND_EXCLUDED_IDS.has(rank.id));
    const pick = eligible[Math.floor(random() * eligible.length)];
    context.hotHandId = pick.id;
    context.hotHandLabel = pick.label;
  }
  // `label` resolves the same way `description` always has. It stays a plain
  // string on the returned object, so every consumer — the board banner, the
  // leaderboard's flipped-day note, the admin preview — keeps reading
  // `modifier.label` unchanged.
  return {
    ...modifier,
    ...context,
    label: modifier.resolveLabel ? modifier.resolveLabel(context) : modifier.label,
    description: modifier.describe(context),
  };
}

// The single entry point for real daily play: today's (or `date`'s) active
// modifier, fully resolved and seeded from the calendar date.
//
// `overrideId` (DESIGN.md §11g) lets the admin page pin a specific modifier to a
// specific day via server-side config. It stays an optional ARGUMENT rather than
// this module reading config itself, because src/core/ never touches the network
// — the caller fetches config and passes the answer in, so this function remains
// pure and the whole rotation stays unit-testable without a database.
//
// An unknown id is ignored rather than throwing: config is read by every
// player's client on boot, so a stale or mistyped override must degrade to the
// normal rotation instead of breaking everyone's game.
export function getDailyModifier(date = new Date(), overrideId = null) {
  const overridden = overrideId ? MODIFIERS.find((m) => m.id === overrideId) : null;
  const modifier = overridden ?? modifierForDay(daysSinceEpoch(date));
  // Still seeded from the date, so an overridden Suit Bonus / Locked Card gets a
  // stable bonus suit / locked index for that day rather than a new one on every
  // page load.
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
  // The third argument is a CONTEXT bag rather than more positional parameters:
  // Held Card needs to know which slots were thrown away, which is not derivable
  // from the final hand alone (a replacement occupies the same index). Optional
  // and defaulted, so every existing caller and test keeps working unchanged.
  return (finalHandResult, finalHand, { discardIndices = [] } = {}) => {
    if (!dailyModifier) return 1;
    if (dailyModifier.id === 'suitBonus') {
      const matchingCards = finalHand.filter((card) => card.suit === dailyModifier.bonusSuit).length;
      return 1 + matchingCards * SUIT_BONUS_MULTIPLIER_PER_CARD;
    }
    if (dailyModifier.id === 'flushFrenzy' && FLUSH_HAND_IDS.has(finalHandResult.id)) {
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
    if (dailyModifier.id === 'heldCard') {
      // Kept means simply "not discarded". Checked against the discard list
      // rather than by looking for the card in the final hand, because a
      // replacement lands in the same slot — the final hand alone cannot tell
      // you whether index 3 is the card you started with.
      const kept = !discardIndices.includes(dailyModifier.markedIndex);
      return kept ? HELD_CARD_MULTIPLIER : 1;
    }
    if (dailyModifier.id === 'rainbow') {
      // Reads the LOGICAL hand, so a Wild counts as the suit it actually plays
      // as — the same rule Suit Bonus follows, and the reason it can complete a
      // rainbow rather than being stuck with its meaningless dealt suit.
      const suits = new Set(finalHand.map((card) => card.suit).filter(Boolean));
      return suits.size === SUITS.length ? RAINBOW_MULTIPLIER : 1;
    }
    if (dailyModifier.id === 'parity') {
      const wantEven = dailyModifier.parity !== 'odd';
      const matching = finalHand.filter(
        (card) => Number.isFinite(card.rank) && (card.rank % 2 === 0) === wantEven,
      ).length;
      return 1 + matching * PARITY_MULTIPLIER_PER_CARD;
    }
    if (dailyModifier.id === 'hotHand') {
      // EXACT category, deliberately — "Two Pair scores x4 today" means Two
      // Pair, and landing Three of a Kind instead is a different (better) hand
      // that had its own reward. Contrast Flush Frenzy, which spans every flush
      // because Straight and Royal Flush ARE flushes; there is no equivalent
      // family relationship here.
      return finalHandResult.id === dailyModifier.hotHandId ? HOT_HAND_MULTIPLIER : 1;
    }
    return 1;
  };
}

/**
 * Whether the DAILY leaderboard should rank lowest-first (owner request:
 * "flipped leaderboard day, normal draw but lowest score is on top for that
 * day"). The only modifier hook that touches no part of playing a hand.
 *
 * Scoring is deliberately untouched: the score a player earns, the grade it
 * gets, and the career points it adds are all exactly what they would be on any
 * other day. Only who sits at the top of that one board changes — which is what
 * makes it a real strategic inversion (topping the board and maximising career
 * points pull in opposite directions) without disturbing achievements,
 * personality, the decision rating or the EV solver, every one of which assumes
 * higher is better. That assumption is why DESIGN.md deferred full Lowball.
 */
export function modifierBoardIsAscending(dailyModifier) {
  return dailyModifier?.type === 'leaderboardOrder' && dailyModifier.ascending === true;
}
