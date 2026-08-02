-- Migration: take score writing away from the client entirely.
--
-- ###########################################################################
-- ## DO NOT RUN THIS UNTIL `submit-run` IS DEPLOYED AND CONFIRMED WORKING.  ##
-- ##                                                                        ##
-- ## It revokes the client's ability to write `daily_plays.result`. If the  ##
-- ## Edge Function is not live when you run it, every player finishes their ##
-- ## hand and the save fails — the run is scored on screen and then lost.   ##
-- ##                                                                        ##
-- ## Order:                                                                 ##
-- ##   1. supabase functions deploy submit-run                              ##
-- ##   2. play one real run and confirm the row is written with             ##
-- ##      result->>'verified' = 'true' (query at the bottom of this file)   ##
-- ##   3. only then run section 2 below                                     ##
-- ##                                                                        ##
-- ## src/state/daily-play.js falls back to the direct write while the       ##
-- ## function is missing, which is what makes that ordering safe rather     ##
-- ## than a cutover. This migration is what removes the fallback.           ##
-- ###########################################################################
--
-- WHY. `result` is jsonb and the client wrote it wholesale. RLS restricted which
-- ROW a player could touch; nothing restricted what they could put in it, and
-- `leaderboard_top_scores` / `leaderboard_career_points` read the total straight
-- out of that blob:
--
--   (result->'score'->>'total')::numeric
--
-- So any signed-in player could PATCH their own row with an arbitrary number and
-- own every board. The UI never offered it; the REST endpoint did not care.
--
-- The seed was always the answer: it is claimed before a card is dealt and is
-- already write-once (schema.sql grants UPDATE on `result` only), and
-- `dealHand(seed)` is a pure function. So the server has always been able to
-- reproduce the hand — it just had nowhere to run the check. That is what the
-- Edge Function is for, and because src/core/ is forbidden from touching the
-- network or the DOM, it imports the REAL scorer rather than a second copy that
-- would drift.

-- ---------------------------------------------------------------------------
-- 1. Check the function is actually writing before you cut the old path
-- ---------------------------------------------------------------------------
-- Rows written by submit-run carry `"verified": true`. Run this AFTER playing a
-- run through the deployed function; if it returns nothing, stop here.
select play_date,
       user_id,
       (result->>'verified')::boolean as server_scored,
       result->'score'->>'total'      as total
  from public.daily_plays
 where result is not null
 order by play_date desc
 limit 10;

-- ---------------------------------------------------------------------------
-- 2. Remove the client's write access  (RUN ONLY AFTER STEP 1 LOOKS RIGHT)
-- ---------------------------------------------------------------------------
-- The service role used by the Edge Function bypasses both RLS and column
-- grants, so it is unaffected. After this, `result` has exactly one writer.
--
-- Commented out deliberately. Uncomment both lines and run them as a second
-- step, so pasting this whole file cannot cut the path by accident.
--
--   revoke update (result) on public.daily_plays from authenticated;
--   revoke update on public.daily_plays from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Afterwards: confirm the client really cannot write
-- ---------------------------------------------------------------------------
-- Should list NO update privileges for `authenticated` on daily_plays.
select column_name, privilege_type, grantee
  from information_schema.column_privileges
 where table_name = 'daily_plays'
   and grantee = 'authenticated'
   and privilege_type = 'UPDATE';

-- ---------------------------------------------------------------------------
-- 4. Rolling back
-- ---------------------------------------------------------------------------
-- If the function turns out to be broken in production, restore the old path
-- with the statement below and the client's fallback resumes working
-- immediately. Nothing else needs reverting.
--
--   grant update (result) on public.daily_plays to authenticated;
--
-- ---------------------------------------------------------------------------
-- 5. What is still client-supplied, and why that is acceptable
-- ---------------------------------------------------------------------------
-- The SCORE — the only thing the leaderboards rank on — is computed entirely
-- server-side from the seed. These remain client-supplied and are bounded rather
-- than verified, because verifying them costs far more than they are worth:
--
--   evContext        -> feeds optimalDiscardBonus only, which caps at 200 points
--                       against a table where a Royal Flush is 54,800,000.
--                       Verifying it means re-running the exhaustive EV solve
--                       (millions of hand evaluations) on every submission.
--                       A degenerate context is DISCARDED rather than honoured,
--                       since that case short-circuits to the full bonus.
--   decisionRating   -> clamped to 0-1. Feeds XP and one achievement.
--   meters           -> clamped to 0-100. Display only.
--   personalityId    -> must be a known id. Display only.
--   newlyUnlocked    -> filtered to known achievement ids and capped in count.
--
-- Worst case a determined client can still add ~200 points to its own total and
-- claim achievements it did not earn. That is a different order of problem from
-- writing 999,999,999 to the leaderboard, and closing it properly means moving
-- the EV solve server-side — worth revisiting only if it is ever actually abused.
