import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCurrentUserAdmin,
  fetchAdminOverview,
  searchProfiles,
  fetchPlayerDetail,
  adminSetCosmetics,
  adminSetUnlocks,
  adminResetDay,
  adminResetTodayForEveryone,
  adminDeletePlayer,
  adminRenamePlayer,
  adminListBlockedWords,
  adminAddBlockedWords,
  adminRemoveBlockedWord,
} from '../src/state/admin.js';
import { SupabaseNotConfiguredError } from '../src/state/supabase-client.js';

// Same reasoning as auth.test.js/friends.test.js/daily-play.test.js: there's no
// live Supabase project in this environment, so every function that needs one
// should fail the same clear way rather than a null-reference crash.
describe('admin.js without a configured Supabase project', () => {
  test('every privileged call throws SupabaseNotConfiguredError', async () => {
    await assert.rejects(() => fetchAdminOverview(), SupabaseNotConfiguredError);
    await assert.rejects(() => searchProfiles('car'), SupabaseNotConfiguredError);
    await assert.rejects(() => fetchPlayerDetail('user-1'), SupabaseNotConfiguredError);
    await assert.rejects(() => adminSetCosmetics('user-1', {}), SupabaseNotConfiguredError);
    await assert.rejects(() => adminSetUnlocks('user-1', []), SupabaseNotConfiguredError);
    await assert.rejects(() => adminResetDay('user-1', '2026-08-06'), SupabaseNotConfiguredError);
    await assert.rejects(() => adminDeletePlayer('user-1'), SupabaseNotConfiguredError);
    await assert.rejects(() => adminRenamePlayer('user-1', 'NEWNAME'), SupabaseNotConfiguredError);
    await assert.rejects(() => adminListBlockedWords(), SupabaseNotConfiguredError);
    await assert.rejects(() => adminAddBlockedWords(['word']), SupabaseNotConfiguredError);
    await assert.rejects(() => adminRemoveBlockedWord('word-1'), SupabaseNotConfiguredError);
  });

  // The full day reset (§11aj) gets its own assertion rather than being folded
  // into the list above, because this is the one function on the page whose
  // failure mode matters: it must REJECT rather than resolve. Resolving to 0
  // would render as "Reset 2026-08-06 for everyone — 0 hands cleared", a
  // success notice for a call that never reached the database, and an admin
  // would reasonably conclude the day was already empty.
  test('the full day reset rejects rather than resolving to a plausible zero', async () => {
    await assert.rejects(() => adminResetTodayForEveryone(), SupabaseNotConfiguredError);
    // Its one argument is a rollover GUARD, not a day selector (migration 020),
    // so it must fail exactly the same way whether or not a day is supplied —
    // there is no separate code path for a caller that names a date.
    await assert.rejects(() => adminResetTodayForEveryone('2026-08-06'), SupabaseNotConfiguredError);
  });
});
