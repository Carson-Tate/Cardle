-- Migration: close two authorization holes found in a security audit.
--
-- Run this in your project's SQL Editor. Safe to run more than once.
--
-- ===========================================================================
-- 1. FRIENDSHIPS: anyone could force a friendship, or forge one from a third
--    party
-- ===========================================================================
-- The policy was:
--
--   create policy "Users can update friendships they're part of"
--     on public.friendships for update
--     using (auth.uid() = requester_id or auth.uid() = addressee_id);
--
-- and there was NO column grant, so `authenticated` could update every column.
-- Two consequences, both reachable from devtools with the public anon key —
-- the UI never offers them, but the REST endpoint does not care what the UI
-- offers.
--
-- (a) SELF-ACCEPT. A sends B a request, then updates that row's status to
--     'accepted' themselves. The policy passes because A is the requester. A is
--     now in B's friends list and B never agreed. src/state/friends.js's comment
--     claimed this "would be a no-op bug, not a real action" — it is not a
--     no-op; it writes a genuine accepted friendship.
--
-- (b) FORGERY, which is worse. When WITH CHECK is omitted, Postgres reuses the
--     USING expression, so the NEW row only has to keep the caller as one of the
--     two parties. Given any row where A is the addressee, A can rewrite
--     requester_id to ANY user id C and then accept it. C appears to have sent
--     A a friend request and to now be their friend, without C ever touching
--     the site.
--
-- The fix is the pair this project has now needed three times: a row policy is
-- never sufficient on its own, a table with columns that must not move also
-- needs a COLUMN GRANT (bit before on daily_plays.seed and profiles.is_admin).
--
-- Only `status` is writable, and only the addressee, and only pending ->
-- accepted. Every other friendship action (decline, cancel, unfriend) is a
-- DELETE, which keeps its existing either-side policy — either party may
-- legitimately end a friendship.
revoke update on public.friendships from authenticated;
grant update (status) on public.friendships to authenticated;

drop policy if exists "Users can update friendships they're part of" on public.friendships;
drop policy if exists "Addressees can accept a pending request" on public.friendships;
create policy "Addressees can accept a pending request"
  on public.friendships for update
  -- WHICH ROWS may be updated: only ones addressed to me, still pending.
  using (auth.uid() = addressee_id and status = 'pending')
  -- WHAT they may become: still mine, and specifically accepted. Stated
  -- explicitly rather than left to default to the USING expression — that
  -- defaulting is exactly what made (b) possible.
  with check (auth.uid() = addressee_id and status = 'accepted');

-- ===========================================================================
-- 2. PROFILES: uppercase usernames were a client-side convention only
-- ===========================================================================
-- Usernames are stored UPPERCASE (migration 009) and every exact-match lookup
-- normalizes before comparing. But the CHECK constraint still accepted
-- `^[A-Za-z0-9_]{3,20}$`, so the rule lived only in browser JavaScript — and the
-- unique index is case-SENSITIVE. A direct REST call could therefore insert
-- `carson` alongside an existing `CARSON`: two distinct rows, indistinguishable
-- to a player, which is precisely the duplicate-name class of bug migration 010
-- exists to prevent. It would also be invisible to every `.eq('username', ...)`
-- lookup, since those normalize to uppercase and would only ever find one of
-- them.
--
-- Same shape of fix as migration 001, which tightened this constraint from
-- length-only to a character pattern for the same reason: a rule the client
-- enforces alone is not a rule.
--
-- Verified before writing this: all 18 existing usernames are already
-- uppercase, so this cannot fail on current data. The query below re-checks —
-- if it returns rows, fix them with admin_rename_player() before continuing.
select id, username
  from public.profiles
 where username <> upper(username);

do $$
begin
  -- Drop whichever pattern constraint is currently attached, by definition
  -- rather than by name, since 001 and the original schema.sql may have named
  -- it differently.
  if exists (
    select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'profiles'
       and con.contype = 'c'
       and con.conname = 'profiles_username_pattern'
  ) then
    alter table public.profiles drop constraint profiles_username_pattern;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_username_uppercase'
  ) then
    alter table public.profiles
      add constraint profiles_username_uppercase
      check (username ~ '^[A-Z0-9_]{3,20}$');
  end if;
end $$;

-- ===========================================================================
-- 3. Self-test — RUN THIS AND READ IT
-- ===========================================================================
-- Checks the grants and the policy actually landed. Every row must say `ok`.
with checks (what, actual, expected) as (
  select
    'friendships: only `status` is updatable by authenticated',
    coalesce((
      select string_agg(a.attname, ',' order by a.attname)
        from information_schema.column_privileges p
        join pg_class c on c.relname = p.table_name and c.relnamespace = 'public'::regnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = p.column_name
       where p.table_name = 'friendships'
         and p.privilege_type = 'UPDATE'
         and p.grantee = 'authenticated'
    ), '(none)'),
    'status'
  union all
  select
    'friendships: the old either-side UPDATE policy is gone',
    case when exists (
      select 1 from pg_policies
       where tablename = 'friendships'
         and policyname = 'Users can update friendships they''re part of'
    ) then 'still present' else 'gone' end,
    'gone'
  union all
  select
    'friendships: the new policy has an explicit WITH CHECK',
    case when exists (
      select 1 from pg_policies
       where tablename = 'friendships'
         and policyname = 'Addressees can accept a pending request'
         and with_check is not null
    ) then 'yes' else 'no' end,
    'yes'
  union all
  select
    'profiles: username constraint rejects lowercase',
    case when exists (
      select 1 from pg_constraint
       where conname = 'profiles_username_uppercase'
    ) then 'yes' else 'no' end,
    'yes'
)
select what, actual, expected,
       case when actual = expected then 'ok' else 'FAIL' end as result
  from checks
 order by result desc, what;
