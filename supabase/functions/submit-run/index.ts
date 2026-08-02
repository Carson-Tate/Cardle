// submit-run — the authoritative writer for `daily_plays.result` (DESIGN.md §11z).
//
// THE PROBLEM THIS SOLVES. `result` is jsonb and the client used to write it
// wholesale: RLS restricted WHICH row (your own) but nothing restricted WHAT you
// put in it, and the leaderboard reads the score straight out of that blob. Any
// signed-in player could PATCH their own row with an arbitrary total and top
// every board. The UI never offered it; the REST endpoint did not care.
//
// THE FIX. The client no longer sends a score at all — it sends the only thing
// it is actually entitled to decide, which cards it threw away. This function
// re-deals from the seed the server has held since before the hand was dealt,
// replays those discards, and computes the score itself.
//
// WHY THIS IS A THIN FILE. All the real logic is `verifyAndScoreRun` in
// src/core/verify-run.js, imported here UNMODIFIED. src/core/ has never been
// allowed to touch the network or the DOM, so it runs as-is under Deno — which
// means there is exactly one scorer, not a server copy that drifts from the
// browser's. Everything below is HTTP plumbing around that one call.
//
// DEPLOY: supabase functions deploy submit-run
// The relative imports below reach outside supabase/functions/ into src/core/.
// That is deliberate (one scorer, no duplication); if your CLI version refuses
// to bundle across that boundary, the fix is a symlink or a copy step in CI —
// NOT a second implementation.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0?target=es2020';
import { verifyAndScoreRun } from '../../../src/core/verify-run.js';
import { gameDayFor, instantWithinGameDay } from '../../../src/core/game-day.js';
import { getDailyModifier } from '../../../src/core/modifiers.js';
import { modifierOverrideFor, CONFIG_KEYS, validateModifierOverrides } from '../../../src/core/game-config.js';
import { PERSONALITIES } from '../../../src/core/personality.js';
import { ACHIEVEMENTS } from '../../../src/core/achievements.js';

// REFLECTS the requested headers rather than naming a fixed list.
//
// The first version allowed only `authorization, content-type`. supabase-js also
// sends `apikey` and `x-client-info` on every call, so the browser refused the
// preflight's terms and BLOCKED THE POST BEFORE SENDING IT. The function's logs
// showed the signature exactly: four OPTIONS at 200 and not a single POST behind
// them. The client saw a network-shaped failure, could not tell it apart from
// "not deployed", and silently fell back to the old write path — so the whole
// thing looked deployed and did nothing.
//
// Reflecting is safe here because the origin is `*` and no credentials are
// accepted: the JWT arrives as an explicit Authorization header, not a cookie.
// It also cannot break again when the SDK adds another header.
function corsFor(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      req.headers.get('Access-Control-Request-Headers') ??
      'authorization, apikey, x-client-info, content-type, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // Preflights are cached for a day, so this is one extra round trip per
    // browser per day rather than one per submission.
    'Access-Control-Max-Age': '86400',
  };
}

const jsonFor = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json' },
  });

// Fields the server does NOT compute, accepted from the client but bounded so a
// forged one cannot be worth anything. Each is display-only or feeds a capped
// term; the SCORE — the only thing the leaderboard ranks on — is never taken
// from the client at all.
const KNOWN_PERSONALITIES = new Set(PERSONALITIES.map((p: { id: string }) => p.id));
const KNOWN_ACHIEVEMENTS = new Set(ACHIEVEMENTS.map((a: { id: string }) => a.id));

function sanitizeAdvisory(body: Record<string, unknown>) {
  // decisionRating feeds XP (already clamped to 0-1 by progression.js) and the
  // `flawless` achievement. Clamped here too so the stored row is sane.
  const rawRating = Number(body.decisionRating);
  const decisionRating = Number.isFinite(rawRating) ? Math.min(1, Math.max(0, rawRating)) : null;

  const rawMeters = (body.meters ?? {}) as Record<string, unknown>;
  const meters = ['luck', 'skill', 'risk'].reduce((acc: Record<string, number>, key) => {
    const value = Number(rawMeters[key]);
    acc[key] = Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
    return acc;
  }, {});

  const personalityId = KNOWN_PERSONALITIES.has(body.personalityId as string)
    ? (body.personalityId as string)
    : null;

  // Capped in count as well as membership: each unlock is worth XP, so an
  // unbounded list would be a slow-motion version of the score forgery.
  const newlyUnlocked = Array.isArray(body.newlyUnlocked)
    ? (body.newlyUnlocked as unknown[]).filter((id) => KNOWN_ACHIEVEMENTS.has(id as string)).slice(0, ACHIEVEMENTS.length)
    : [];

  return { decisionRating, meters, personalityId, newlyUnlocked };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsFor(req) });
  if (req.method !== 'POST') return jsonFor(req, { error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return jsonFor(req, { error: 'sign-in required' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  // The caller's own JWT, used ONLY to establish who they are. It carries no
  // privilege here — every read and write below goes through the service client.
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData?.user) return jsonFor(req, { error: 'sign-in required' }, 401);
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonFor(req, { error: 'body must be JSON' }, 400);
  }

  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // THE DAY IS DECIDED HERE, not by the client. Taking it from the request would
  // let a player re-submit against an old row, or claim tomorrow's.
  const today = gameDayFor(new Date());

  const { data: row, error: rowError } = await service
    .from('daily_plays')
    .select('seed, result')
    .eq('user_id', userId)
    .eq('play_date', today)
    .maybeSingle();

  if (rowError) return jsonFor(req, { error: rowError.message }, 500);
  // No row means no hand was ever claimed — you cannot submit a run you were
  // never dealt.
  if (!row) return jsonFor(req, { error: 'no hand claimed for today' }, 409);
  // ONE SUBMISSION PER DAY. Without this a player could keep re-submitting
  // different discard sets against the same seed until one scored well, which
  // would defeat the whole point of claiming the seed up front.
  if (row.result !== null) return jsonFor(req, { error: 'today is already finished' }, 409);

  // The modifier is resolved server-side too: it carries the scoring multiplier
  // AND the discard caps, so a client-supplied one would just be another way to
  // ask for a bigger score.
  const { data: configRows } = await service.from('game_config').select('key, value');
  const overrides = validateModifierOverrides(
    (configRows ?? []).find((r: { key: string }) => r.key === CONFIG_KEYS.MODIFIER_OVERRIDES)?.value,
  ).value;
  const modifier = getDailyModifier(instantWithinGameDay(today), modifierOverrideFor(overrides, today));

  const verified = verifyAndScoreRun({
    seed: Number(row.seed),
    discardRounds: body.discardRounds ?? [[]],
    modifier,
    wagered: body.wagered === true,
    evContext: body.evContext,
  });
  if (!verified.ok) return jsonFor(req, { error: 'run rejected', details: verified.errors }, 422);

  const advisory = sanitizeAdvisory(body);
  const result = {
    dayNumber: Number(body.dayNumber) || null,
    originalHand: verified.originalHand,
    discardIndices: verified.discardIndices,
    finalHand: verified.finalHand,
    score: verified.score,
    maxDiscards: verified.maxDiscards,
    ...advisory,
    // Stamped so a later audit can tell a server-scored row from a legacy
    // client-written one without guessing.
    verified: true,
  };

  const { error: writeError } = await service
    .from('daily_plays')
    .update({ result })
    .eq('user_id', userId)
    .eq('play_date', today);

  if (writeError) return jsonFor(req, { error: writeError.message }, 500);
  // Returned so the client can reconcile — if its own optimistic score differs,
  // the server's is the one that counts.
  return jsonFor(req, { result });
});
