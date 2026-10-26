-- VA-3379 Phase 3: structured operational log events
-- Existing server_logs rows remain compatible; new columns are additive.

alter table if exists public.server_logs
  add column if not exists event_id text,
  add column if not exists category text not null default 'system',
  add column if not exists client_id text,
  add column if not exists execution_id text,
  add column if not exists operation text,
  add column if not exists status text,
  add column if not exists error_code text,
  add column if not exists retryable boolean not null default false,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists server_logs_event_id_idx
  on public.server_logs (event_id)
  where event_id is not null;

create index if not exists server_logs_category_timestamp_idx
  on public.server_logs (category, timestamp desc);

create index if not exists server_logs_client_timestamp_idx
  on public.server_logs (client_id, timestamp desc);

create index if not exists server_logs_execution_timestamp_idx
  on public.server_logs (execution_id, timestamp desc);

create index if not exists server_logs_status_timestamp_idx
  on public.server_logs (status, timestamp desc);

create index if not exists server_logs_retryable_timestamp_idx
  on public.server_logs (retryable, timestamp desc);
