import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendFriendRequest,
  getPendingRequests,
  getPendingRequestCount,
  getFriends,
  acceptFriendRequest,
  removeFriendship,
} from '../src/state/friends.js';
import { SupabaseNotConfiguredError } from '../src/state/supabase-client.js';

// Same reasoning as auth.test.js: no live Supabase project in this test
// environment, so every function here should fail the same clear way.
describe('friends.js without a configured Supabase project', () => {
  test('every function throws SupabaseNotConfiguredError rather than a null-reference crash', async () => {
    await assert.rejects(() => sendFriendRequest('me', 'someone'), SupabaseNotConfiguredError);
    await assert.rejects(() => getPendingRequests('me'), SupabaseNotConfiguredError);
    // The notification badge's query. It must fail the same way as everything
    // else here rather than resolving to 0 on its own — header.js is what
    // decides a failure means "show no badge", and it can only make that call
    // if the failure actually reaches it.
    await assert.rejects(() => getPendingRequestCount('me'), SupabaseNotConfiguredError);
    await assert.rejects(() => getFriends('me'), SupabaseNotConfiguredError);
    await assert.rejects(() => acceptFriendRequest('some-id'), SupabaseNotConfiguredError);
    await assert.rejects(() => removeFriendship('some-id'), SupabaseNotConfiguredError);
  });
});
