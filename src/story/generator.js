import { hashSeed, createRng, shuffle, rankLabel, suitGlyph } from '../core/deck.js';
import { evaluateHand, handStrengthIndex } from '../core/hand-evaluator.js';
import { FRAGMENTS } from './templates.js';
import { gameDayFor } from '../core/game-day.js';

// Every function that reads a fragment pool takes `fragments` as its LAST
// argument, defaulting to the built-in FRAGMENTS. That's how the admin-editable
// word bank (DESIGN.md §11g) reaches this module without src/story/ or
// src/core/ ever touching the network: the caller merges config over the
// built-ins (core/game-config.js's mergeWordBank) and passes the result down.
// Positional and last so every existing call site keeps working unchanged.

// Two Pair or better counts as a genuine win for captioning purposes — the
// one slot ("ending") that reacts to the actual hand, per owner request
// ("loosely tied" rather than fully decoupled). Every other slot ignores
// the hand entirely; see templates.js.
function endingKeyFor(finalHandResult) {
  return handStrengthIndex(finalHandResult.id) >= handStrengthIndex('TWO_PAIR') ? 'good' : 'bad';
}

// How many options a dropdown actually shows on a given day, rotated out of
// each slot's (larger, and growing) master vocabulary in templates.js —
// owner request: "i would like for it to not be the same words everyday so
// there is room for creativity." A pool smaller than this just shows
// entirely, nothing to rotate.
const DAILY_POOL_SIZE = 16;

// UTC calendar day, matching dailySeed()'s convention in deck.js — captions
// rotate once per real day, in lockstep with the actual daily puzzle, the
// same for every player that day.
// Game day (§11l), so the caption vocabulary rotates in lockstep with the hand
// and the modifier rather than at midnight UTC.
function isoDay(date) {
  return gameDayFor(date);
}

// Deterministically picks up to DAILY_POOL_SIZE distinct options from
// `pool`, reseeded once per calendar day AND per slot (so slots don't all
// rotate in lockstep with each other) — reuses the exact same seeded-
// shuffle machinery the daily hand deal itself uses (deck.js's
// createRng/shuffle), so "same for everyone today, different tomorrow"
// works identically to every other daily mechanic in the app.
function dailySubset(pool, slotKey, date) {
  if (pool.length <= DAILY_POOL_SIZE) return pool;
  const seed = hashSeed(`cardle-captions-${isoDay(date)}-${slotKey}`);
  return shuffle(pool, createRng(seed)).slice(0, DAILY_POOL_SIZE);
}

// Which pool each slot is currently drawing from — a stable identifier
// (e.g. "ending.good") useful for anything that needs to key off it
// (analytics, future features), even though nothing currently persists a
// choice against it.
export function getPoolKeys(originalHand, finalHand, discardIndices) {
  const finalHandResult = evaluateHand(finalHand);
  return {
    opening: 'opening',
    action: 'action',
    object: 'object',
    connector: 'connector',
    ending: `ending.${endingKeyFor(finalHandResult)}`,
    emoji: 'emoji',
  };
}

// The available options for each of the 6 slots for this exact run, on this
// exact day. Only `ending` varies with the hand; every slot (`ending`
// included) also rotates its visible options daily via `dailySubset()`.
export function getStoryOptions(originalHand, finalHand, discardIndices, date = new Date(), fragments = FRAGMENTS) {
  const finalHandResult = evaluateHand(finalHand);
  const endingKey = endingKeyFor(finalHandResult);
  return {
    opening: dailySubset(fragments.opening, 'opening', date),
    action: dailySubset(fragments.action, 'action', date),
    object: dailySubset(fragments.object, 'object', date),
    connector: dailySubset(fragments.connector, 'connector', date),
    ending: dailySubset(fragments.ending[endingKey], `ending-${endingKey}`, date),
    emoji: dailySubset(fragments.emoji, 'emoji', date),
  };
}

// Deterministic per-run seed so, before a player customizes anything, the
// initial caption is still a specific, repeatable choice rather than always
// "the first option in every list."
function storySeed(originalHand, finalHand) {
  const cardKey = (cards) => cards.map((c) => `${c.rank}${c.suit}`).join('');
  return hashSeed(`story-${cardKey(originalHand)}-${cardKey(finalHand)}`);
}

const SLOT_ORDER = ['opening', 'action', 'object', 'connector', 'ending', 'emoji'];

/**
 * A deterministic starting selection (one index per slot) for this run —
 * pure function of the cards (and today's rotated pools), no player input,
 * and never persisted across days (owner request: don't remember previous
 * picks — start fresh, looking effectively random, every day). The player
 * can still freely change any dropdown during the current view; those
 * edits just live only in the DOM.
 */
export function getDefaultSelections(originalHand, finalHand, discardIndices, date = new Date(), fragments = FRAGMENTS) {
  const options = getStoryOptions(originalHand, finalHand, discardIndices, date, fragments);
  const rng = createRng(storySeed(originalHand, finalHand));
  const selections = {};
  for (const slot of SLOT_ORDER) {
    selections[slot] = Math.floor(rng() * options[slot].length);
  }
  return selections;
}

