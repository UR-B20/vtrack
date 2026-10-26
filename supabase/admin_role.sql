-- VTrack — admin_role.sql
-- Grants the `admin` role claim that 0002_policies.sql checks.
--
-- RUN THIS BY HAND in the Supabase SQL editor. It is deliberately NOT in migrations/:
-- it depends on a row that does not exist at migrate time, and it names one person.
--
-- ORDER MATTERS
--   1. Create the admin's user in the dashboard: Authentication → Users → Add user →
--      Create new user, the admin's email, any password (OTP sign-in never uses it), tick
--      "Auto Confirm User". The sign-in form no longer creates accounts
--      (shouldCreateUser: false), and the project's "Allow new users to sign up" switch
--      should be OFF, so this is the only way an auth.users row comes to exist.
--   2. Run this file. It must report one row; it raises if it matches nothing.
--   3. Sign OUT and back IN. app_metadata is baked into the JWT when the token is issued,
--      so an existing session keeps the old claim until it refreshes (1 h by default).
--      Until then vehicles CRUD returns permission denied / empty rows. That is expected —
--      do not loosen 0002_policies.sql to work around it.
--
-- `||` MERGES rather than replaces. A plain `set raw_app_meta_data = '{"role":"admin"}'`
-- would wipe GoTrue's own provider / providers keys on a column it owns.

do $$
declare
  v_email text := lower('you@example.com');   -- <<< REPLACE with the admin's email
  v_id    uuid;
  v_meta  jsonb;
begin
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('role', 'admin')
   where lower(email) = v_email
  returning id, raw_app_meta_data into v_id, v_meta;

  if v_id is null then
    raise exception
      'No auth.users row for %. Create the user under Authentication → Users first, then re-run this file.',
      v_email;
  end if;

  raise notice 'admin role granted: % (%) -> %', v_email, v_id, v_meta;
end $$;

-- Verify (should show "role": "admin" inside raw_app_meta_data)
select id, email, raw_app_meta_data
from auth.users
where lower(email) = lower('you@example.com');   -- <<< same email as above
