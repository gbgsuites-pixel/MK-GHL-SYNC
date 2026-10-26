-- VA-3379 Phase 2: encrypted managed client storage
-- Run this migration in the Supabase SQL editor before enabling
-- MANAGED_CLIENTS_ENABLED=true in the backend.

create extension if not exists pgcrypto;

create table if not exists public.integration_clients (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  consultant_num text not null,
  ghl_location_id text not null,
  ghl_custom_fields jsonb not null default '{}'::jsonb,
  encrypted_credentials text not null,
  secret_key_version text not null default 'v1',
  status text not null default 'pending_validation'
    check (status in ('pending_validation', 'active', 'paused', 'invalid', 'disconnected', 'removal_pending')),
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'valid', 'invalid', 'unknown')),
  validation_error_code text,
  last_validation_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (consultant_num)
);

create index if not exists integration_clients_status_idx
  on public.integration_clients (status);

create index if not exists integration_clients_updated_at_idx
  on public.integration_clients (updated_at desc);

alter table public.integration_clients
  add column if not exists last_sync_stats jsonb not null default '{}'::jsonb;

create or replace function public.set_integration_clients_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists integration_clients_updated_at on public.integration_clients;
create trigger integration_clients_updated_at
before update on public.integration_clients
for each row execute function public.set_integration_clients_updated_at();

alter table public.integration_clients enable row level security;

-- The backend uses the Supabase service role key. No browser/API anon access
-- is granted to this table; all access is mediated by the backend management API.
revoke all on table public.integration_clients from anon, authenticated;
grant all on table public.integration_clients to service_role;
