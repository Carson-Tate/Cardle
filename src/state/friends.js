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
  const { data: target, error: lookupError } = await client.from('profiles').select('id').eq('username', username).maybeSingle();
  if (lookupError) throw lookupError;
  if (!target) throw new Error(`No user found with the username "${username}".`);
  if (target.id === userId) throw new Error("You can't send a friend request to yourself.");

  const { error } = await client.from('friendships').insert({ requester_id: userId, addressee_id: target.id });
  if (error) {
    if (error.code === '23505') throw new Error(`You're already friends with "${username}", or a request is already pending.`);
    throw error;
  }
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
  return data.map((f) => ({
    ...f,
    friendUsername: profiles.get(otherUserId(f, userId))?.username ?? null,
    friendProfile: profiles.get(otherUserId(f, userId)) ?? null,
  }));
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
