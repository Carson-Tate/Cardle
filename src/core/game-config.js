// Server-side game config: validation, merging, and defaults (DESIGN.md §11g).
//
// Pure on purpose. `src/core/` never touches the network — the config is
// fetched by `src/state/game-config.js` and PASSED IN to the functions that
// need it, so everything here stays directly unit-testable and the game's rules
// remain expressible without a database.
//
// Every value is validated twice, in both directions:
//   * On the way IN, so the admin page refuses to save something broken.
//   * On the way OUT, so a value that got into the table anyway (an older
//     shape, a hand-edited row, a future code change) falls back to the
//     built-in default instead of breaking the game for every player.
// The second half matters more than the first: this config is read by every
// client on boot, so one bad row could otherwise take the whole game down.

import { MODIFIERS } from './modifiers.js';
import { gameDayFor } from './game-day.js';
import { FRAGMENTS, SLOT_META } from '../story/templates.js';

export const CONFIG_KEYS = {
  MODIFIER_OVERRIDES: 'modifier_overrides',
  WORD_BANK: 'word_bank',
  CUSTOM_COSMETICS: 'custom_cosmetics',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COSMETIC_ID = /^[A-Za-z0-9_]{1,40}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// How a custom cosmetic becomes available (DESIGN.md §11h). This exists because
// level-gating alone was wrong for a whole category of cosmetic: an "Owner"
// title authored at level 1 unlocked for EVERY player, since every player is at
// least level 1. There was no way to express "this one is mine" or "this one is
// simply for everybody".
//
//   'level'    — unlocks at `level`, the original behaviour and still the default
//                for titles and paints.
//   'everyone' — unlocked for every player immediately, no level involved.
//   'grant'    — obtainable ONLY via an admin grant (profiles.admin_unlocks), and
//                HIDDEN from a player's picker unless they actually have it, so
//                an exclusive cosmetic doesn't advertise itself to everyone.
export const AVAILABILITY_MODES = ['level', 'everyone', 'grant'];
const DEFAULT_AVAILABILITY = { badge: 'grant', title: 'level', paint: 'level' };

const MODIFIER_IDS = new Set(MODIFIERS.map((m) => m.id));
// The word bank's flat slots. `ending` is nested (good/bad) and handled
// separately — it's the one slot that reacts to the hand (§6b).
const FLAT_SLOTS = ['opening', 'action', 'object', 'connector', 'emoji'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Modifier overrides:  { "2026-08-01": "flushFrenzy", ... }
// ---------------------------------------------------------------------------

/**
 * @returns {{value: Record<string,string>, errors: string[]}} `value` contains
 *   only the entries that validated, so one bad date can't discard the rest.
 */
export function validateModifierOverrides(raw) {
  const errors = [];
  if (raw === null || raw === undefined) return { value: {}, errors };
  if (!isPlainObject(raw)) return { value: {}, errors: ['modifier overrides must be an object of date → modifier id'] };

  const value = {};
  for (const [date, id] of Object.entries(raw)) {
    if (!ISO_DATE.test(date)) {
      errors.push(`"${date}" is not a YYYY-MM-DD date`);
      continue;
    }
    if (typeof id !== 'string' || !MODIFIER_IDS.has(id)) {
      errors.push(`"${id}" is not a known modifier id (for ${date})`);
      continue;
    }
    value[date] = id;
  }
  return { value, errors };
}

/**
 * The override id for a given day, or null. Safe against unvalidated input.
 *
 * KEYED ON THE GAME DAY (§11l), not the UTC calendar date. This used to call
 * `toISOString().slice(0,10)`, which disagrees with the rest of the app for one
 * hour a day during EDT: the game day rolls at 19:00 New York, the UTC date at
 * 20:00. Owner bug report — "when i switch the modifier of today i think it
 * resets". Two things went wrong in that window. A pin kept applying for an hour
 * after its day had ended, leaking yesterday's modifier onto the new hand; and a
 * pin made during that hour was filed under the previous date, so it silently
 * stopped applying to the day it was meant for. It looked like a deploy had
 * cleared it, because a deploy is what prompts the reload where you notice.
 *
 * @param {object} overrides - the stored map, trusted or not
 * @param {Date|string} [date] - an instant, or a YYYY-MM-DD game day directly
 */
export function modifierOverrideFor(overrides, date = new Date()) {
  const { value } = validateModifierOverrides(overrides);
  const day = date instanceof Date ? gameDayFor(date) : String(date);
  return value[day] ?? null;
}

// ---------------------------------------------------------------------------
// Word bank:  partial override of story/templates.js's FRAGMENTS
// ---------------------------------------------------------------------------

/**
 * PARTIAL by design: only the slots present in the stored value override the
 * built-ins. An admin editing the `emoji` list shouldn't have to re-enter all
 * six slots, and a slot they never touched should keep getting new built-in
 * content on future deploys.
 */
export function validateWordBank(raw) {
  const errors = [];
  if (raw === null || raw === undefined) return { value: {}, errors };
  if (!isPlainObject(raw)) return { value: {}, errors: ['word bank must be an object keyed by slot'] };

  const value = {};
  for (const [slot, entries] of Object.entries(raw)) {
    if (slot === 'ending') {
      if (!isPlainObject(entries)) {
        errors.push('ending must be an object with "good" and "bad" lists');
        continue;
      }
      const ending = {};
      for (const key of ['good', 'bad']) {
        if (entries[key] === undefined) continue;
        if (!isNonEmptyStringArray(entries[key])) {
          errors.push(`ending.${key} must be a non-empty list of phrases`);
          continue;
        }
        ending[key] = dedupeTrimmed(entries[key]);
      }
      if (Object.keys(ending).length > 0) value.ending = ending;
      continue;
    }

    if (!FLAT_SLOTS.includes(slot)) {
      errors.push(`"${slot}" is not a story slot`);
      continue;
    }
    if (!isNonEmptyStringArray(entries)) {
      errors.push(`${slot} must be a non-empty list of phrases`);
      continue;
    }
    // A fragment containing a period would break the one-line sentence the
    // caption builder assembles (§6c) — the same invariant templates.js's own
    // tests enforce for the built-in pools.
    const offending = entries.find((entry) => entry.slice(0, -1).includes('.'));
    if (offending) errors.push(`${slot}: "${offending}" contains a period, which would break the single-line caption`);
    value[slot] = dedupeTrimmed(entries);
  }
  return { value, errors };
}

function dedupeTrimmed(list) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * The effective fragment pools: built-ins with any validated overrides applied.
 * Returns `FRAGMENTS` itself when there's nothing to override, so the common
 * path allocates nothing.
 */
export function mergeWordBank(overrides) {
  const { value } = validateWordBank(overrides);
  if (Object.keys(value).length === 0) return FRAGMENTS;

  const merged = { ...FRAGMENTS };
  for (const slot of FLAT_SLOTS) {
    if (value[slot]) merged[slot] = value[slot];
  }
  if (value.ending) merged.ending = { ...FRAGMENTS.ending, ...value.ending };
  return merged;
}

/** Slot metadata plus the built-in defaults, for rendering the admin editor. */
export function wordBankSlots() {
  return [
    ...FLAT_SLOTS.map((slot) => ({ slot, label: SLOT_META[slot]?.label ?? slot, defaults: FRAGMENTS[slot] })),
    { slot: 'ending.good', label: 'Ending (good hand)', defaults: FRAGMENTS.ending.good },
    { slot: 'ending.bad', label: 'Ending (bad hand)', defaults: FRAGMENTS.ending.bad },
  ];
}

// ---------------------------------------------------------------------------
// Custom cosmetics:  { badges: [...], titles: [...], paints: [...] }
// ---------------------------------------------------------------------------

/**
 * Admin-authored cosmetics, appended to the built-in registries (§11e).
 *
 * Custom paints carry a plain `color` hex rather than a CSS class, because a
 * class can't be authored at runtime — and strictly a 6-digit hex, applied as
 * `style="color: #xxxxxx"`, so there is no way to smuggle arbitrary CSS into a
 * nameplate that renders in other players' browsers. Gradients and animation
 * stay code-only for the same reason: they'd need real CSS.
 *
 * Custom badges have no achievement behind them, so they can only ever be
 * handed out with an admin grant (§11f's `admin_unlocks`). That's recorded on
 * the entry as `grantOnly` so the UI can say so instead of showing an
 * unreachable requirement.
 */
export function validateCustomCosmetics(raw) {
  const errors = [];
  const empty = { badges: [], titles: [], paints: [] };
  if (raw === null || raw === undefined) return { value: empty, errors };
  if (!isPlainObject(raw)) return { value: empty, errors: ['custom cosmetics must be an object with badges/titles/paints'] };

  const seen = new Set();
  const takeId = (entry, kind) => {
    const id = entry?.id;
    if (typeof id !== 'string' || !COSMETIC_ID.test(id)) {
      errors.push(`${kind}: "${id}" is not a valid id (letters, numbers, underscore, 1-40 chars)`);
      return null;
    }
    if (seen.has(id)) {
      errors.push(`${kind}: duplicate id "${id}"`);
      return null;
    }
    seen.add(id);
    return id;
  };
  // Markup characters are refused outright, matching the treatment `id`
  // (^[A-Za-z0-9_]{1,40}$) and paint `color` (^#[0-9a-fA-F]{6}$) already get.
  //
  // Defense in depth, not a live hole: all six current render sites escape. But
  // this value is admin-authored, world-readable, and reaches every nameplate,
  // every picker chip and an `<option>` — so its safety currently rests on
  // nobody ever adding a seventh render site that forgets. That is exactly how
  // the original friends-list XSS happened, and how the unescaped word-bank
  // `<option>` in board.js survived. Validate the value, then the render site
  // cannot be the single point of failure.
  const MARKUP_CHARS = /[<>&"']/;
  const takeLabel = (entry, kind, id) => {
    if (typeof entry?.label !== 'string' || !entry.label.trim()) {
      errors.push(`${kind} "${id}": label is required`);
      return null;
    }
    if (MARKUP_CHARS.test(entry.label)) {
      errors.push(`${kind} "${id}": label may not contain < > & " or '`);
      return null;
    }
    return entry.label.trim();
  };
  const takeLevel = (entry, kind, id) => {
    const level = Number(entry?.level ?? 1);
    if (!Number.isInteger(level) || level < 1) {
      errors.push(`${kind} "${id}": level must be a whole number of at least 1`);
      return null;
    }
    return level;
  };
  // Absent means the kind's default, so cosmetics authored before availability
  // existed keep behaving exactly as they did rather than silently changing.
  const takeAvailability = (entry, kind, id) => {
    const availability = entry?.availability ?? DEFAULT_AVAILABILITY[kind];
    if (!AVAILABILITY_MODES.includes(availability)) {
      errors.push(`${kind} "${id}": availability must be one of ${AVAILABILITY_MODES.join(', ')}`);
      return null;
    }
    return availability;
  };

  const badges = [];
  for (const entry of Array.isArray(raw.badges) ? raw.badges : []) {
    const id = takeId(entry, 'badge');
    if (!id) continue;
    const label = takeLabel(entry, 'badge', id);
    const availability = takeAvailability(entry, 'badge', id);
    if (!label || availability === null) continue;
    // Same markup rule as `label` above, and the same reasoning — this renders
    // beside usernames. Falls back to the default rather than erroring: an emoji
    // is decoration, so a bad one should not cost the admin the whole save.
    const rawEmoji = typeof entry.emoji === 'string' ? entry.emoji.trim() : '';
    const emoji = rawEmoji && !MARKUP_CHARS.test(rawEmoji) ? rawEmoji : '⭐';
    // A custom badge has no achievement behind it, so 'level' is meaningless
    // for one — it collapses to 'grant' rather than being silently unreachable.
    badges.push({
      id,
      label,
      emoji,
      custom: true,
      availability: availability === 'level' ? 'grant' : availability,
      level: 1,
    });
  }

  const titles = [];
  for (const entry of Array.isArray(raw.titles) ? raw.titles : []) {
    const id = takeId(entry, 'title');
    if (!id) continue;
    const label = takeLabel(entry, 'title', id);
    const level = takeLevel(entry, 'title', id);
    const availability = takeAvailability(entry, 'title', id);
    if (!label || level === null || availability === null) continue;
    titles.push({ id, label, level, custom: true, availability });
  }

  const paints = [];
  for (const entry of Array.isArray(raw.paints) ? raw.paints : []) {
    const id = takeId(entry, 'paint');
    if (!id) continue;
    const label = takeLabel(entry, 'paint', id);
    const level = takeLevel(entry, 'paint', id);
    const availability = takeAvailability(entry, 'paint', id);
    if (!label || level === null || availability === null) continue;
    if (typeof entry.color !== 'string' || !HEX_COLOR.test(entry.color)) {
      errors.push(`paint "${id}": color must be a 6-digit hex like #c0392b`);
      continue;
    }
    paints.push({ id, label, level, color: entry.color.toLowerCase(), custom: true, availability });
  }

  return { value: { badges, titles, paints }, errors };
}
