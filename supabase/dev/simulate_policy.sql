-- VTrack — dev/simulate_policy.sql   ** LOCAL DEVELOPMENT ONLY **
--
-- OPTIONAL. Apply this only if you want /display?dev=1's Simulate panel to round-trip
-- through Supabase Realtime (proving the real INSERT / UPDATE path) instead of injecting
-- rows straight into the display's reducer. Without it the panel still works — it falls
-- back to local injection and says so once.
--
-- Revert with dev/simulate_policy_down.sql BEFORE any device is put at the gate.
--
-- Why this is not a migration and not open-ended: the anon key ships in the browser on a
-- public GitHub Pages origin. An unscoped `anon can insert events` grant would let anyone
-- who views source push a green PROCEED onto the guard's screen. So both statements are
-- pinned to one device on one fake site, and the display's §6.1 realtime filter
-- (site=eq.<VITE_SITE>) makes those rows structurally unreachable from a real gate display
-- as long as VITE_SITE is not 'devlab'.

-- The FK target the simulated events point at. Repeated here so this file works even if
-- seed.sql has not been run.
insert into devices (id, role, name, site, lane, version)
values ('sim-dev', 'capture', 'Simulate panel', 'devlab', 'A', 'dev')
on conflict (id) do nothing;

-- anon needs the table privilege as well as the policy — 0002_policies.sql revoked it.
grant insert, update on public.events to anon;

drop policy if exists events_sim_insert on public.events;
create policy events_sim_insert on public.events
  for insert to anon
  with check (device_id = 'sim-dev' and site = 'devlab');

-- The UPDATE policy is not optional: the "re-read current vehicle" scenario is an UPDATE,
-- and it is what exercises the §5.3 dedupe upgrade (check → allow) on the display.
drop policy if exists events_sim_update on public.events;
create policy events_sim_update on public.events
  for update to anon
  using      (device_id = 'sim-dev' and site = 'devlab')
  with check (device_id = 'sim-dev' and site = 'devlab');

-- Point the web app at the fake site while you use this:
--   apps/web/.env →  VITE_SITE=devlab
