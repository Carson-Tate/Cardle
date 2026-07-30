// Account auth (DESIGN.md §11) — email magic link (owner's choice over
// password or OAuth: "no passwords to manage... simplest to build and to
// use"). Supabase's own `auth.users` table only knows email/id — a
// public-facing username is app-level data this module also owns, stored in
// the `profiles` table (supabase/schema.sql) and created via a one-time
// prompt the first time a new user signs in (see createProfile below).

import { getSupabase, requireSupabase } from './supabase-client.js';

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

export async function signOut() {
  const client = await requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

// Null when Supabase isn't configured yet — callers that only need to know
// "is anyone logged in" (e.g. the header's initial render) can use this
// without needing to handle the not-configured case as an error.
export async function getSession() {
  // Also null (rather than a throw) when the Supabase SDK itself can't be
  // reached — a CDN/network failure should read as "nobody is logged in,"
  // which the whole anonymous-play path already handles, not as an error
  // that propagates into board.js's init.
  const client = await getSupabase().catch(() => null);
  if (!client) return null;
  const {
    data: { session },
  } = await client.auth.getSession();
  return session;
}

// Wraps Supabase's own onAuthStateChange — fires immediately on subscribe
// with the current session (or null), then again on every sign-in/sign-out.
// Returns an unsubscribe function. A no-op subscription (never calls back,
// returns a no-op unsubscribe) when Supabase isn't configured, so header.js
// can wire this up unconditionally without an extra existence check.
export function onAuthStateChange(callback) {
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
  const client = await requireSupabase();
  const { data, error } = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function isValidUsername(username) {
  return USERNAME_PATTERN.test(username);
}

// Creates the one-time username row for a newly signed-in user. The
// `profiles.username` unique constraint (schema.sql) is the actual source of
// truth for "is this name taken" — Supabase surfaces that as a Postgres
// unique-violation error (code 23505), re-thrown here with a message a
// username-picker UI can show directly instead of a raw Postgres error.
export async function createProfile(userId, username) {
  if (!isValidUsername(username)) {
    throw new Error('Usernames must be 3-20 characters: letters, numbers, and underscores only.');
  }
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
  throw error;
}
