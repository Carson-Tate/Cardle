import { freshSeed } from '../core/deck.js';

const STORAGE_PREFIX = 'cardle';

function todayKey(date = new Date()) {
  return `${STORAGE_PREFIX}:result:${date.toISOString().slice(0, 10)}`;
}

// Every localStorage touch in this file goes through these two helpers.
// Both `localStorage` access itself and `JSON.parse` can throw for reasons
// that have nothing to do with the game being in a bad state — storage
// disabled/full (Safari private mode, "block all cookies", quota), or a
// half-written/hand-edited value. Those used to propagate: `getTodayResult`
// is called from board.js's init OUTSIDE its try/catch, so a single
// malformed byte left the page stuck on "Loading today's hand…" forever
// with no way to recover short of clearing site data. Treating unreadable
// storage as "nothing stored yet" degrades to a fresh hand instead, and a
// failed write just means this run isn't remembered — neither is worth
// taking the whole game down for.
function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn(`Ignoring unreadable localStorage entry "${key}":`, error);
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not persist localStorage entry "${key}":`, error);
  }
}

// Cardle is one play per day by design (DESIGN.md §2/§9.2) — once a result
// is saved for today, the board loads it back instead of dealing again.
export function getTodayResult(date = new Date()) {
  return readJson(todayKey(date));
}

export function saveTodayResult(result, date = new Date()) {
  writeJson(todayKey(date), result);
}

function seedKey(date = new Date()) {
  return `${STORAGE_PREFIX}:seed:${date.toISOString().slice(0, 10)}`;
}

// Each player gets their own randomly-dealt hand (owner request — everyone
// used to get dealt the exact same cards, via a seed derived from the date
// alone). The seed still has to be *stable for the day*, though: reloading
// mid-game (before lock-in) must show the same hand again, not redeal a new
// one out from under the player. So the random seed is generated once, the
// first time a given day is seen, and stashed here — every later call that
// same day (including across reloads) gets the same stored value back.
// Same storage-can-throw handling as readJson/writeJson above, plus a
// Number.isFinite guard: a garbage stored value used to become NaN here,
// and `createRng(NaN)` silently coerces to seed 0 — a valid-looking but
// wrong hand rather than an obvious failure. Falling back to a fresh seed
// is both safer and self-healing.
export function getOrCreateTodaySeed(date = new Date()) {
  const key = seedKey(date);
  let stored = null;
  try {
    stored = localStorage.getItem(key);
  } catch (error) {
    console.warn(`Could not read localStorage entry "${key}":`, error);
  }
  if (stored !== null) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return parsed;
    console.warn(`Ignoring non-numeric stored seed "${stored}" for "${key}".`);
  }
  const seed = freshSeed();
  try {
    localStorage.setItem(key, String(seed));
  } catch (error) {
    console.warn(`Could not persist localStorage entry "${key}":`, error);
  }
  return seed;
}

const EPOCH = new Date('2026-07-27T00:00:00Z');

export function dayNumber(date = new Date()) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startOfToday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startOfEpoch = Date.UTC(EPOCH.getUTCFullYear(), EPOCH.getUTCMonth(), EPOCH.getUTCDate());
  return Math.floor((startOfToday - startOfEpoch) / msPerDay) + 1;
}
