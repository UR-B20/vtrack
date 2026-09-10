-- VTrack — 0002_policies.sql
-- RLS, the limited-column public views, and the realtime publication (CLAUDE.md §4).
-- Safe to re-run: every policy is dropped before it is created.
--
-- The access model in one paragraph:
--   anon  (the key that ships in the browser on GitHub Pages) has NO privilege on the
--         vehicles or devices base tables at all. It reads them only through the two
--         views below, which expose a fixed column list and never token_hash. It may
--         select events and insert guard_actions; it may never write an event.
--   authenticated  holds table privileges on vehicles so that RLS can narrow them —
--         in Postgres, RLS restricts a privilege you already hold, it never grants one.
--         The admin policies are what actually restrict the grant.
--   service_role   (engine only, M1+) bypasses RLS entirely.

-- ---------------------------------------------------------------------------
-- 1. Row level security on every table
-- ---------------------------------------------------------------------------
alter table public.vehicles      enable row level security;
alter table public.devices       enable row level security;
alter table public.events        enable row level security;
alter table public.guard_actions enable row level security;

-- NOTE: deliberately no `force row level security` on vehicles. The views below are
-- non-security_invoker, so they read the base table as their owner — and an owner is
-- exempt from RLS only while FORCE is off. Turning FORCE on would silently empty
-- /display's vehicle lookups and the offline IndexedDB cache.

-- ---------------------------------------------------------------------------
-- 2. Table privileges
-- ---------------------------------------------------------------------------
-- anon: nothing on the base tables.
revoke all on public.vehicles from anon;
revoke all on public.devices  from anon;

-- anon: read events, write guard_actions, nothing else.
revoke all on public.events from anon;
grant  select on public.events to anon;
revoke all on public.guard_actions from anon;
grant  insert on public.guard_actions to anon;

-- authenticated: needs the privilege for RLS to have something to narrow.
grant select, insert, update, delete on public.vehicles to authenticated;
grant select on public.devices       to authenticated;
grant select on public.events        to authenticated;
grant select, insert on public.guard_actions to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Public views — the only path anon has to vehicles and devices
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

-- security_invoker OFF (the default) is load-bearing, not incidental: it is what lets the
-- view read the RLS-protected base table on anon's behalf while exposing only these columns.
alter view public.vehicles_public set (security_invoker = off);
alter view public.devices_public  set (security_invoker = off);

alter view public.vehicles_public owner to postgres;
alter view public.devices_public  owner to postgres;

grant select on public.vehicles_public to anon, authenticated;
grant select on public.devices_public  to anon, authenticated;

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

-- events — everyone reads (the display runs on the anon key); nobody but the engine writes.
drop policy if exists events_public_select on public.events;
create policy events_public_select on public.events
  for select to anon, authenticated
  using (true);

-- guard_actions — the guard's overrides are write-only from the gate display, and readable
-- by admins for the audit trail (§3.10: every override is attributed).
drop policy if exists guard_actions_insert       on public.guard_actions;
drop policy if exists guard_actions_admin_select on public.guard_actions;

create policy guard_actions_insert on public.guard_actions
  for insert to anon, authenticated
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
-- never delete guard_actions. Storage bucket `crops` (private, signed URLs) lands with the
-- engine in M1 — there are no crops to store until then.
