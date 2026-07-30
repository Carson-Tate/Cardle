// Friends (DESIGN.md §11) — request/accept/list/remove, backed by the
// `friendships` table (supabase/schema.sql). Deliberately does NOT use
// Supabase's embedded-join syntax for pulling in the other person's
// username (e.g. `select('*, profiles!friendships_requester_id_fkey(...)')`)
// — that requires knowing Postgres's auto-generated foreign-key constraint
// name, which is an implementation detail this module shouldn't have to
// depend on. Simpler and more robust instead: fetch the friendship rows,
// then batch-fetch the relevant profiles by id and merge client-side.

import { requireSupabase } from './supabase-client.js';
import { NAMEPLATE_COLUMNS } from './profile.js';
import { normalizeUsername } from './auth.js';

// Looks up a friendships row's "OTHER side" — whichever of
// requester_id/addressee_id isn't `userId`. Used to figure out whose profile
// to attach to each row.
function otherUserId(friendship, userId) {
  return friendship.requester_id === userId ? friendship.addressee_id : friendship.requester_id;
}

async function profilesById(client, ids) {
  if (ids.length === 0) return new Map();
  // Cosmetic columns come along so a friend's nameplate renders with their
  // badge/title/paint (ui/nameplate.js) rather than a bare username. Uses the
  // shared column list, because this select was previously missing
  // `admin_unlocks` and silently hid admin-granted cosmetics here only.
  const { data, error } = await client
    .from('profiles')
    .select(NAMEPLATE_COLUMNS)
    .in('id', ids);
  if (error) throw error;
  return new Map(data.map((p) => [p.id, p]));
}

// Sends a friend request by username (not id — the sender doesn't know the
// other person's id, only their public username). Throws a friendly error
// for the three ways this can fail: no such username, requesting yourself,
// or a friendship (pending or accepted) already existing between the two —
// the `friendships` table's own unique/check constraints are the actual
// source of truth for all three; this just translates the resulting
// Postgres errors into messages a request-by-username UI can show directly.
export async function sendFriendRequest(userId, username) {
  const client = await requireSupabase();
  // Normalized for the LOOKUP (stored names are uppercase, §11n) so a request
  // typed in lower case still finds the player, while the error messages below
  // quote the name as the sender actually typed it.
  const { data: target, error: lookupError } = await client
    .from('profiles')
    .select('id')
    .eq('username', normalizeUsername(username))
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!target) throw new Error(`No user found with the username "${username}".`);
  if (target.id === userId) throw new Error("You can't send a friend request to yourself.");

  // Checked in BOTH directions before inserting. The table's own
  // `unique (requester_id, addressee_id)` is directional, so it stops A asking B
  // twice but not A→B and B→A coexisting — which is how one friendship ended up
  // rendering as two people (owner bug report: "multiple of the same name").
  // Migration 010 adds a non-directional unique index so this cannot happen at
  // all; this check is what turns that constraint into a sentence a player can
  // act on rather than a raw 23505.
  const existing = await getFriendshipWith(userId, target.id);
  if (existing) {
    if (existing.status === 'accepted') throw new Error(`You're already friends with "${username}".`);
    throw new Error(
      existing.requester_id === userId
        ? `You've already sent "${username}" a request.`
        : `"${username}" already sent YOU a request — accept it from your friends list.`,
    );
  }

  const { error } = await client.from('friendships').insert({ requester_id: userId, addressee_id: target.id });
  if (error) {
    // Still handled, because the check above is a read followed by a write and
    // two people adding each other at the same moment can interleave between
    // them. The database is the arbiter; this just says so politely.
    if (error.code === '23505') throw new Error(`You're already friends with "${username}", or a request is already pending.`);
    throw error;
  }
}

/**
 * The friendship row between two players, from either direction, or null.
 *
 * Powers the profile page's Add Friend button and the search results' per-row
 * action — both need to know not just IF a friendship exists but which way it
 * points, since "you asked them" and "they asked you" offer different actions.
 *
 * @returns {Promise<{id: string, status: string, requester_id: string, addressee_id: string}|null>}
 */
