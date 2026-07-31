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

import { xpForRun, totalXpForLevel } from '../core/progression.js';
import { gameDayFor, addGameDays } from '../core/game-day.js';

const STORAGE_KEY = 'cardle-test-account';
export const TEST_ACCOUNT_USER_ID = 'test-account-local';
export const TEST_ACCOUNT_USERNAME = 'TESTER';

// A run worth EXACTLY 100 XP: the base and nothing else — High Card (strength
// 0), a score of 0 (grade Busted, so no grade term), no bonuses, no
// achievements, and a decision rating of 0. That exactness is what lets a target
// XP be hit on the nose below rather than approximated.
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
 * fabricated total would exercise a path production never takes. Each whole run
 * contributes 100 (see baseRun) and the remainder rides on one run's decision
 * rating, which is worth 0-100 — so any target is reachable to the point.
 *
 * Dated backwards from today, one per game day, so streaks and "playing since"
 * read sensibly too.
 */
export function testAccountHistory(totalXp = testAccountXp()) {
  const target = Math.max(0, Math.round(totalXp));
  const whole = Math.floor(target / 100);
  const remainder = target - whole * 100;

  const runs = [];
  let day = gameDayFor(new Date());
  const push = (rating) => {
    runs.push(baseRun(day, rating));
    day = addGameDays(day, -1);
  };

  if (whole === 0) {
    // Below one full run there is nothing to carry the remainder, and a single
    // run is worth at least 100 — so this rounds to "no history at all".
    return [];
  }
  // One run carries the remainder; the rest are exactly 100 each.
  push(remainder / 100);
  for (let i = 1; i < whole; i++) push(0);
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
