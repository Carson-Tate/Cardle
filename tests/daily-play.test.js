import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claimTodaySeed, saveTodayResultForUser, pendingRunMatches } from '../src/state/daily-play.js';
import { SupabaseNotConfiguredError } from '../src/state/supabase-client.js';

// Same reasoning as auth.test.js/friends.test.js: no live Supabase project
// in this test environment, so every function here should fail the same
// clear way rather than a null-reference crash.
describe('daily-play.js without a configured Supabase project', () => {
  test('every function throws SupabaseNotConfiguredError rather than a null-reference crash', async () => {
    await assert.rejects(() => claimTodaySeed('user-1'), SupabaseNotConfiguredError);
    await assert.rejects(() => saveTodayResultForUser('user-1', { score: { total: 1 } }), SupabaseNotConfiguredError);
  });
});

// The gate on resubmitting a locally-mirrored run (§11ak). Every one of these
// cases is a way for a player to be shown, or credited with, a hand that is
// not the one the server is holding for them — which is the exact class of bug
// the pending-run mirror exists to fix, so getting this wrong would trade one
// silent hand-swap for another.
describe('pendingRunMatches', () => {
  const run = { score: { total: 4200 } };

  test('a run mirrored from the claimed seed is recoverable', () => {
    assert.equal(pendingRunMatches({ seed: 12345, result: run }, 12345), true);
  });

  // THE LOAD-BEARING CASE. A pending run whose seed the server no longer holds
  // belongs to a hand that no longer exists — an admin day reset (§11aj)
  // re-rolls the seed, and a new game day claims a fresh row. Replaying it
  // would credit today's account row with yesterday's cards.
  test('a run mirrored from any other seed is refused', () => {
    assert.equal(pendingRunMatches({ seed: 999, result: run }, 12345), false);
  });

  // The seed survives a round trip through JSON on one side and a Postgres
  // `bigint` on the other, and PostgREST may hand the latter back as a string.
  // A strict `!==` fails here, and it fails CLOSED — every recoverable run
  // would be quietly discarded and the feature would look like it does nothing.
  test('a seed that came back as a string still matches', () => {
    assert.equal(pendingRunMatches({ seed: '12345', result: run }, 12345), true);
    assert.equal(pendingRunMatches({ seed: 12345, result: run }, '12345'), true);
  });

  test('a mirror with no result in it is not a run', () => {
    assert.equal(pendingRunMatches({ seed: 12345 }, 12345), false);
    assert.equal(pendingRunMatches({ seed: 12345, result: null }, 12345), false);
  });

  // localStorage holds whatever was last written there, including by an older
  // version of the game or a hand-edited value. Absent/garbage must read as
  // "nothing to recover", never throw — this runs during board init, where an
  // exception leaves the page stuck on "Loading today's hand…" (the failure
  // persistence.js's readJson guard was added for).
  test('missing or malformed storage is not a run, and does not throw', () => {
    assert.equal(pendingRunMatches(null, 12345), false);
    assert.equal(pendingRunMatches(undefined, 12345), false);
    assert.equal(pendingRunMatches('nonsense', 12345), false);
    assert.equal(pendingRunMatches({ seed: 'abc', result: run }, 12345), false);
    assert.equal(pendingRunMatches({ result: run }, 12345), false);
  });

  // A seed the caller could not determine must never match a stored one.
  // `currentSeed` is null for the admin panel's custom hand builder, which
  // never persists — but "null equals null" would be the wrong answer anyway.
  test('an unknown claimed seed matches nothing', () => {
    assert.equal(pendingRunMatches({ seed: 12345, result: run }, null), false);
    assert.equal(pendingRunMatches({ seed: null, result: run }, null), false);
  });
});
