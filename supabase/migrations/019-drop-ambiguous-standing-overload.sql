-- Migration: drop the one-argument daily_standing, which migration 018 left in
-- place and thereby broke (DESIGN.md §11ag).
--
-- ── WHAT 018 GOT WRONG ──────────────────────────────────────────────────────
-- 018 added `daily_standing(day date, for_score numeric)` and deliberately kept
-- `daily_standing(day date)` installed, reasoning that "Postgres resolves the
-- two by arity with no ambiguity" so a browser running the previous bundle would
-- keep working through the deploy.
--
-- Postgres does. PostgREST does not. It matches an RPC by the JSON KEYS in the
-- request body, so `{"day": null}` is a valid call to BOTH signatures — the
-- second has a default for `for_score` — and it refuses to guess:
--
--   PGRST203  Could not choose the best candidate function between:
--             public.daily_standing(day => date),
--             public.daily_standing(day => date, for_score => numeric)
--
-- So the compatibility shim did the exact opposite of its purpose: instead of
-- keeping the old bundle working, it broke the one call the old bundle makes.
-- The chip fails closed (state/standing.js resolves null on any error, §11aa),
-- so nothing crashed — it simply stopped appearing, which is the kind of
-- breakage nobody reports.
--
-- Found by probing the deployed endpoint rather than trusting 018's own
-- self-test, which passed: the self-test calls the function from inside SQL,
-- where Postgres's arity resolution is the one that applies. §11y's rule
-- exactly — probe the deployed function, not just the migration's self-test.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Drop the one-argument form. With a single candidate remaining, PostgREST
-- resolves both call shapes against it:
--
--   {"day": null}                   -> for_score defaults to null -> ranks the
--                                      caller's saved row, i.e. 016's behaviour
--   {"day": null, "for_score": 123} -> ranks the given score (018's addition)
--
-- Which means the old bundle works again AND the new one works, from one
-- function. The overload was never buying anything.
--
-- Run this in your project's SQL Editor. Safe to run more than once.

drop function if exists public.daily_standing(date);

-- ---------------------------------------------------------------------------
-- Self-test — including the thing 018's self-test could not see
-- ---------------------------------------------------------------------------
do $$
declare
  overloads int;
begin
  select count(*) into overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'daily_standing';

  if overloads <> 1 then
    raise exception
      'daily_standing has % signatures; PostgREST cannot resolve an RPC while more than one exists', overloads;
  end if;

  -- Both call shapes must still work from SQL.
  perform public.daily_standing(null);
  perform public.daily_standing(null, 1e30::numeric);

  raise notice 'Migration 019 self-test passed. One daily_standing signature; both call shapes resolve.';
end $$;

-- NOTE FOR ANY FUTURE CHANGE TO THIS FUNCTION: do not add an overload. Add a
-- parameter with a default instead. Every RPC in this project is reached
-- through PostgREST, where two signatures of one name is not a compatibility
-- measure — it is an outage for both of them.
