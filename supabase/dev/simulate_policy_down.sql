-- VTrack — dev/simulate_policy_down.sql
-- Reverts dev/simulate_policy.sql. Run this before any device goes to the gate.

drop policy if exists events_sim_insert on public.events;
drop policy if exists events_sim_update on public.events;

revoke insert, update on public.events from anon;

-- Remove the simulated data and its device.
delete from guard_actions
 where event_id in (select id from events where site = 'devlab');
delete from events  where site = 'devlab';
delete from devices where id = 'sim-dev';

-- Confirm anon is back to select-only on events, and no sim policies remain.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'events';

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'events' and grantee = 'anon';
