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

const EPOCH = new Date('2026-07-27T00:00:00Z');

export function dayNumber(date = new Date()) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startOfToday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startOfEpoch = Date.UTC(EPOCH.getUTCFullYear(), EPOCH.getUTCMonth(), EPOCH.getUTCDate());
  return Math.floor((startOfToday - startOfEpoch) / msPerDay) + 1;
}
