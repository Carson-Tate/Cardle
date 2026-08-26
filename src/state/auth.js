// Account auth (DESIGN.md §11) — email magic link (owner's choice over
// password or OAuth: "no passwords to manage... simplest to build and to
// use"). Supabase's own `auth.users` table only knows email/id — a
// public-facing username is app-level data this module also owns, stored in
// the `profiles` table (supabase/schema.sql) and created via a one-time
// prompt the first time a new user signs in (see createProfile below).

import { getSupabase, requireSupabase } from './supabase-client.js';
import { isTestAccountActive, testAccountSession, testAccountProfile } from './test-account.js';
// Only the two account-marker helpers, and only from resolveSession() below —
// they are the one piece of session state that has to survive a page load the
// SDK could not complete. Every localStorage touch in there is guarded, so
// importing this under plain Node (where there is no `localStorage`) is safe.
import { rememberAccount, forgetAccount } from './persistence.js';

export { SupabaseNotConfiguredError } from './supabase-client.js';

// Sends a one-time sign-in link to `email`. No account/password step —
// clicking the link in that email signs the browser in directly (creating
// the underlying auth.users row automatically on first use). The redirect
// target is wherever the app is currently being served from, so this works
// unmodified across local dev and any deployed URL, as long as that exact
// origin is also added to the Supabase project's Auth → URL Configuration →
// Redirect URLs allow-list (Supabase rejects redirects to origins it wasn't
// told about, as a phishing safeguard).
export async function signInWithMagicLink(email) {
  const client = await requireSupabase();
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

/**
 * Redeems a sign-in LINK that landed on our own domain carrying a `token_hash`
 * (DESIGN.md §11o) — the other half of `supabase/email-templates/magic-link.html`.
 *
 * WHY THE LINK POINTS HERE AND NOT AT SUPABASE. The stock template's
 * `{{ .ConfirmationURL }}` is Supabase's own `/auth/v1/verify` GET endpoint,
 * which redeems the token on request and then redirects. Anything that FOLLOWS
 * a link in an email therefore burns the sign-in: Outlook Safe Links, corporate
 * mail filters, antivirus scanners and link prefetchers all do this, and the
 * player's own tap then fails as "invalid or expired" through no fault of
 * theirs. A `token_hash` link is inert to all of them, because redeeming it
 * requires running JavaScript — which scanners do not do.
 *
 * It also keeps the visible URL on cardle.lol instead of a supabase.co
 * redirector, and lets a failure surface as a real message rather than the
 * player silently landing on a logged-out home page.
 *
 * @param {string} tokenHash - the `token_hash` query param from the link
 * @param {string} [type] - the link's own `type` param, passed straight
 *   through. A returning player's link is `magiclink` and a brand-new sign-up's
 *   is `signup`; taking it from the URL means this never has to guess which
 *   email the player was actually sent.
 * @returns {Promise<object>} the new session
 */
export async function verifySignInLink(tokenHash, type = 'magiclink') {
  const client = await requireSupabase();
  const { data, error } = await client.auth.verifyOtp({
    token_hash: String(tokenHash ?? '').trim(),
    type: String(type || 'magiclink'),
  });
  if (error) throw error;
  return data.session;
}

/**
 * Completes a sign-in with a 6-digit code instead of the link.
 *
 * DELIBERATELY RETAINED THOUGH NOTHING CALLS IT (owner's decision, §11o). It is
 * the only escape hatch for the one case no link can solve: a mail app whose
 * in-app browser has its own storage (Gmail on iOS, Outlook mobile). The link
 * opens there, Supabase writes the session to THAT webview's `localStorage`,
 * and it dies with the webview — the player's real browser never saw it, and no
 * site can write into another browser's storage. A code is typed into the tab
 * that ASKED for it, so the session lands where the player already is.
 *
 * The UI for it was removed because offering a code and a button at once was
 * confusing. Re-enabling means adding `{{ .Token }}` to the email template and
 * a code input to header.js's login modal; the state half is this function.
 *
 * @param {string} email - the address the code was sent to; Supabase matches
 *   the code against it, so it must be the one signInWithMagicLink used.
 * @param {string} code - the 6-digit token from the email
 * @returns {Promise<object>} the new session
 */
export async function verifyEmailOtp(email, code) {
  const client = await requireSupabase();
  const { data, error } = await client.auth.verifyOtp({
    email: String(email ?? '').trim(),
    token: String(code ?? '').trim(),
    type: 'email',
  });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const client = await requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

/**
 * Who is playing, AND how confident we are about the answer.
 *
 * THE THIRD STATE IS THE WHOLE POINT. getSession() below collapses "the
 * backend says nobody is signed in" and "we could not reach the backend to
 * ask" into the same `null`, which is right for the header (paint the
 * logged-out chrome; §11i already fixed the flash) and WRONG for the board.
 * board.js reads that null as "play anonymously", mints a fresh local seed,
 * and deals a completely different hand — while the account hand the server
 * is holding sits untouched with `result: null`. The player sees their run
 * replaced by a worse one with no error, no hint and nothing to retry.
 *
 * Same shape, and the same lesson, as §11i's login flash: an unknown value
 * must not default to one of the two known ones.
 *
 * @returns {Promise<{status: 'signed-in'|'signed-out'|'unavailable', session: object|null, error?: Error}>}
 */
export async function resolveSession() {
  if (isTestAccountActive()) return { status: 'signed-in', session: testAccountSession() };

  let client;
  try {
    client = await getSupabase();
  } catch (error) {
    return { status: 'unavailable', session: null, error };
  }
  // Not configured at all is a genuine, permanent "signed out" — there is no
  // backend to be unavailable, so retrying would never help.
  if (!client) return { status: 'signed-out', session: null };

  try {
    const {
      data: { session },
    } = await client.auth.getSession();
    if (session) {
      rememberAccount();
      return { status: 'signed-in', session };
    }
    // A real answer from a reachable backend — this browser is signed out,
    // and stays that way until someone signs in again.
    forgetAccount();
    return { status: 'signed-out', session: null };
  } catch (error) {
    // The SDK loaded but could not answer — an expired refresh token whose
    // refresh call failed, a storage lock timeout, a corrupt session blob.
    // Still "we don't know", not "nobody".
    return { status: 'unavailable', session: null, error };
  }
}

// Null when Supabase isn't configured yet — callers that only need to know
// "is anyone logged in" (e.g. the header's initial render) can use this
// without needing to handle the not-configured case as an error.
//
// Deliberately still collapses `unavailable` to null: for chrome, "show the
// logged-out header" is the correct response to both. Anything that DEALS A
// HAND or writes a result must use resolveSession() instead.
export async function getSession() {
  const { session } = await resolveSession();
  return session;
}

// Wraps Supabase's own onAuthStateChange — fires immediately on subscribe
// with the current session (or null), then again on every sign-in/sign-out.
// Returns an unsubscribe function. A no-op subscription (never calls back,
// returns a no-op unsubscribe) when Supabase isn't configured, so header.js
// can wire this up unconditionally without an extra existence check.
export function onAuthStateChange(callback) {
  // Local test account: report it once and never subscribe.
  //
  // THIS IS LOAD-BEARING, not symmetry with getSession(). Supabase fires this
  // immediately on subscribe with INITIAL_SESSION — and since nobody is really
  // signed in, that value is `null`, which promptly overwrote the fake session
  // getSession() had just supplied. The header ended up showing "Log In" while
  // getSession() still cheerfully returned a session, which is exactly what the
  // owner reported. Delivered in a microtask so callers see the same async
  // shape the real subscription gives them.
  if (isTestAccountActive()) {
    queueMicrotask(() => callback(testAccountSession()));
    return () => {};
  }
  // Stays synchronous for callers (header.js wires this up during its own
  // sync init and needs an unsubscribe handle immediately) even though the
  // client is now loaded on demand — the real subscription attaches once it
  // resolves, and `cancelled` covers the case where the caller unsubscribed
  // before that happened. A client that never loads (not configured, or the
  // CDN is unreachable) just means the callback never fires, exactly as the
  // not-configured case already behaved.
  let subscription = null;
  let cancelled = false;
  getSupabase()
    .then((client) => {
      if (!client || cancelled) return;
      ({
        data: { subscription },
      } = client.auth.onAuthStateChange((_event, session) => callback(session)));
    })
    .catch(() => {}); // accounts are simply unavailable this session
  return () => {
    cancelled = true;
    subscription?.unsubscribe();
  };
}

// `profiles.id` matches `auth.users.id` 1:1 (supabase/schema.sql) — null
// means this auth user exists but hasn't picked a username yet (a brand new
// sign-up), which is the header's cue to prompt for one via createProfile.
export async function getProfile(userId) {
  if (isTestAccountActive()) return testAccountProfile();
  const client = await requireSupabase();
  const { data, error } = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function isValidUsername(username) {
  return USERNAME_PATTERN.test(username);
}

// The SQLSTATE the `profiles` blocklist trigger raises
// (supabase/migrations/012-username-blocklist.sql). A custom code rather than a
// message match, because error WORDING is a PostgREST/Postgres implementation
// detail that can change under us — the same reasoning that made createProfile
// ask the database which unique constraint collided instead of reading the text.
// This code is ours, raised by our own trigger, so it is stable by construction.
export const USERNAME_BLOCKED_CODE = 'CRDL1';

/**
 * Whether a username can actually be claimed — free, well-formed, and not
 * blocked.
 *
 * Deliberately ONE boolean rather than a reason. The word list lives in a table
 * with no read policy precisely so it cannot be recited, and an endpoint that
 * distinguished "blocked" from "taken" would let anyone enumerate it a guess at
 * a time. Whether a name is taken is already public — every leaderboard row is
 * a username — so collapsing the two leaks nothing new.
 *
 * Resolves TRUE when the check itself cannot run (no Supabase, offline, an
 * unrun migration). This is a pre-flight courtesy for the sign-up form; the
 * trigger is the actual enforcement, and failing open here only means the
 * player learns on submit instead of while typing. Failing CLOSED would lock
 * new sign-ups out entirely the moment the CDN hiccuped.
 */
export async function isUsernameAvailable(candidate) {
  if (!isValidUsername(String(candidate ?? '').trim())) return false;
  try {
    const client = await requireSupabase();
    const { data, error } = await client.rpc('username_available', { candidate });
    if (error) throw error;
    return data !== false;
  } catch {
    return true;
  }
}

/**
 * The stored form of a username: trimmed and UPPERCASED (owner: "i would like to
 * change all names to all caps and all future names to be all caps").
 *
 * Uppercasing at the boundary — once, here — rather than at each call site, so
 * "what a username looks like in the database" has a single answer. Every write
 * goes through this, and every exact-match lookup does too, because a stored
 * 'CAR' will not be found by `.eq('username', 'car')`: a `?profile=car` link
 * someone shared before this change, or a friend request typed in lower case,
 * must both still resolve.
 *
 * Input is still accepted in any case — players type naturally and the display
 * form is derived, not demanded.
 *
 * Deliberately NOT `toLocaleUpperCase()`. That is locale-sensitive: in Turkish
 * locales 'i' uppercases to 'İ' (dotted capital I), which is outside the
 * `[A-Za-z0-9_]` pattern the schema enforces — so a Turkish player naming
 * themselves "iris" would have had it rejected by the CHECK constraint. The
 * pattern is ASCII-only, so the transform must be too.
 */
export function normalizeUsername(username) {
  return String(username ?? '').trim().toUpperCase();
}

// Creates the one-time username row for a newly signed-in user. The
// `profiles.username` unique constraint (schema.sql) is the actual source of
// truth for "is this name taken" — Supabase surfaces that as a Postgres
// unique-violation error (code 23505), re-thrown here with a message a
// username-picker UI can show directly instead of a raw Postgres error.
export async function createProfile(userId, rawUsername) {
  // Validated on the typed form, stored in the normalized one — so the error
  // message quotes what the player actually entered, but the row is uppercase.
  const typed = String(rawUsername ?? '').trim();
  if (!isValidUsername(typed)) {
    throw new Error('Usernames must be 3-20 characters: letters, numbers, and underscores only.');
  }
  const username = normalizeUsername(typed);
  const client = await requireSupabase();
  const { data, error } = await client.from('profiles').insert({ id: userId, username }).select().single();
  if (!error) return data;

  // `profiles` has TWO unique constraints — `id` (primary key) and `username` —
  // and Postgres reports BOTH as error code 23505. This used to assume 23505
  // always meant the username collided, so a player whose profile row already
  // existed (a first attempt that partly succeeded, or a duplicate prompt) hit
  // the PRIMARY KEY and was told their perfectly-free name was "already taken"
  // — owner bug report: "fix name already taken when making a new username".
  //
  // Distinguished by asking the database which is actually true, rather than by
  // pattern-matching the error text (whose wording is a PostgREST/Postgres
  // implementation detail that could change): if a row for this user already
  // exists, the id collided and the right move is to return that row — the
  // player IS that profile, so this self-heals instead of dead-ending them.
  if (error.code === '23505') {
    const existing = await getProfile(userId).catch(() => null);
    if (existing) return existing;
    throw new Error(`"${username}" is already taken — try another.`);
  }

  // Refused by the blocklist trigger. The wording says nothing about WHY, and
  // that is the point: naming the matched word would confirm what is on a list
  // deliberately kept unreadable, and would read as the site repeating a slur
  // back at whoever typed it. "Not available" is also the honest answer for the
  // player who tripped a false positive and has done nothing wrong.
  if (error.code === USERNAME_BLOCKED_CODE) {
    throw new Error(`"${username}" isn't available — please choose another.`);
  }
  throw error;
}
