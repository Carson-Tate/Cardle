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

export const isSupabaseConfigured = SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';

// Only import/construct the real client once configured — importing the SDK
// eagerly is harmless, but constructing a client against the placeholder
// strings would throw (createClient validates the URL), which would break
// the whole page (including the parts that don't need login at all, like the
// daily hand and the help modal) before the user has had a chance to fill
// these in.
export const supabase = isSupabaseConfigured
  ? await importAndCreateClient()
  : null;

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

// Shared guard for auth.js/friends.js — every function that needs a live
// connection calls this first, so "Supabase isn't configured yet" surfaces
// as one clear, consistent error message everywhere instead of each call
// site hitting its own confusing null-reference failure.
export function requireSupabase() {
  if (!supabase) throw new SupabaseNotConfiguredError();
  return supabase;
}
