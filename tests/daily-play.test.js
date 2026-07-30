import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claimTodaySeed, saveTodayResultForUser } from '../src/state/daily-play.js';
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
