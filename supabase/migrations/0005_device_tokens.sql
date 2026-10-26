-- VTrack — 0005_device_tokens.sql
-- Device tokens set from /admin (CLAUDE.md §11, Device tokens, 26 Oct 2026).
--
-- The admin Devices page makes a new random token in the browser, shows it once for
-- pairing, and stores only its sha256 in devices.token_hash. The engine reads the hashes
-- (auth.py) and, for a device that has one, accepts that token alone: the DEVICE_TOKENS
-- host secret and any earlier token stop working. That is rotation without touching
-- Render. Re-runnable. Needs 0004.

alter table public.devices add column if not exists token_rotated_at timestamptz;

-- A hash or nothing: a typo here would lock a camera out with no clue why.
alter table public.devices drop constraint if exists devices_token_hash_shape;
alter table public.devices add constraint devices_token_hash_shape
  check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$');

-- Signed-in browsers may see when a token was last set, never the hash itself (0004).
grant select (token_rotated_at) on public.devices to authenticated;

-- An admin may write these two columns and no others; no browser login may write the rest
-- (Supabase's default grants would otherwise allow every column).
revoke update on public.devices from authenticated;
grant  update (token_hash, token_rotated_at) on public.devices to authenticated;

drop policy if exists devices_admin_update on public.devices;
create policy devices_admin_update on public.devices
  for update to authenticated
  using      (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');
