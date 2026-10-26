-- VTrack — 0006_vehicles_for_display.sql
-- The display reads the approved list through a role-checking function, not a policy on
-- the base table (CLAUDE.md §11, Security review, 26 Oct 2026).
--
-- 0004 gave the `display` role a SELECT policy on `vehicles`. RLS cannot narrow columns, so a
-- stolen phone B that is still signed in could read every column of every row — `notes`,
-- `created_by`, the ids — not only the eight columns the screen uses. From here:
--
--   vehicles_for_display()   security definer, owned by postgres, returns exactly the
--                            vehicles_public columns, and only when the caller's JWT carries
--                            the admin or display role. Nothing else may call it.
--   vehicles_public          now selects from that function (same columns, same name, so
--                            apps/web/src/lib/cache.ts is unchanged).
--   vehicles (base table)    SELECT policy back to admin only. The display login has no
--                            path to `notes` or any other column.
--
-- Re-runnable. Needs 0004.

create or replace function public.vehicles_for_display()
returns table (
  plate_norm    text,
  plate_display text,
  owner_name    text,
  org_unit      text,
  pass_type     text,
  status        text,
  valid_from    date,
  valid_until   date
)
language sql
stable
security definer
set search_path = public
as $$
  select plate_norm, plate_display, owner_name, org_unit, pass_type, status, valid_from, valid_until
    from public.vehicles
   where ((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin', 'display');
$$;

alter function public.vehicles_for_display() owner to postgres;
revoke all on function public.vehicles_for_display() from public;
revoke all on function public.vehicles_for_display() from anon;
grant execute on function public.vehicles_for_display() to authenticated;

-- Same columns in the same order as 0002's view, so `create or replace` is allowed.
create or replace view public.vehicles_public as
  select plate_norm, plate_display, owner_name, org_unit, pass_type, status, valid_from, valid_until
    from public.vehicles_for_display();

alter view public.vehicles_public set (security_invoker = on);
alter view public.vehicles_public owner to postgres;
revoke all on public.vehicles_public from anon;
grant select on public.vehicles_public to authenticated;

-- The base table: admin only, as 0002 had it.
drop policy if exists vehicles_select       on public.vehicles;
drop policy if exists vehicles_admin_select on public.vehicles;
create policy vehicles_admin_select on public.vehicles
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

-- Proof: the public key holds nothing, and the function is not callable by it.
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
  if has_function_privilege('anon', 'public.vehicles_for_display()', 'execute') then
    raise exception 'anon may call vehicles_for_display()';
  end if;
end $$;
