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

// The SDK version, pinned. Was `@supabase/supabase-js@2` — a MAJOR RANGE, which
// is what broke sign-in on mobile (owner: "importing a module script failed").
//
// Two separate problems came from that one `@2`:
//
//  1. esm.sh picks a build target by SNIFFING THE USER-AGENT and 302s to e.g.
//     `/es2022/supabase-js.mjs`. An in-app webview (Gmail iOS, Outlook mobile,
//     Instagram) or a very new iOS Safari can present a UA esm.sh doesn't
//     recognise, and the build it falls back to may use syntax that WebKit
//     can't parse. A module that fails to PARSE rejects the dynamic import, and
//     WebKit's message for that is literally "Importing a module script
//     failed." — the exact error reported. Pinning `?target=` removes the
//     sniffing entirely, so every device gets a build we have actually tested.
//  2. An unpinned range silently re-resolves per request, so two devices could
//     load different SDK builds an hour apart. That also made a load-bearing
//     DEFAULT unpinned: this code relies on the auth flow defaulting to
//     `implicit`, and a future 2.x switching it to `pkce` would break the
//     magic-link handoff with no change on our side (see flowType below).
//
// Bumping this is a deliberate act: check the release notes for a flowType or
// storage default change before you do.
const SUPABASE_VERSION = '2.111.0';

// es2020 is old enough for every browser that can run ES modules at all
// (including the WebKit builds in mail-app webviews) and new enough that the
// SDK isn't shipped through a heavy down-level transform.
const SDK_TARGET = 'es2020';

// Tried in order. Two INDEPENDENT CDNs rather than one, because a mobile
// content blocker (1Blocker, AdGuard, Brave shields) or a captive network can
// blackhole a single third-party origin — and unlike desktop, that's common
// enough on mobile to be a real failure mode rather than an edge case. The
// project has no build step by design, so vendoring the SDK isn't available as
// an option; a second origin is the next best thing.
const SDK_SOURCES = [
  `https://esm.sh/@supabase/supabase-js@${SUPABASE_VERSION}?target=${SDK_TARGET}`,
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_VERSION}/+esm`,
];

async function importAndCreateClient() {
  let lastError = null;
  for (const source of SDK_SOURCES) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential fallback is the point
      const { createClient } = await import(/* @vite-ignore */ source);
      return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, CLIENT_OPTIONS);
    } catch (error) {
      lastError = error;
    }
  }
  throw new SupabaseUnavailableError(lastError);
}

// Every one of these is already the SDK default. They are written out anyway
// because each is load-bearing for a bug the owner actually hit, and a default
// is exactly the kind of thing that changes under you on a version bump.
const CLIENT_OPTIONS = {
  auth: {
    // THE MAGIC-LINK HANDOFF DEPENDS ON THIS. Mobile mail apps open a link in
    // an isolated in-app webview, which then hands off to the default browser —
    // so the browser that REDEEMS the link is frequently not the one that
    // requested it. `implicit` redeems a `token_hash` server-side and needs
    // nothing from local storage, so it survives that handoff. `pkce` stores a
    // `code_verifier` in the requesting browser's localStorage and would fail
    // every single time, looking exactly like an expired link.
    flowType: 'implicit',
    // The session lives in localStorage and is refreshed in the background, so
    // a closed-and-reopened tab is still signed in.
    persistSession: true,
    autoRefreshToken: true,
    // Inert for us — the emailed link carries `?token_hash=` as a QUERY param,
    // never an `#access_token` fragment (see supabase/email-templates/) — but
    // pinned so it stays inert.
    detectSessionInUrl: true,
  },
};

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super("Supabase isn't set up yet — fill in src/state/supabase-client.js with your project's URL and anon key.");
    this.name = 'SupabaseNotConfiguredError';
  }
}

/**
 * The SDK itself could not be downloaded or parsed — a blocked CDN, an offline
 * device, a captive portal.
 *
 * DISTINCT FROM every other auth error on purpose. Callers used to see only
 * "something threw" and reported it to the player as a dead sign-in link, which
 * sent the owner hunting an expiry bug for a failure that had nothing to do with
 * the token. Anything catching auth errors should check for this first.
 */
export class SupabaseUnavailableError extends Error {
  constructor(cause) {
    super("Couldn't reach the sign-in service — check your connection, or try again with any content blocker paused.");
    this.name = 'SupabaseUnavailableError';
    this.cause = cause;
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
