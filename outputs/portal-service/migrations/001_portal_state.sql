-- NIOS Best Academy durable portal-state store for Supabase Postgres.
-- Apply this once in Supabase Dashboard → SQL Editor while signed in as the
-- project owner. Do not paste service-role keys, student data, or credentials
-- into this file or the SQL Editor.

create table if not exists public.portal_state (
  id text primary key check (id = 'primary'),
  revision bigint not null default 0 check (revision >= 0),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.portal_state_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists portal_state_set_updated_at on public.portal_state;
create trigger portal_state_set_updated_at
before update on public.portal_state
for each row execute function public.portal_state_set_updated_at();

revoke all on function public.portal_state_set_updated_at() from public, anon, authenticated;
grant execute on function public.portal_state_set_updated_at() to service_role;

-- The API uses only the server-only Supabase service-role key. Browser roles
-- have no access to this encrypted application-state snapshot.
alter table public.portal_state enable row level security;
revoke all on table public.portal_state from public, anon, authenticated;
grant select, insert, update on table public.portal_state to service_role;

-- Deliberately do not insert a row here. The server inserts the first state
-- atomically after it validates the connection and its encryption key.
