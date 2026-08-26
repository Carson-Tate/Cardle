// Account-backed daily play (DESIGN.md §11c) — backed by the `daily_plays`
// table (supabase/schema.sql). Only used for signed-in players; an
// anonymous player's daily state stays entirely local (persistence.js), and
// is never written here (owner request: "not save the score if they are not
// logged in", matching RNGDLE's own approach).

import { requireSupabase } from './supabase-client.js';
import { freshSeed } from '../core/deck.js';
import { gameDayFor } from '../core/game-day.js';

// The GAME day (DESIGN.md §11l), which is what `daily_plays.play_date` means —
// one row per player per game day, rolling at 7pm New York.
function isoDate(date) {
  return gameDayFor(date);
}

// Claims (or re-fetches) `userId`'s row for `date` — the FIRST call each day
// generates a fresh seed and inserts it, locking in that seed as theirs for
// the day; every later call that same day (reloads, resuming mid-game) just
// reads the same row back rather than claiming a new one. Returns
// `{ seed, result }` — `result` is null until they've locked in a hand.
export async function claimTodaySeed(userId, date = new Date()) {
  const client = await requireSupabase();
  const playDate = isoDate(date);

  const existing = await fetchRow(client, userId, playDate);
  if (existing) return { seed: Number(existing.seed), result: existing.result };

  const seed = freshSeed();
  const { data: inserted, error: insertError } = await client
    .from('daily_plays')
    .insert({ user_id: userId, play_date: playDate, seed })
    .select('seed, result')
    .single();
  if (!insertError) return { seed: Number(inserted.seed), result: inserted.result };

  // Lost a race to claim today's row (e.g. two tabs opened at once) — the
  // other insert won, so read back whatever it actually claimed rather than
  // erroring out.
  if (insertError.code === '23505') {
    const raced = await fetchRow(client, userId, playDate);
    if (raced) return { seed: Number(raced.seed), result: raced.result };
  }
  throw insertError;
}

/**
 * Whether a locally-mirrored run (persistence.js's pending-run storage, §11ak)
 * may be resubmitted against the seed the server is currently holding.
 *
 * THIS IS THE WHOLE SAFETY ARGUMENT for resubmitting without asking the
 * player. A pending run is a finished hand that was scored locally and whose
 * POST never landed — resending it is the identical request that was already
 * in flight, not a second attempt at the day, but ONLY if it was computed
 * from the same deal. `daily_plays.seed` is re-rolled whenever the row is
 * deleted (an admin day reset, §11aj) and is different on a new game day, so
 * a stale mirror could otherwise be replayed onto a hand it never saw.
 *
 * Pure and exported so the rule is testable in Node: the storage it reads
 * from is localStorage-bound and the caller is a DOM module, which between
 * them would have left the one genuinely dangerous line covered only by a
 * browser test.
 *
 * Compares as numbers, not identities: the seed makes a round trip through
 * both JSON and a Postgres `bigint`, and PostgREST is entitled to hand back a
 * string for the latter. `claimTodaySeed` already coerces for exactly that
 * reason, and a strict `!==` here against a string would silently discard
 * every recoverable run instead of restoring it — a failure that looks
 * identical to this feature not existing.
 */
export function pendingRunMatches(pending, seed) {
  if (!pending || typeof pending !== 'object' || !pending.result) return false;
  const stored = numericSeed(pending.seed);
  const claimed = numericSeed(seed);
  return stored !== null && claimed !== null && stored === claimed;
}

