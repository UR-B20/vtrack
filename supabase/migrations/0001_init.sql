-- VTrack — 0001_init.sql
-- Schema exactly as specified in CLAUDE.md §4.
-- Paste order: 0001_init.sql → 0002_policies.sql → seed.sql → (sign in once) → admin_role.sql

create type decision as enum ('allow','deny','check');
create type deny_reason as enum ('not_on_list','expired','suspended','unreadable','low_confidence','ambiguous','invalid_pattern');
create type plate_kind as enum ('civilian','mid','foreign','invalid');

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_norm text not null unique,          -- 'SBA1234G', 'MID12345'  (A-Z0-9 only)
  plate_display text not null,              -- 'SBA 1234 G'
  owner_name text not null,
  org_unit text,
  vehicle_type text check (vehicle_type in ('car','motorcycle','goods','bus','military','other')),
  pass_type text not null default 'permanent' check (pass_type in ('permanent','visitor','contractor')),
  status text not null default 'active' check (status in ('active','suspended')),
  valid_from date, valid_until date,
  notes text,
  created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now()
);

create table devices (
  id text primary key,                      -- 'cam-a', 'display-b', 'engine-1'
  role text not null check (role in ('capture','display','engine')),
  name text, site text, lane text,
  token_hash text,                          -- sha256 of the device token (capture nodes)
  last_seen_at timestamptz, version text
);

create table events (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  device_id text references devices(id),
  site text, lane text,
  plate_raw text, plate_norm text, plate_kind plate_kind,
  confidence numeric(4,3), checksum_ok boolean, repaired_from text,
  vehicle_id uuid references vehicles(id),
  decision decision not null, reason deny_reason,
  image_path text, bbox jsonb, engine text, latency_ms int,
  read_count int not null default 1,
  last_read_at timestamptz not null default now(),   -- bumped by dedupe; the display's hold/clear rule reads it
  source text not null default 'camera' check (source in ('camera','manual'))
);
create index events_ts_idx on events (ts desc);
create index events_plate_idx on events (plate_norm, ts desc);

create table guard_actions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  action text not null check (action in ('let_through','turned_away','manual_entry','confirmed')),
  reason text, actor text, ts timestamptz default now()
);