export async function getFriendshipWith(userId, otherUserId) {
  if (!userId || !otherUserId || userId === otherUserId) return null;
  const client = await requireSupabase();
  const { data, error } = await client
    .from('friendships')
    .select('*')
    .or(
      `and(requester_id.eq.${userId},addressee_id.eq.${otherUserId}),` +
        `and(requester_id.eq.${otherUserId},addressee_id.eq.${userId})`,
    )
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Players whose username STARTS WITH `query`, for the add-friend picker
 * (owner request: "it should first search then pop up names that are valid and
 * then you click to add them").
 *
 * Prefix rather than substring: it is what a name picker is expected to do, and
 * it is the only form a b-tree index can serve — `like '%X%'` would table-scan
 * every profile on every keystroke. Migration 010 adds the matching
 * `text_pattern_ops` index.
 *
 * Case is not a concern: stored names are uppercase (§11n) and the query is
 * normalized to match, so a plain case-sensitive `like` is correct AND indexable
 * (`ilike` would not use the index).
 *
 * Grants no new visibility — `profiles` has always been readable to signed-in
 * players; that is how friend lookup and profile links already work.
 *
 * @param {string} query
 * @param {{excludeUserId?: string|null, limit?: number}} [options]
 * @returns {Promise<Array<object>>} nameplate-shaped profile rows
 */
export async function searchProfiles(query, { excludeUserId = null, limit = 8 } = {}) {
  const prefix = normalizeUsername(query);
  // Below two characters every name in the game matches, which is a long list
  // that tells the player nothing. Callers treat [] as "keep typing".
  if (prefix.length < 2) return [];
  const client = await requireSupabase();
  // Escaped, because `%` and `_` are wildcards inside LIKE: a player typing "_"
  // would otherwise match any single character rather than searching for an
  // underscore, which is a legal username character here.
  const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  // Every FILTER first, then order/limit. PostgREST accepts them in any order,
  // but "narrow the rows, then shape the result" is what the chain actually
  // means — appending a filter after `.limit()` reads as limiting before
  // excluding, which is not what happens and is a trap for the next reader.
  let request = client.from('profiles').select(NAMEPLATE_COLUMNS).like('username', `${escaped}%`);
  if (excludeUserId) request = request.neq('id', excludeUserId);
  const { data, error } = await request.order('username').limit(limit);
  if (error) throw error;
  return data ?? [];
}

// Incoming requests — friendships where `userId` is the addressee and
// status is still 'pending' — each with the REQUESTER's username attached,
// since that's whose name the "accept/decline" UI needs to show.
export async function getPendingRequests(userId) {
  const client = await requireSupabase();
  const { data, error } = await client.from('friendships').select('*').eq('addressee_id', userId).eq('status', 'pending');
  if (error) throw error;

  const profiles = await profilesById(client, data.map((f) => f.requester_id));
  return data.map((f) => ({
    ...f,
    requesterUsername: profiles.get(f.requester_id)?.username ?? null,
    requesterProfile: profiles.get(f.requester_id) ?? null,
  }));
}

// Requests YOU have sent that are still pending, each with the ADDRESSEE's
// username attached. Without this, sending a request produced no visible
// result anywhere — the request existed in the database but the sender's own
// panel had no section for it, so it looked like nothing had happened (owner
// request: "add a 'sent invite' to add friends").
export async function getSentRequests(userId) {
  const client = await requireSupabase();
  const { data, error } = await client.from('friendships').select('*').eq('requester_id', userId).eq('status', 'pending');
  if (error) throw error;

  const profiles = await profilesById(
    client,
    data.map((f) => f.addressee_id),
  );
  return data.map((f) => ({
    ...f,
    addresseeUsername: profiles.get(f.addressee_id)?.username ?? null,
    addresseeProfile: profiles.get(f.addressee_id) ?? null,
  }));
}

// Accepted friendships involving `userId`, from either side, each with the
// OTHER person's username attached (via otherUserId — the friend, not you).
export async function getFriends(userId) {
  const client = await requireSupabase();
  const { data, error } = await client
    .from('friendships')
    .select('*')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
  if (error) throw error;

  const profiles = await profilesById(
    client,
    data.map((f) => otherUserId(f, userId)),
  );
  // ONE ROW PER PERSON, keyed on who the friend actually is rather than on the
  // friendship id. Migration 010 removes the reciprocal duplicates and stops new
  // ones, but this list must also be correct for anyone whose browser is talking
  // to a database that has not run it yet — and "the same friend twice" is a
  // visibly broken list, not a cosmetic wrinkle. Cheap, and it means the render
  // path no longer depends on a schema constraint holding.
  const seen = new Set();
  return data
    .map((f) => ({
      ...f,
      friendUsername: profiles.get(otherUserId(f, userId))?.username ?? null,
      friendProfile: profiles.get(otherUserId(f, userId)) ?? null,
    }))
    .filter((f) => {
      const other = otherUserId(f, userId);
      if (seen.has(other)) return false;
      seen.add(other);
      return true;
    });
}

// Only the addressee can accept (schema.sql's RLS policy allows either side
// to UPDATE the row, but accepting only makes sense from the receiving
// side — the requester accepting their own outgoing request would be a
// no-op bug, not a real action, so it's not exposed as a button anywhere).
export async function acceptFriendRequest(friendshipId) {
  const client = await requireSupabase();
  const { error } = await client.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
  if (error) throw error;
}

// One function for every "make this friendship row go away" action —
// declining a request you received, cancelling one you sent, or removing an
// existing accepted friend are all the same operation from the data's
// perspective. RLS (schema.sql) already restricts this to rows either side
// of the friendship is actually part of.
export async function removeFriendship(friendshipId) {
  const client = await requireSupabase();
  const { error } = await client.from('friendships').delete().eq('id', friendshipId);
  if (error) throw error;
}
