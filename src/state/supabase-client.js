// Supabase client (DESIGN.md §11) — the project's one backend dependency,
// deliberately kept to a plain ESM CDN import rather than an npm package:
// nothing here needs a build step or a bundler, matching the rest of the
// project ("no server code to run or host", §11's own rationale for
// choosing Supabase in the first place).
//
// FILL THESE IN with your own Supabase project's values (Project Settings →
// API in the Supabase dashboard). The anon key is meant to be public/visible
// in client code — it's not a secret, it's a fixed, low-privilege key that
// only works within whatever Row Level Security policies the database
// defines (supabase/schema.sql). Nothing here is exploitable on its own.
const SUPABASE_URL = 'https://flwptlcekwllkwxcegcr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UqqZS4YwRQNik4JkQ7TXIg_C1xUOqlW';

// `import('https://esm.sh/...')` only works in a browser — Node's ESM loader
// rejects a remote https: specifier outright (`ERR_UNSUPPORTED_ESM_URL_SCHEME`),
// so this module must never attempt that import while running under
// `npm test`. Real credentials being filled in is exactly what surfaced
// this: `isSupabaseConfigured` (and therefore the dynamic import below)
// used to depend only on the URL/key strings, so the moment they stopped
// being placeholders, auth.js/friends.js's tests started crashing the whole
// suite at import time, not just at the specific assertions that needed a
// real connection. Gating on `isBrowser` too keeps Supabase permanently
// out of reach under Node regardless of what's filled in above — the same
// "this only works in a browser, tests skip it structurally" precedent
// persistence.js/stats.js already set (they need `localStorage`, which
// plain Node doesn't have either).
const isBrowser = typeof window !== 'undefined';

export const isSupabaseConfigured =
  isBrowser && SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';

// LAZY, and deliberately not a top-level `await`. This used to be
// `export const supabase = await importAndCreateClient()` — a top-level
// await on a THIRD-PARTY CDN fetch, which meant any failure to reach
// esm.sh (outage, corporate/school firewall, ad blocker, offline) left this
// module permanently un-evaluated. Because module evaluation is all-or-
// nothing, that took down every importer with it — auth.js → header.js →
// main.js and daily-play.js → board.js — so the ENTIRE game died on a blank
// "Loading today's hand…" with no header, no help modal, and no Draw
// button, even though the daily hand, scoring, and help text need no
// network at all. Verified by aborting all esm.sh requests in a real
// browser. Now the import happens on first actual use, so a CDN failure
// degrades to exactly what a logged-out player already gets (anonymous
// local play) instead of bricking the page.
//
// The promise is cached so concurrent callers share one client, and cleared
// on failure so a later call can retry (a transient network blip shouldn't
// disable accounts for the rest of the session).
let clientPromise = null;

export function getSupabase() {
  if (!isSupabaseConfigured) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = importAndCreateClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

async function importAndCreateClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super("Supabase isn't set up yet — fill in src/state/supabase-client.js with your project's URL and anon key.");
    this.name = 'SupabaseNotConfiguredError';
  }
}

// Shared guard for auth.js/friends.js/daily-play.js — every function that
// needs a live connection awaits this first, so "Supabase isn't configured
// yet" surfaces as one clear, consistent error message everywhere instead of
// each call site hitting its own confusing null-reference failure. Async
// since the underlying client is now loaded on demand (see getSupabase).
export async function requireSupabase() {
  const client = await getSupabase();
  if (!client) throw new SupabaseNotConfiguredError();
  return client;
}
