import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUsername, signInWithMagicLink, signOut, getSession, onAuthStateChange, getProfile, createProfile, SupabaseNotConfiguredError } from '../src/state/auth.js';
import { isSupabaseConfigured } from '../src/state/supabase-client.js';
import { updateUsername } from '../src/state/profile.js';

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

// updateUsername lives in state/, so it can't be exercised without a client —
// but its VALIDATION runs before any network call, which is exactly the part
// worth pinning: a rename must be held to the same rule as the original signup,
// not a looser one invented at the rename site (§11m).
describe('updateUsername validation', () => {
  test('rejects anything isValidUsername rejects, before touching the network', async () => {
    for (const bad of ['ab', 'a'.repeat(21), 'has space', 'has-dash', 'emoji😀', '', '   ']) {
      await assert.rejects(
        () => updateUsername('user-1', bad),
        /Usernames must be 3-20 characters/,
        `expected ${JSON.stringify(bad)} to be refused`,
      );
    }
  });

  test('trims surrounding whitespace before judging the name', async () => {
    // '  ab  ' is too short once trimmed, so it must be refused for LENGTH
    // rather than accidentally passing as a 6-character name.
    await assert.rejects(() => updateUsername('user-1', '  ab  '), /3-20 characters/);
  });

  test('a null or undefined name is refused rather than throwing a type error', async () => {
    await assert.rejects(() => updateUsername('user-1', null), /3-20 characters/);
    await assert.rejects(() => updateUsername('user-1', undefined), /3-20 characters/);
  });
});
