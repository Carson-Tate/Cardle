// A fake signed-in account, for local testing only (DESIGN.md §11u).
//
// Owner request: "for the localhost test mode have the option to sign in as a
// fake account so i can test the new things like the xp." Levels, the XP bar and
// level-ups are all DERIVED from stored runs, so exercising them otherwise means
// a real account with a real history — which cannot be rewound, and on a
// one-run-per-day game takes weeks to build.
//
// ── WHY THIS IS SAFE ────────────────────────────────────────────────────────
// Two independent gates, both required:
//
//   1. `?test` must be in the URL. Production links never carry it, and it is
//      the same switch that already exposes the admin/redeal panel.
//   2. A localStorage flag the tester sets deliberately from that panel.
//
// It is also purely a CLIENT-side illusion. It never obtains a Supabase session,
// so it grants no database access whatsoever — every read it serves is fabricated
// here, and any real query would still be judged by RLS against an anonymous
// caller. The worst it can do is lie to one browser about what one player's
// history looks like.
//
// Test mode already refuses to read or write the real daily result
// (state/test-mode.js), so a fake account cannot corrupt a real streak either.

import { xpForRun, totalXpForLevel, XP_BASE_PER_RUN, XP_PER_DECISION_RATING } from '../core/progression.js';
import { gameDayFor, addGameDays } from '../core/game-day.js';

const STORAGE_KEY = 'cardle-test-account';
export const TEST_ACCOUNT_USER_ID = 'test-account-local';
export const TEST_ACCOUNT_USERNAME = 'TESTER';

// A run worth EXACTLY `XP_BASE_PER_RUN`: the base and nothing else — High Card
// (strength 0), a score of 0 (grade Busted, so no grade term), no bonuses, no
// achievements, and a decision rating of 0. That exactness is what lets a target
// XP be hit on the nose below rather than approximated. A non-zero
// `decisionRating` adds `rating * XP_PER_DECISION_RATING` on top, and that is
// the only other term in play — which is what makes the arithmetic in
// testAccountHistory a two-variable problem rather than a search.
function baseRun(playDate, decisionRating = 0) {
  return {
    playDate,
    result: {
      dayNumber: 0,
      score: {
        handResult: { id: 'HIGH_CARD', label: 'High Card' },
        total: 0,
        baseScore: 0,
        extraBonuses: [],
        rarity: { items: [] },
      },
      decisionRating,
      personalityId: 'shark',
      newlyUnlocked: [],
      finalHand: [],
      originalHand: [],
      discardIndices: [],
      meters: { luck: 0, skill: 0, risk: 0 },
    },
  };
}

/** Whether the fake account is switched on. Both gates must hold. */
/**
 * Both gates, checked together.
 *
 * Called at EVERY point that returns fake identity — getSession,
 * onAuthStateChange and getProfile in state/auth.js, fetchPlayHistory in
 * state/profile.js, and addTestAccountXp below — so there is no path that
 * returns the fake account without both.
 *
 * A note on how independent these really are: the localStorage flag is set by a
 * checkbox that only renders when `?test` is already present, so anyone who
 * reaches gate 1 is one click from gate 2. It is a deliberate opt-in, not a
 * second secret. What actually makes this safe is that the fake account holds no
 * Supabase JWT, so every real query still runs as `anon` — and test mode sets
 * `persist: false`, so no run it produces is ever written to daily_plays.
 */
export function isTestAccountActive(search = typeof window === 'undefined' ? '' : window.location.search) {
  if (typeof window === 'undefined' || !new URLSearchParams(search).has('test')) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false; // storage blocked (private mode) — simply stays off
  }
}

/** The configured lifetime XP, or 0. */
export function testAccountXp() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    const xp = Number(raw?.totalXp);
    return Number.isFinite(xp) && xp >= 0 ? Math.round(xp) : 0;
  } catch {
    return 0;
  }
}

/** Switches it on (or updates its XP). */
export function enableTestAccount(totalXp = 0) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ totalXp: Math.max(0, Math.round(totalXp)) }));
}

