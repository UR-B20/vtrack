-- VTrack — display_role.sql
-- Grants the `display` role claim that 0004_display_sign_in.sql checks: the login phone B
-- signs in with on /display.
--
-- RUN THIS BY HAND in the Supabase SQL editor. It is deliberately NOT in migrations/: it
-- depends on a user that does not exist at migrate time.
--
-- ORDER MATTERS
--   1. Supabase dashboard → Authentication → Users → Add user → Create new user.
--      Email: any address you control (it is a login name; no mail is sent).
--      Password: long and random (20+ characters, from a password manager).
--      Tick "Auto Confirm User".
--   2. Put that email below and run this file. It must report one row; it raises if it
--      matches nothing.
--   3. Sign in on /display. A session started before this ran keeps the old token until
--      it refreshes: sign out (?dev=1 panel) and back in.
--
-- `||` MERGES rather than replaces, as in admin_role.sql: GoTrue owns the other keys.

do $$
declare
  v_email text := lower('display@example.com');   -- <<< REPLACE with the display login's email
  v_id    uuid;
  v_meta  jsonb;
begin
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('role', 'display')
   where lower(email) = v_email
  returning id, raw_app_meta_data into v_id, v_meta;

  if v_id is null then
    raise exception
      'No auth.users row for %. Create the user under Authentication → Users first, then re-run this file.',
      v_email;
  end if;

  raise notice 'display role granted: % (%) -> %', v_email, v_id, v_meta;
end $$;

-- Verify (should show "role": "display" inside raw_app_meta_data)
select id, email, raw_app_meta_data
from auth.users
where lower(email) = lower('display@example.com');   -- <<< same email as above
