-- VTrack — 0002_policies.sql
-- RLS, the limited-column public views, and the realtime publication (CLAUDE.md §4).
-- Safe to re-run: every policy is dropped before it is created.
--
-- The access model in one paragraph:
--   anon  (the key that ships in the browser on GitHub Pages) has NO privilege on any
--         table or view. Nothing is readable or writable with the public key alone.
--         (Until 26 Oct 2026 this file granted anon `select` on events, `insert` on
--         guard_actions and the two views; 0004 took that back, and a re-run of this file
--         used to give it out again. It no longer does: this file never grants anon.)
--   authenticated  holds table privileges on vehicles so that RLS can narrow them —
--         in Postgres, RLS restricts a privilege you already hold, it never grants one.
--         The admin policies are what actually restrict the grant.
--   service_role   (engine only, M1+) bypasses RLS entirely.
--
-- The LIVE policy set is 0004 + 0005 + 0006, which replace the policies below. This file
-- is the base they build on; once they are applied it refuses to run (section 0).

-- ---------------------------------------------------------------------------
-- 0. Never on top of 0004+: this file's policies and views are the ones 0004 and 0006
--    replace, so running it again on a database that has them would put the old shape
--    back (events readable by any login, the display's view off its function). It stops
--    here instead. On a fresh project (no 0004 yet) it runs as before.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'events' and policyname = 'events_select') then
    raise exception '0002 has been superseded on this database by 0004 (and later): nothing was changed. '
                    'Re-run 0004, 0005 and 0006 instead; they are the live policy set.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Row level security on every table
-- ---------------------------------------------------------------------------
alter table public.vehicles      enable row level security;
alter table public.devices       enable row level security;
alter table public.events        enable row level security;
alter table public.guard_actions enable row level security;

-- NOTE: no `force row level security` on vehicles: 0006's security definer function reads
-- the base table as its owner for the display, and an owner is exempt from RLS only while
-- FORCE is off.

-- ---------------------------------------------------------------------------
-- 2. Table privileges
-- ---------------------------------------------------------------------------
-- anon: nothing on the base tables.
revoke all on public.vehicles from anon;
revoke all on public.devices  from anon;

-- anon: nothing on events or guard_actions either.
revoke all on public.events        from anon;
revoke all on public.guard_actions from anon;

-- authenticated: needs the privilege for RLS to have something to narrow.
grant select, insert, update, delete on public.vehicles to authenticated;
grant select on public.devices       to authenticated;
grant select on public.events        to authenticated;
grant select, insert on public.guard_actions to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The two limited-column views (read by signed-in browsers only)
-- ---------------------------------------------------------------------------
-- vehicles_public: exactly the columns named in CLAUDE.md §4.
create or replace view public.vehicles_public as
  select plate_norm,
         plate_display,
         owner_name,
         org_unit,
         pass_type,
         status,
         valid_from,
         valid_until
  from public.vehicles;

-- devices_public: NOT in the §4 column list, added because §6.1 requires the display to
-- read devices.cam-a.last_seen_at for the OFFLINE banner and token_hash must never reach
-- a browser. Drop this block if you would rather the display not see devices at all.
create or replace view public.devices_public as
  select id, role, name, site, lane, last_seen_at, version
  from public.devices;

-- The views run as the caller: the caller's own policies decide what comes back, and the
-- Supabase advisor is quiet about security definer views. (0006 re-points vehicles_public at
-- a role-checking function so the display never needs a policy on the base table.)
alter view public.vehicles_public set (security_invoker = on);
alter view public.devices_public  set (security_invoker = on);

alter view public.vehicles_public owner to postgres;
alter view public.devices_public  owner to postgres;

revoke all on public.vehicles_public from anon;
revoke all on public.devices_public  from anon;
grant select on public.vehicles_public to authenticated;
grant select on public.devices_public  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------
-- vehicles — admin only. `app_metadata.role` is set by supabase/admin_role.sql and is
-- baked into the JWT at issue time, so a session started before that runs keeps the old
-- token until it refreshes. Sign out and back in.
drop policy if exists vehicles_admin_select on public.vehicles;
drop policy if exists vehicles_admin_insert on public.vehicles;
drop policy if exists vehicles_admin_update on public.vehicles;
drop policy if exists vehicles_admin_delete on public.vehicles;

create policy vehicles_admin_select on public.vehicles
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy vehicles_admin_insert on public.vehicles
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy vehicles_admin_update on public.vehicles
  for update to authenticated
  using       ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy vehicles_admin_delete on public.vehicles
  for delete to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- devices — admin reads the base table (with token_hash). anon reads devices_public only.
-- No anon UPDATE policy, ever: anon is a public key, and a writable last_seen_at would let
-- anybody force or suppress the OFFLINE banner on the guard's screen. Heartbeats are
-- written by the engine with the service key in M3.
drop policy if exists devices_admin_select on public.devices;
create policy devices_admin_select on public.devices
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- events — signed-in browsers read (0004 narrows this to the admin and display roles);
-- nobody but the engine writes.
drop policy if exists events_public_select on public.events;
create policy events_public_select on public.events
  for select to authenticated
  using (true);

-- guard_actions — the guard's overrides are write-only from the gate display, and readable
-- by admins for the audit trail (§3.10: every override is attributed).
drop policy if exists guard_actions_insert       on public.guard_actions;
drop policy if exists guard_actions_admin_select on public.guard_actions;

create policy guard_actions_insert on public.guard_actions
  for insert to authenticated
  with check (true);

create policy guard_actions_admin_select on public.guard_actions
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ---------------------------------------------------------------------------
-- 5. Realtime — INSERT + UPDATE on events reach the display
-- ---------------------------------------------------------------------------
-- Guarded so a second paste into the SQL editor does not abort the script.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    execute 'alter publication supabase_realtime add table public.events';
  end if;
end $$;

-- Deliberately NOT setting `replica identity full` on events: nothing in the display reads
-- the old record, and both the site filter and the RLS check are evaluated against the new
-- record for INSERT and UPDATE alike. It would only cost WAL on the hottest write path.

-- ---------------------------------------------------------------------------
-- 6. Deferred to M3 (CLAUDE.md §4, §8)
-- ---------------------------------------------------------------------------
-- Retention via pg_cron: delete events older than 90 days and crops older than 7 days;
-- never delete guard_actions. Storage bucket `crops` (private, signed URLs) lands in M3
-- with the events page (§8) — the engine writes no crops until then.

-- ---------------------------------------------------------------------------
-- 7. Proof: the public key holds nothing. Raises if any anon grant exists on public.*
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  select string_agg(table_name || ' (' || privilege_type || ')', ', ' order by table_name)
    into bad
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public';
  if bad is not null then
    raise exception 'anon still holds grants on public tables or views: %', bad;
  end if;
end $$;
