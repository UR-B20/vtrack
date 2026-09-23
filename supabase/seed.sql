-- VTrack — seed.sql
-- The CLAUDE.md §9 fixtures. Re-runnable: every row upserts on its natural key.
--
-- Dates are written relative to current_date where the screens encode a today-relative
-- state (EXPIRING 11 d, EXPIRES TODAY, EXPIRED), so re-running the seed before a demo
-- keeps those badges true instead of silently going stale.

-- ---------------------------------------------------------------------------
-- Devices — seeded FIRST: events.device_id is a foreign key, so without these rows
-- every simulated event insert fails with 23503.
-- token_hash stays null in M0; device tokens are an engine concern from M1.
-- last_seen_at is null because nothing writes heartbeats until M3 — the display's
-- camera state comes from the ?dev=1 panel in M0 (see apps/web/src/routes/display).
-- ---------------------------------------------------------------------------
insert into devices (id, role, name, site, lane, version, last_seen_at) values
  ('cam-a',     'capture', 'Camera A',      'gate1', 'A',  'm0', null),
  ('display-b', 'display', 'Gate display',  'gate1', 'A',  'm0', null),
  ('engine-1',  'engine',  'VTrack Engine', 'gate1', null, 'm0', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Vehicles — eight rows, in the display order of docs/screens/admin.png.
--
-- Two mechanisms are deliberately kept apart:
--   EXPIRED   is status='active' with a past valid_until  (§5.2 → reason 'expired')
--   SUSPENDED is status='suspended'                       (§5.2 → reason 'suspended')
--
-- SKN 8821 R is deliberately NOT seeded — it is the DENY fixture (§9).
-- ---------------------------------------------------------------------------
insert into vehicles
  (plate_norm, plate_display, owner_name, org_unit, vehicle_type, pass_type, status, valid_from, valid_until, notes)
values
  -- 1. the ALLOW example on gate-allowed.png ("valid to 31 Dec 2026")
  ('SBA1234G', 'SBA 1234 G', 'Tan Wei Ming',   'HQ Coy',         'car',        'permanent',  'active',
   date '2026-01-01', date '2026-12-31', null),

  -- 2. MID plate — on the list like everyone else, vehicle_type='military' (§11)
  ('MID12345', 'MID 12345',  'SAF pool vehicle', 'MT Line',      'military',   'permanent',  'active',
   date '2026-01-01', date '2026-12-31', null),

  -- 3. the CHECK example — SNB 953B E repairs to this row
  ('SNB9538E', 'SNB 9538 E', 'Nurul Aisyah',   'A Coy',          'car',        'permanent',  'active',
   date '2026-01-01', date '2026-12-31', null),

  -- 4. motorcycle, F-series
  ('FBA2210T', 'FBA 2210 T', 'Muhammad Faiz',  'B Coy',          'motorcycle', 'permanent',  'active',
   date '2026-01-01', date '2026-12-31', null),

  -- 5. EXPIRING — admin.png shows "EXPIRING 11 d"
  ('SGX4471M', 'SGX 4471 M', 'Lim Hui Ling',   'S1 Branch',      'car',        'permanent',  'active',
   date '2026-01-01', current_date + 11, null),

  -- 6. EXPIRES TODAY — admin.png "Visitor · hosted by HQ Coy"; org_unit holds the bare unit,
  --    the "hosted by" phrasing is composed in the UI.
  ('SNB9502H', 'SNB 9502 H', 'Priya Nair',     'HQ Coy',         'car',        'visitor',    'active',
   current_date, current_date, 'Day visitor'),

  -- 7. EXPIRED — gate-offline.png "Chua Boon Keng · ABC Facilities · Contractor · EXPIRED"
  ('SNB9517R', 'SNB 9517 R', 'Chua Boon Keng', 'ABC Facilities', 'goods',      'contractor', 'active',
   date '2026-06-01', current_date - 9, null),

  -- 8. SUSPENDED — the only status='suspended' row
  ('SLM3090J', 'SLM 3090 J', 'Rajesh Kumar',   'C Coy',          'car',        'permanent',  'suspended',
   date '2026-01-01', date '2026-12-31', 'Pass suspended pending review')

on conflict (plate_norm) do update set
  plate_display = excluded.plate_display,
  owner_name    = excluded.owner_name,
  org_unit      = excluded.org_unit,
  vehicle_type  = excluded.vehicle_type,
  pass_type     = excluded.pass_type,
  status        = excluded.status,
  valid_from    = excluded.valid_from,
  valid_until   = excluded.valid_until,
  notes         = excluded.notes,
  updated_at    = now();

-- Sanity check: 8 rows, and SKN8821R absent.
select count(*) filter (where true)                          as vehicles_seeded,
       count(*) filter (where plate_norm = 'SKN8821R')       as skn8821r_should_be_zero
from vehicles;
