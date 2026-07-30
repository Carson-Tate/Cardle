import { freshSeed } from '../core/deck.js';
import { gameDayFor, gameDayNumber } from '../core/game-day.js';

const STORAGE_PREFIX = 'cardle';

// Keyed by GAME day, not UTC day (DESIGN.md §11l) — the day rolls at 7pm New
// York. In winter that is the same string the old UTC logic produced, so keys
// written before this change still resolve.
function todayKey(date = new Date()) {
  return `${STORAGE_PREFIX}:result:${gameDayFor(date)}`;
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
  return `${STORAGE_PREFIX}:seed:${gameDayFor(date)}`;
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

// Re-exported from core/game-day.js so "Cardle #N" advances with the 7pm reset
// rather than at midnight UTC. Kept as a named export here because board.js and
// admin.js already import it from this module.
export { gameDayNumber as dayNumber };
