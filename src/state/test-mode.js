import { hashSeed } from '../core/deck.js';

/**
 * Resolves how the board should run based on the URL.
 *
 * Normal play: `/` — a randomly-dealt hand, unique to this player, that
 * stays the same across reloads of the same day; exactly one play per day
 * (DESIGN.md §9.2). No `seed` here — board.js resolves that itself once it
 * knows whether the player is signed in (an account-backed seed via
 * daily-play.js) or not (a local one via persistence.js), since that
 * decision needs an async session check this function can't do.
 *
 * Test mode: `?test` or `?test=<anything>` — deliberately separate from the
 * real game. Never reads or writes the daily result, so it can't be used to
 * dodge the one-play-per-day rule or corrupt a real streak/score record.
 *   - `?test=42`      -> reproducible seed 42, same hand every reload
 *   - `?test=foo`      -> reproducible seed derived from "foo"
 *   - `?test` (no value) -> a fresh random hand every reload
 */
export function resolveRunConfig(locationSearch = window.location.search) {
  const params = new URLSearchParams(locationSearch);

  if (!params.has('test')) {
    return { isTestMode: false, persist: true };
  }

  const raw = params.get('test');
  let seed;
  let seedLabel;
  if (raw && /^-?\d+$/.test(raw)) {
    seed = Number(raw) >>> 0;
    seedLabel = raw;
  } else if (raw) {
    seed = hashSeed(`cardle-test-${raw}`);
    seedLabel = raw;
  } else {
    seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    seedLabel = 'random';
  }

  return { isTestMode: true, seed, persist: false, seedLabel };
}
