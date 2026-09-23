-- Minimal stand-in for the Supabase-managed parts of a project, so the real VTrack
-- migrations (supabase/migrations/0001, 0002, seed.sql) run on plain Postgres 16.
-- Carried over from the M0 SQL harness. Re-runnable: roles are cluster-wide, so a second
-- test database on the same cluster must not trip over them.

do $$ begin create role anon nologin;                  exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin;         exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase's bootstrap: new tables in public are granted to the API roles by default.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_app_meta_data jsonb default '{"provider":"email","providers":["email"]}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb
);

-- GoTrue's helper: the request's JWT claims, set per-session by PostgREST.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
