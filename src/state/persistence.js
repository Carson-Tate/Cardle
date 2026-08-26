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

// A finished run the server has not accepted yet (DESIGN.md §11ak).
//
// WHY THIS EXISTS. A signed-in player's result used to live in exactly one
// place: an un-awaited POST fired at the moment the score reveal begins. The
// reveal runs the better part of ten seconds, the header's Leaderboards button
// is a full page navigation (there is no router — see ui/main.js), and a
// navigation cancels an in-flight fetch. So clicking through to the boards
// while the points were still counting up dropped the run on the floor:
// `daily_plays.result` stayed null, which the board reads as "seed claimed,
// not finished" and duly offers the same hand again. The player is left with
// no score on the leaderboard and a board that looks like it reset itself.
//
// Written FIRST, synchronously, before the network is touched at all, so the
// run outlives the page that produced it and the next load can resubmit it.
//
// THE SEED IS STORED BESIDE IT, and that is the load-bearing part: it is what
// proves the pending run and the row on the server are the same hand. A
// pending run whose seed the server no longer holds (an admin reset, a day
// rollover, a different account signing in on this browser) must be thrown
// away rather than replayed onto whatever hand is there now.
function pendingKey(date = new Date()) {
  return `${STORAGE_PREFIX}:pending:${gameDayFor(date)}`;
}

export function savePendingRun(entry, date = new Date()) {
  writeJson(pendingKey(date), entry);
}

export function getPendingRun(date = new Date()) {
  return readJson(pendingKey(date));
}

export function clearPendingRun(date = new Date()) {
  const key = pendingKey(date);
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`Could not clear localStorage entry "${key}":`, error);
  }
}

// Whether this browser has ever resolved a real signed-in session.
//
// Used for exactly one decision, in board.js: when the session cannot be
// resolved AT ALL (a blocked CDN, a captive portal, a failed token refresh),
// "nobody is signed in" and "we could not find out" are indistinguishable to
// getSession() — and treating the second as the first deals the player a
// brand-new local hand in place of the account hand the server is holding for
// them. That is the harshest form of the reset this file's pending-run
// storage exists to prevent, and it is silent.
//
// Set and cleared by auth.js's resolveSession(), so no call site has to
// remember to maintain it. A genuine signed-out answer from a REACHABLE
// backend clears it; an unreachable backend deliberately leaves it alone.
const ACCOUNT_KEY = `${STORAGE_PREFIX}:has-account`;

export function rememberAccount() {
  try {
    localStorage.setItem(ACCOUNT_KEY, '1');
  } catch (error) {
    console.warn(`Could not persist localStorage entry "${ACCOUNT_KEY}":`, error);
  }
}

export function forgetAccount() {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch (error) {
    console.warn(`Could not clear localStorage entry "${ACCOUNT_KEY}":`, error);
  }
}

export function hasKnownAccount() {
  try {
    return localStorage.getItem(ACCOUNT_KEY) === '1';
  } catch (error) {
    console.warn(`Could not read localStorage entry "${ACCOUNT_KEY}":`, error);
    return false;
  }
}

// Can this browser actually KEEP anything?
//
// Every helper above degrades quietly when storage throws — the right call
// individually, and collectively it produces a game that silently re-deals a
// different hand on every single load, because getOrCreateTodaySeed can never
// store the seed it just minted. Safari's private mode, "block all cookies"
// and a full quota all land here. Probing once lets the board SAY so instead,
// which is the difference between a bug and a known limitation.
export function isStorageWritable() {
  const probe = `${STORAGE_PREFIX}:probe`;
  try {
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

// Re-exported from core/game-day.js so "Cardle #N" advances with the 7pm reset
// rather than at midnight UTC. Kept as a named export here because board.js and
// admin.js already import it from this module.
export { gameDayNumber as dayNumber };
