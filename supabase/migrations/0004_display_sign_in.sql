-- VTrack — 0004_display_sign_in.sql
-- The public key opens nothing (CLAUDE.md §11, Display sign-in, 26 Oct 2026).
--
-- Until now the gate display ran on the anon key, which ships inside the public website,
-- so anyone who opened the page could read the approved list (names, ranks, units,
-- plates), the gate history and the device rows, and add rows to guard_actions. With the
-- real list loaded that is a PDPA exposure. From here:
--
--   anon           reads nothing and writes nothing.
--   display        a Supabase Auth user whose app_metadata.role is 'display'
--                  (supabase/display_role.sql). Phone B signs in once with it. It reads
--                  the list, the events and the device status, and writes one kind of
--                  guard_actions row: OK ('confirmed') on a real event.
--   admin          as before (supabase/admin_role.sql), and may also open /display.
--   service_role   the engine; bypasses RLS as before.
--
-- It also clears the Supabase advisor warnings on 0002: the two views no longer run as
-- their owner (security_invoker), every role check reads the JWT once per statement
-- ((select auth.jwt())), guard_actions has no `with check (true)`, and the three foreign
-- keys have indexes.
--
-- APPLY with the web build that has the display sign-in; until phone B signs in it sees
-- no vehicles and no results. Re-runnable: every policy is dropped before it is created.

-- ---------------------------------------------------------------------------
-- 1. Views read as the caller, not as their owner
-- ---------------------------------------------------------------------------
alter view public.vehicles_public set (security_invoker = on);
alter view public.devices_public  set (security_invoker = on);

revoke all on public.vehicles_public from anon;
revoke all on public.devices_public  from anon;
grant select on public.vehicles_public to authenticated;
grant select on public.devices_public  to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Table privileges
-- ---------------------------------------------------------------------------
-- anon: nothing anywhere. (vehicles and devices were already revoked in 0002.)
revoke all on public.events        from anon;
revoke all on public.guard_actions from anon;

-- devices: a signed-in browser may read every column but token_hash. With the views
-- running as the caller, the caller needs the column privilege; granting it per column
-- keeps the token hashes out of every browser, admin's included.
revoke select on public.devices from authenticated;
grant  select (id, role, name, site, lane, last_seen_at, version) on public.devices to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Policies. One permissive policy per table and command, so the advisor's "multiple
--    permissive policies" check stays quiet too.
-- ---------------------------------------------------------------------------
-- vehicles: admin and display read; admin alone writes. The display reads the whole row
-- through vehicles_public's columns, but RLS cannot narrow columns, so keep anything
-- private out of `notes`.
drop policy if exists vehicles_admin_select  on public.vehicles;
drop policy if exists vehicles_select        on public.vehicles;
drop policy if exists vehicles_admin_insert  on public.vehicles;
drop policy if exists vehicles_admin_update  on public.vehicles;
drop policy if exists vehicles_admin_delete  on public.vehicles;

create policy vehicles_select on public.vehicles
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'display'));

create policy vehicles_admin_insert on public.vehicles
  for insert to authenticated
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

create policy vehicles_admin_update on public.vehicles
  for update to authenticated
  using      (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

create policy vehicles_admin_delete on public.vehicles
  for delete to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

-- devices: admin and display read (the OFFLINE banner); only the engine writes.
drop policy if exists devices_admin_select on public.devices;
drop policy if exists devices_select       on public.devices;

create policy devices_select on public.devices
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'display'));

-- events: admin and display read (Realtime applies the same policy to what it pushes);
-- only the engine writes.
drop policy if exists events_public_select on public.events;
drop policy if exists events_select        on public.events;

create policy events_select on public.events
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'display'));

-- guard_actions: OK on the gate screen, and nothing else, from a signed-in display (or
-- an admin looking at /display). Admin reads the trail.
drop policy if exists guard_actions_insert          on public.guard_actions;
drop policy if exists guard_actions_ok_insert       on public.guard_actions;
drop policy if exists guard_actions_admin_select    on public.guard_actions;

create policy guard_actions_ok_insert on public.guard_actions
  for insert to authenticated
  with check (
    ((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'display')
    and action = 'confirmed'
    and event_id is not null
  );

create policy guard_actions_admin_select on public.guard_actions
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

-- ---------------------------------------------------------------------------
-- 4. Indexes for the foreign keys (deleting a vehicle or an event checks these)
-- ---------------------------------------------------------------------------
create index if not exists events_vehicle_id_idx      on public.events (vehicle_id);
create index if not exists events_device_id_idx       on public.events (device_id);
create index if not exists guard_actions_event_id_idx on public.guard_actions (event_id);
