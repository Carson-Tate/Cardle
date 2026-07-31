import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUsername, normalizeUsername, signInWithMagicLink, signOut, getSession, onAuthStateChange, getProfile, createProfile, isUsernameAvailable, USERNAME_BLOCKED_CODE, SupabaseNotConfiguredError } from '../src/state/auth.js';
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

// The username blocklist's CLIENT half (§11x). The matching itself lives in
// Postgres — deliberately, since `profiles` is reachable straight from the
// browser and a JavaScript word check is bypassed by one curl — so what is
// testable here is the contract around it, not the word list.
describe('isUsernameAvailable', () => {
  test('rejects a malformed name without asking the server at all', async () => {
    // No network is reachable in this environment, so a `true` here would prove
    // the format short-circuit ran before any RPC was attempted.
    assert.equal(await isUsernameAvailable('ab'), false);
    assert.equal(await isUsernameAvailable('has space'), false);
    assert.equal(await isUsernameAvailable(''), false);
    assert.equal(await isUsernameAvailable(null), false);
  });

  // FAILING OPEN IS THE POINT. This is a courtesy check for the sign-up form and
  // the database trigger is the real enforcement, so an unreachable backend must
  // not be able to refuse every name and lock new players out of signing up.
  test('fails OPEN when the check cannot run, so sign-up is never blocked by an outage', async () => {
    assert.equal(await isUsernameAvailable('perfectly_fine'), true);
  });

  test('exports the trigger SQLSTATE as a constant rather than leaving it inline', () => {
    // Matched against `error.code` in createProfile. Pinned here because the
    // value has to agree with migration 012 and nothing else would catch a typo.
    assert.equal(USERNAME_BLOCKED_CODE, 'CRDL1');
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

// Usernames are stored uppercase (§11n). The transform is tiny, but it sits on
// every write AND every exact-match lookup, so getting it wrong makes players
// unfindable rather than merely misspelt.
describe('normalizeUsername', () => {
  test('uppercases and trims', () => {
    assert.equal(normalizeUsername('car'), 'CAR');
    assert.equal(normalizeUsername('  Card_le42  '), 'CARD_LE42');
    assert.equal(normalizeUsername('ALREADY'), 'ALREADY');
  });

  test('is idempotent — normalizing twice changes nothing', () => {
    for (const name of ['car', 'MiXeD', '  pad  ', 'a_b_9']) {
      assert.equal(normalizeUsername(normalizeUsername(name)), normalizeUsername(name));
    }
  });

  test('never throws on junk, and yields the empty string', () => {
    assert.equal(normalizeUsername(null), '');
    assert.equal(normalizeUsername(undefined), '');
    assert.equal(normalizeUsername(''), '');
    assert.equal(normalizeUsername('   '), '');
  });

  test('output still satisfies the stored-username pattern', () => {
    // The schema CHECK is ASCII-only, so the transform must not introduce a
    // character outside it. This is why the implementation uses toUpperCase()
    // rather than toLocaleUpperCase(), whose Turkish 'i' -> '\u0130' would be
    // rejected by the constraint.
    for (const name of ['car', 'iris', 'Istanbul', 'a_b_9', 'ii']) {
      const normalized = normalizeUsername(name);
      if (!isValidUsername(name)) continue; // only names that were legal to begin with
      assert.ok(
        isValidUsername(normalized),
        `${JSON.stringify(name)} normalized to ${JSON.stringify(normalized)}, which the pattern rejects`,
      );
    }
  });

  test("a dotted-capital-I never appears (the Turkish-locale trap)", () => {
    assert.equal(normalizeUsername('iris'), 'IRIS');
    assert.ok(!normalizeUsername('iris').includes('\u0130'));
  });
});
