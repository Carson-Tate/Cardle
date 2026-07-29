import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUsername, signInWithMagicLink, signOut, getSession, onAuthStateChange, getProfile, createProfile, SupabaseNotConfiguredError } from '../src/state/auth.js';
import { isSupabaseConfigured } from '../src/state/supabase-client.js';

describe('isValidUsername', () => {
  test('accepts 3-20 characters of letters, numbers, and underscores', () => {
    assert.ok(isValidUsername('abc'));
    assert.ok(isValidUsername('Card_le_42'));
    assert.ok(isValidUsername('a'.repeat(20)));
  });

  test('rejects too short, too long, or characters outside the allowed set', () => {
    assert.ok(!isValidUsername('ab'));
    assert.ok(!isValidUsername('a'.repeat(21)));
    assert.ok(!isValidUsername('has space'));
    assert.ok(!isValidUsername('has-dash'));
    assert.ok(!isValidUsername('emoji😀'));
    assert.ok(!isValidUsername(''));
  });
});

// This project's test environment never has a real Supabase project
// configured (src/state/supabase-client.js's URL/anon key are still the
// placeholder strings) — so every function that needs a live connection
// should fail with one clear, consistent error rather than a confusing
// null-reference crash. This is the actual behavior anyone running `npm
// test` without having filled in their own Supabase project sees.
describe('auth.js without a configured Supabase project', () => {
  test('isSupabaseConfigured is false in this environment (sanity check for the tests below)', () => {
    assert.equal(isSupabaseConfigured, false);
  });

  test('getSession() resolves to null rather than throwing', async () => {
    assert.equal(await getSession(), null);
  });

  test('onAuthStateChange() returns a no-op unsubscribe and never calls back', () => {
    let called = false;
    const unsubscribe = onAuthStateChange(() => {
      called = true;
    });
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe(); // should not throw
    assert.equal(called, false);
  });

  test('signInWithMagicLink/signOut/getProfile/createProfile all throw SupabaseNotConfiguredError', async () => {
    await assert.rejects(() => signInWithMagicLink('a@b.com'), SupabaseNotConfiguredError);
    await assert.rejects(() => signOut(), SupabaseNotConfiguredError);
    await assert.rejects(() => getProfile('some-id'), SupabaseNotConfiguredError);
    await assert.rejects(() => createProfile('some-id', 'validname'), SupabaseNotConfiguredError);
  });
});