export function disableTestAccount() {
  window.localStorage.removeItem(STORAGE_KEY);
}

/** A session shaped like Supabase's, for the code paths that only read `user.id`. */
export function testAccountSession() {
  return { user: { id: TEST_ACCOUNT_USER_ID, email: 'tester@localhost' } };
}

/** A `profiles` row, complete enough for nameplateHtml and the profile page. */
export function testAccountProfile() {
  return {
    id: TEST_ACCOUNT_USER_ID,
    username: TEST_ACCOUNT_USERNAME,
    equipped_badge: null,
    equipped_title: null,
    equipped_paint: null,
    admin_unlocks: [],
    created_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * A synthetic history whose derived XP is EXACTLY `totalXp`.
 *
 * Built from runs rather than by stating a number, because that is the only way
 * it tests the real thing: `derivePlayerStats` recomputes XP from results, so a
 * fabricated total would exercise a path production never takes.
 *
 * Every quantity here is DERIVED from progression.js's constants. It used to
 * hardcode 100 in four places — which was `XP_BASE_PER_RUN`'s value at the time
 * — so raising the base silently desynced the whole fake account: asking for 100
 * XP produced 150, and every level assertion built on top of it drifted with it.
 * That is the same "anchor to the constant, never the magic number" rule the
 * score thresholds already follow.
 *
 * Each run is worth between XP_BASE_PER_RUN (rating 0) and
 * XP_BASE_PER_RUN + XP_PER_DECISION_RATING (rating 1), so `n` runs span
 * [n·BASE, n·(BASE+SPAN)]. Take the fewest runs that can reach the target, then
 * spread the leftover across their ratings. The spread is what makes an exact
 * hit possible now that one run's floor (150) exceeds what a single rating can
 * carry (100) — a remainder no longer fits on one run.
 *
 * Dated backwards from today, one per game day, so streaks and "playing since"
 * read sensibly too.
 */
export function testAccountHistory(totalXp = testAccountXp()) {
  const target = Math.max(0, Math.round(totalXp));
  const perRunMax = XP_BASE_PER_RUN + XP_PER_DECISION_RATING;
  const runCount = Math.ceil(target / perRunMax);

  // Below one run's floor there is no history that derives to the target, so
  // this rounds to "not played at all" rather than overshooting. The admin panel
  // shows what the history ACTUALLY derives to (testAccountActualXp), so the
  // rounding is visible rather than silent.
  if (runCount === 0 || runCount * XP_BASE_PER_RUN > target) return [];

  let remainder = target - runCount * XP_BASE_PER_RUN;
  const runs = [];
  let day = gameDayFor(new Date());
  for (let i = 0; i < runCount; i++) {
    const carry = Math.min(remainder, XP_PER_DECISION_RATING);
    remainder -= carry;
    runs.push(baseRun(day, carry / XP_PER_DECISION_RATING));
    day = addGameDays(day, -1);
  }
  return runs;
}

/**
 * Adds a finished run's XP to the fake account's total.
 *
 * Needed because test mode deliberately never writes a real result
 * (state/test-mode.js), so the synthetic history is regenerated identically
 * after every run and the bar had nothing to move to — the fake account looked
 * signed in but was frozen. Persisting the gain here is what makes "play a hand
 * and watch the bar fill" testable at all, which is the entire point of it.
 *
 * A no-op when the account is off, so board.js can call it unconditionally.
 */
export function addTestAccountXp(amount) {
  if (!isTestAccountActive()) return;
  const gained = Number(amount);
  if (!Number.isFinite(gained) || gained <= 0) return;
  enableTestAccount(testAccountXp() + gained);
}

/** Lifetime XP needed to sit `remaining` XP short of the next level. */
export function xpJustBelowLevel(level, remaining = 50) {
  return Math.max(0, totalXpForLevel(level) - Math.max(1, remaining));
}

/** What the synthetic history actually derives to — shown back in the panel. */
export function testAccountActualXp(totalXp = testAccountXp()) {
  return testAccountHistory(totalXp).reduce((sum, row) => sum + xpForRun(row.result), 0);
}
