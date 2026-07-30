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

// Fills in the result on a row already claimed via claimTodaySeed — the
// schema's column-level grant only allows this one column to change here,
// so there's no path (short of the DB itself) to rewrite `seed`.
export async function saveTodayResultForUser(userId, result, date = new Date()) {
  const client = await requireSupabase();
  const { error } = await client.from('daily_plays').update({ result }).eq('user_id', userId).eq('play_date', isoDate(date));
  if (error) throw error;
}
