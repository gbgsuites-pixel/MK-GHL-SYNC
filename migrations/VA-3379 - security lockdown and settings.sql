-- VA-3379: security lockdown + durable settings
-- Idempotent. Safe to re-run.
--
-- 1. Removes the "Allow all operations" policies that let anyone holding the
--    public anon key read, modify, or delete sync history, logs, and contact
--    PII (names, emails, phones). The backend uses the service_role key, which
--    bypasses RLS, so it is unaffected.
-- 2. Enables RLS on integration_client_custom_fields (it had none).
-- 3. Adds integration_settings so the sync schedule survives restarts
--    (Render's filesystem is wiped on every restart/redeploy).
-- 4. Closes executions/client results left "running" by past restarts.

-- ── 1 + 2. Lock down tables ──
do $$
declare
  t text;
begin
  foreach t in array array[
    'sync_executions', 'client_sync_results', 'contact_sync_results',
    'memory_snapshots', 'server_events', 'server_logs',
    'integration_client_custom_fields'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "Allow all operations" on public.%I', t);
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
      execute format('grant all on table public.%I to service_role', t);
    end if;
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;

-- ── 3. Durable settings ──
create table if not exists public.integration_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.integration_settings enable row level security;
revoke all on table public.integration_settings from anon, authenticated;
grant all on table public.integration_settings to service_role;

-- Seed the schedule the dashboard has always displayed (daily 00:30 Chicago).
-- Existing values are never overwritten.
insert into public.integration_settings (key, value)
values ('sync_schedule', '{"cron": "30 0 * * *", "timezone": "America/Chicago", "enabled": true}'::jsonb)
on conflict (key) do nothing;

-- ── 4. Close records orphaned by restarts mid-run ──
update public.sync_executions
   set status = 'interrupted',
       ended_at = coalesce(ended_at, started_at)
 where status = 'running'
   and started_at < now() - interval '1 day';

update public.client_sync_results
   set status = 'interrupted',
       ended_at = coalesce(ended_at, started_at, created_at)
 where status = 'in_progress'
   and created_at < now() - interval '1 day';
