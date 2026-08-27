// The signed-in player's own suspension (DESIGN.md §11ap).
//
// `public.suspensions` has an own-rows-only select policy, so this reads the
// caller's row and can learn nothing about anybody else's — which is the whole
// point of the suspension living in its own table rather than as a column on
// world-readable `profiles`.

import { requireSupabase } from './supabase-client.js';

/**
 * The caller's un-lifted suspension row, or null.
 *
 * RESOLVES NULL ON ANY FAILURE, and that choice deserves stating because it is
 * the opposite of what a security feature usually wants. This read decides what
 * to DISPLAY, not what is permitted: the `daily_plays` insert trigger is what
 * actually stops a suspended player, and it runs whether or not this call
 * succeeded. So failing open here costs a banner, while failing closed would
 * mean an unapplied migration 026 — or one bad request — locking every player
 * out of a game they are entitled to play.
 *
 * The two halves therefore fail in the same direction as §11al's stacked deals:
 * the worst case is a suspended player who is refused without being told why,
 * which is a bad message rather than an unearned hand.
 */
export async function fetchMySuspension(userId) {
  if (!userId) return null;
  try {
    const client = await requireSupabase();
    const { data, error } = await client
      .from('suspensions')
      .select('suspended_until, reason, created_at, lifted_at')
      .eq('user_id', userId)
      .is('lifted_at', null)
      .maybeSingle();
    if (error) {
      // A missing table (unapplied 026) is expected during rollout and is not
      // worth shouting about; anything else might be.
      if (error.code !== '42P01' && error.code !== 'PGRST205') {
        console.warn('Could not read your suspension status:', error?.message ?? error);
      }
      return null;
    }
    return data ?? null;
  } catch (error) {
    console.warn('Could not read your suspension status:', error?.message ?? error);
    return null;
  }
}

/**
 * Whether an error from claiming a hand was the suspension trigger refusing.
 *
 * `insufficient_privilege` (42501) is raised by name in migration 026, so this
 * is a contract rather than message-matching. Exported and pure for the same
 * reason as `isWrongGameDay` (§11ak/§11ao): it is one line that decides which
 * screen a player sees, and its caller needs a live Supabase client.
 *
 * Compared as a string because the code crosses HTTP and JSON — a shape change
 * must not silently turn this into "never fires", which would show a suspended
 * player the generic connection-failure screen instead of their banner.
 */
export function isSuspendedError(error) {
  return String(error?.code) === '42501';
}
