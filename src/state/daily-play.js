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
  try {
    return await claimForDay(client, userId, isoDate(date));
  } catch (error) {
    // OUR CLOCK DISAGREES WITH THE SERVER'S (§11ao). `gameDayFor` reads the
    // BROWSER's clock, so a machine that is wrong — or merely a few seconds
    // either side of the 19:00 New York boundary — computes a different game
    // day than `game_today()` does, and migration 025 pins the claim to
    // exactly today. Rather than widen the pin (which is what let somebody sit
    // on tomorrow's row in the first place), ask the server what day it is and
    // try once more.
    //
    // Costs nothing on the path everyone takes: this runs only after a claim
    // has already been refused for this specific reason.
    if (!isWrongGameDay(error)) throw error;
    const serverDay = await fetchServerGameDay(client);
    // Rethrow the ORIGINAL error, not whatever the lookup did. The claim
    // failing is what the caller has to handle, and §11ak's screen reads better
    // for it than a confusing secondary failure would.
    if (!serverDay) throw error;
    return await claimForDay(client, userId, serverDay);
  }
}

// `check_violation`, raised by name in migration 025 so this is a stable
// contract rather than string-matching the message. PostgREST surfaces the
// SQLSTATE as `code`.
//
// EXPORTED AND PURE so the one dangerous line here is unit-tested rather than
// left to a browser test — the same reasoning as `pendingRunMatches` below
// (§11ak). It decides between "retry the claim on a different day" and
// "rethrow", and too BROAD is the dangerous direction: a 23505 is the two-tabs
// race, which already has its own recovery, and retrying THAT against a
// server-supplied day would re-enter the claim for a row that already exists.
//
// Compared as a STRING rather than with `===` against one, because the code
// crosses HTTP and JSON to get here and "fails closed" is the bad direction for
// a recovery path: it would silently never fire and look exactly like a feature
// that was never built (§11ak, where the seed compare had this precise bug).
// `String(undefined)` and `String(null)` are harmlessly not '23514'.
export function isWrongGameDay(error) {
  return String(error?.code) === '23514';
}

// `game_today()` is already granted to `authenticated` and `anon` (migration
// 007) — the same function the trigger checks against, so there is exactly one
// definition of the game day and no second one to drift.
async function fetchServerGameDay(client) {
  const { data, error } = await client.rpc('game_today');
  if (error) {
    console.warn('Could not read the server game day:', error?.message ?? error);
    return null;
  }
  return typeof data === 'string' ? data : null;
}

async function claimForDay(client, userId, playDate) {
  // FETCHED IN PARALLEL WITH THE ROW, so the common path — a reload, or coming
  // back after playing — costs no extra round trip for a feature that is
  // almost never active (§11al). Only the first claim of the day has to look
  // again, because the deal is attached to the row by a trigger DURING that
  // insert and therefore cannot exist a moment earlier.
  const [existing, stackedDeal] = await Promise.all([
    fetchRow(client, userId, playDate),
    fetchStackedDeal(client, userId, playDate),
  ]);
  if (existing) return { seed: Number(existing.seed), result: existing.result, stackedDeal };

  // THIS VALUE IS DISCARDED SERVER-SIDE and is kept only so the claim works
  // against a database that has not run migration 024 yet (the column is NOT
  // NULL, so dropping it here would make every claim fail on an un-migrated
  // project — the deploy-order trap §11al already paid for once).
  //
  // Post-024, `enforce_server_dealt_hand` overwrites it with a CSPRNG value
  // before the row lands, because a seed the browser chooses is a hand the
  // browser chooses: `dealHand` is pure, so grinding for a Royal Flush and
  // claiming that seed is a few seconds of work. Exploited in production
  // (§11am). Do not add a code path that depends on this number surviving.
  const seed = freshSeed();
  const { data: inserted, error: insertError } = await client
    .from('daily_plays')
    .insert({ user_id: userId, play_date: playDate, seed })
    .select('seed, result')
    .single();
  if (!insertError) {
    return { seed: Number(inserted.seed), result: inserted.result, stackedDeal: await fetchStackedDeal(client, userId, playDate) };
  }

  // Lost a race to claim today's row (e.g. two tabs opened at once) — the
  // other insert won, so read back whatever it actually claimed rather than
  // erroring out.
  if (insertError.code === '23505') {
    const raced = await fetchRow(client, userId, playDate);
    if (raced) {
      return { seed: Number(raced.seed), result: raced.result, stackedDeal: await fetchStackedDeal(client, userId, playDate) };
    }
  }
  throw insertError;
}

// The cards an admin pinned for this player's hand today, or null (§11al).
//
// RESOLVES NULL ON ANY FAILURE, deliberately, and this is the one place in
// this file that swallows an error. The table may not exist yet — migration
// 021 is applied by hand — and a missing table must degrade to an ordinary
// deal rather than making the board unplayable for everybody. The cost of
// being wrong is bounded and self-correcting: the player gets a normal hand,
// which the server will also score as a normal hand, because the row the
// trigger never attached is the same row submit-run will not find.
async function fetchStackedDeal(client, userId, playDate) {
  const { data, error } = await client
    .from('stacked_deals')
    .select('cards')
    .eq('user_id', userId)
    .eq('play_date', playDate)
    .maybeSingle();
  if (error) {
    console.warn('Could not read a stacked deal; dealing normally.', error?.message ?? error);
    return null;
  }
  return data?.cards ?? null;
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

/**
 * What the DEPLOYED submit-run says it can do (§11al).
 *
 * Exists because stacked deals need two deployables to move together — the
 * Edge Function and the migration/bundle that queues them — and a forgotten
 * `supabase functions deploy` is invisible: the old function accepts the run
 * and scores it from the ordinary deal, so the player sees a hand nobody
 * chose and the admin sees a success notice.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the point (§11i's rule, and
 * §11ak's): 'ready' means it advertised the capability, 'stale' means it
 * answered and did not, 'unknown' means we could not ask. Collapsing unknown
 * into either of the others is how a warning ends up on the wrong screen.
 *
 * @returns {Promise<{status: 'ready'|'stale'|'unknown', features: string[]}>}
 */
export async function fetchSubmitRunFeatures(feature = 'stacked-deals') {
  const client = await requireSupabase();
  try {
    // GET, so it needs no body and no session — the function answers this one
    // before it looks at Authorization at all.
    const { data, error } = await client.functions.invoke('submit-run', { method: 'GET' });
    if (error) throw error;
    const features = Array.isArray(data?.features) ? data.features : [];
    // An OLD function has no GET branch and answers 405 with `{error}`, which
    // lands in the catch. A 200 with no `features` key is still an answer, and
    // it means the capability is absent.
    return { status: features.includes(feature) ? 'ready' : 'stale', features };
  } catch (error) {
    // 405 is a definitive answer from a function that predates this check —
    // it is deployed, and it is old. Anything else (offline, 404, CORS) is
    // genuinely unknown.
    const status = error?.context?.status ?? error?.status;
    if (status === 405) return { status: 'stale', features: [] };
    console.warn('Could not read submit-run capabilities:', error?.message ?? error);
    return { status: 'unknown', features: [] };
  }
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
