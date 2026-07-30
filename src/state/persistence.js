import { freshSeed } from '../core/deck.js';

const STORAGE_PREFIX = 'cardle';

function todayKey(date = new Date()) {
  return `${STORAGE_PREFIX}:result:${date.toISOString().slice(0, 10)}`;
}

// Cardle is one play per day by design (DESIGN.md §2/§9.2) — once a result
// is saved for today, the board loads it back instead of dealing again.
export function getTodayResult(date = new Date()) {
  const raw = localStorage.getItem(todayKey(date));
  return raw ? JSON.parse(raw) : null;
}

export function saveTodayResult(result, date = new Date()) {
  localStorage.setItem(todayKey(date), JSON.stringify(result));
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
export function getOrCreateTodaySeed(date = new Date()) {
  const key = seedKey(date);
  const stored = localStorage.getItem(key);
  if (stored !== null) return Number(stored);
  const seed = freshSeed();
  localStorage.setItem(key, String(seed));
  return seed;
}

const EPOCH = new Date('2026-07-27T00:00:00Z');

export function dayNumber(date = new Date()) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startOfToday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startOfEpoch = Date.UTC(EPOCH.getUTCFullYear(), EPOCH.getUTCMonth(), EPOCH.getUTCDate());
  return Math.floor((startOfToday - startOfEpoch) / msPerDay) + 1;
}