/**
 * Assembles the caption text from explicit per-slot choices — pure and
 * order-independent; out-of-range or missing indices fall back to option 0.
 * One flowing sentence (owner request — "i dont want it to be a story like
 * it was, i want it to be a short phrase"), not 3 separate lines: each slot
 * is a single space-joined word/phrase in a fixed grammatical role —
 * Opening (subject) Action (verb) Object (direct object) Connector
 * (linking word) Ending (closing clause) Emoji (trailing flourish) — e.g.
 * "today i trusted the river like it owed me money 💀".
 */
export function buildStoryTextFromSelections(originalHand, finalHand, discardIndices, selections, date = new Date(), fragments = FRAGMENTS) {
  const options = getStoryOptions(originalHand, finalHand, discardIndices, date, fragments);
  const pick = (slot) => {
    const pool = options[slot];
    const index = selections?.[slot];
    return pool[Number.isInteger(index) && index >= 0 && index < pool.length ? index : 0];
  };

  return [pick('opening'), pick('action'), pick('object'), pick('connector'), pick('ending'), pick('emoji')].join(' ');
}

// Convenience wrapper for callers that don't care about custom selection
// (e.g. quick tests) — uses the deterministic default for every slot.
export function buildStoryText(originalHand, finalHand, discardIndices, date = new Date(), fragments = FRAGMENTS) {
  const selections = getDefaultSelections(originalHand, finalHand, discardIndices, date, fragments);
  return buildStoryTextFromSelections(originalHand, finalHand, discardIndices, selections, date, fragments);
}

// Wordle-style share grid: one token per final-hand position, suit only
// (never rank), with a ✨ marker on positions that were drawn replacements
// rather than kept from the original deal. Dates from when every player got
// the same daily hand (spoiler-safe, so a friend who hadn't played yet
// couldn't see the answer) — kept for callers that still want it, but no
// longer what buildShareText uses (see buildFinalHandText below): now that
// hands are randomly dealt per player (§42), there's no shared puzzle left
// to spoil.
export function buildEmojiGrid(finalHand, discardIndices) {
  const discarded = new Set(discardIndices);
  return finalHand.map((card, index) => suitGlyph(card.suit) + (discarded.has(index) ? '✨' : '')).join(' ');
}

// The actual final hand, rank and suit, in play order — owner request:
// "redesign what is copied from the copy results, showing what cards were
// drawn." No drawn/kept marker (owner: "remove the stars in the copied") —
// just the plain final hand.
export function buildFinalHandText(finalHand) {
  return finalHand.map((card) => `${rankLabel(card.rank)}${suitGlyph(card.suit)}`).join(' ');
}

// Owner: "i think we should remove the poem from the copy and just add the
// website below the final hand" — the poem/story stays fully visible and
// editable in the UI (renderStoryBlock, board.js), it just isn't part of
// what gets copied anymore. The `https://` prefix isn't just cosmetic:
// pasted as plain text (copyToClipboard, board.js, is a plain writeText),
// most apps' auto-linkifiers (iMessage, Slack, Discord, email...) only
// reliably turn a bare domain into a tappable link when it has an explicit
// scheme — owner report: "the cardle.lol cannot be clicked" when pasted.
const SITE_URL = 'https://cardle.lol';

export function buildShareText(result, finalHandText) {
  const ratingPct = Number.isFinite(result.decisionRating) ? `${Math.round(result.decisionRating * 100)}%` : '—';
  return [
    `Cardle #${result.dayNumber} — ${result.score.handResult.label} — ${result.score.total.toLocaleString()} pts`,
    `Decision Rating: ${ratingPct}`,
    `Final Hand: ${finalHandText}`,
    SITE_URL,
  ].join('\n');
}

/**
 * Builds the full post-game caption package for a completed run.
 * @param {object} result - the run object board.js already assembles:
 *   { dayNumber, originalHand, discardIndices, finalHand, score, decisionRating }
 * @param {object} [selections] - explicit per-slot choices (see SLOT_ORDER); defaults to getDefaultSelections()
 * @param {Date} [date] - which day's rotated caption pools to use; defaults to now
 */
export function generateStory(result, selections, date = new Date(), fragments = FRAGMENTS) {
  const resolvedSelections =
    selections ?? getDefaultSelections(result.originalHand, result.finalHand, result.discardIndices, date, fragments);
  const text = buildStoryTextFromSelections(result.originalHand, result.finalHand, result.discardIndices, resolvedSelections, date, fragments);
  const emojiGrid = buildEmojiGrid(result.finalHand, result.discardIndices);
  const finalHandText = buildFinalHandText(result.finalHand);
  const shareText = buildShareText(result, finalHandText);
  return { text, emojiGrid, finalHandText, shareText, selections: resolvedSelections };
}