// `Number()` is too generous to use directly here: it maps null, undefined and
// '' all to 0, so an absent stored seed would compare EQUAL to an absent
// claimed one and a run with no provenance would be resubmitted against a hand
// it has no relationship to. Null means "not a seed", and two of those are not
// a match.
function numericSeed(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchRow(client, userId, playDate) {
  const { data, error } = await client
    .from('daily_plays')
    .select('seed, result')
    .eq('user_id', userId)
    .eq('play_date', playDate)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Submits a finished run for SERVER-SIDE scoring (DESIGN.md §11z).
 *
 * The client no longer sends a score. It sends the only thing it is actually
 * entitled to decide — which cards were thrown away — and the `submit-run` Edge
 * Function re-deals from the seed it has held since before the hand existed,
 * replays those discards, and computes the total itself.
 *
 * WHY THE CHANGE. `result` is jsonb, and this used to write it wholesale: RLS
 * restricted which ROW you could touch but nothing restricted what you put in
 * it, and the leaderboard reads the score straight out of that blob. Any
 * signed-in player could PATCH their own row with any total they liked.
 *
 * FALLS BACK TO THE DIRECT WRITE while the function is being rolled out, so
 * deploy order cannot cost a player their run. Once migration 015 revokes the
 * client's `update (result)` grant the fallback stops being possible — which is
 * the point, and is why 015 must be run only AFTER the function is confirmed
 * working. The fallback is what makes that ordering safe rather than a cutover.
 *
 * @returns {Promise<object|null>} the server's authoritative result when it
 *   scored the run, or null when the fallback wrote the client's own. Callers
 *   should prefer the returned value over what they computed locally.
 */
export async function saveTodayResultForUser(userId, result, date = new Date()) {
  const client = await requireSupabase();

  try {
    const { data, error } = await client.functions.invoke('submit-run', {
      body: {
        // The only free input. An ordered list of rounds, because Second Wind
        // discards twice and each round draws from what the previous left.
        discardRounds: result.discardRounds ?? [result.discardIndices ?? []],
        wagered: result.wagered === true,
        dayNumber: result.dayNumber,
        // Advisory only, and bounded server-side: these feed display and capped
        // terms, never the leaderboard total.
        evContext: result.evContext,
        decisionRating: result.decisionRating,
        meters: result.meters,
        personalityId: result.personalityId,
        newlyUnlocked: result.newlyUnlocked,
      },
    });
    if (error) throw error;
    if (data?.result) return data.result;
    // A 2xx with no result means the function ran but refused the run — treat
    // it as a real failure rather than silently falling back to writing the
    // client's own number, which would defeat the entire exercise.
    throw new Error(data?.error ?? 'the run was not accepted');
  } catch (error) {
    // ALREADY FINISHED IS A SUCCESS, NOT A FAILURE — and getting this wrong is
    // what made a dropped submission unrecoverable (§11ak). The function
    // answers 409 both for "no hand claimed today" and for "today is already
    // finished", and the second one is precisely what a RETRY of a submission
    // that actually landed looks like: the POST was cancelled by a navigation
    // before its response came back, so the client never learned it had won.
    // Treating that as fatal meant the only safe recovery was no recovery.
    //
    // Reading the row back is what disambiguates the two — a stored result
    // means the run is in, and it is the SERVER'S result, which is the one the
    // player should be shown either way (§11z). Nothing is trusted from the
    // client here; this is a read.
    if (isConflict(error)) {
      const finished = await fetchRow(client, userId, isoDate(date)).catch(() => null);
      if (finished?.result) return finished.result;
    }
    // Only the "function is not deployed yet" case may fall through. Anything
    // else — a rejected run, a genuinely unclaimed day, a 422 — must surface,
    // or a cheat would be quietly retried through the unverified path.
    if (!isFunctionMissing(error)) throw error;
    // NAMES CORS EXPLICITLY, because a blocked preflight is indistinguishable
    // from a missing function here — both surface as "failed to fetch" — and
    // that ambiguity already cost us once: the function was deployed and
    // working, its allow-headers list just omitted the `apikey` and
    // `x-client-info` headers supabase-js sends, so the browser refused to send
    // the POST at all. Everything looked fine and nothing was verified.
    console.warn(
      'submit-run did not run; falling back to the direct write. If the function IS deployed, ' +
        'check its CORS Access-Control-Allow-Headers — a blocked preflight looks identical to a 404 here.',
      error?.message ?? error,
    );
  }

  const { error } = await client.from('daily_plays').update({ result }).eq('user_id', userId).eq('play_date', isoDate(date));
  if (error) throw error;
  return null;
}

// The Edge Function's two refusals (supabase/functions/submit-run/index.ts)
// both come back as 409. Only the caller above can tell them apart, and only
// by looking at what is actually stored.
function isConflict(error) {
  return (error?.context?.status ?? error?.status) === 409;
}

// Distinguishes "the Edge Function has not been deployed" from "it ran and said
// no". Supabase surfaces a missing function as a 404 from the functions gateway;
// a network failure reaching it looks the same from here and is treated the same
// way, since both mean the run was never actually judged.
function isFunctionMissing(error) {
  const status = error?.context?.status ?? error?.status;
  if (status === 404) return true;
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('failed to fetch') || message.includes('failed to send');
}
