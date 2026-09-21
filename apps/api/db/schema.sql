create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null check (role in ('admin', 'responder', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  title text not null,
  summary text not null,
  service text not null,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  status text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  owner text not null,
  started_at timestamptz not null,
  resolved_at timestamptz,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table if not exists incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  timestamp timestamptz not null,
  service text not null,
  kind text not null check (kind in ('alert', 'deploy', 'dependency', 'metric', 'action', 'recovery')),
  title text not null,
  detail text not null,
  impact_score integer not null default 0 check (impact_score between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists incident_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid references incidents(id) on delete cascade,
  actor text not null,
  action text not null,
  detail text not null,
  timestamp timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, actor, action, timestamp)
);

create table if not exists replay_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  name text not null,
  status text not null check (status in ('queued', 'running', 'passed', 'failed')),
  progress integer not null check (progress between 0 and 100),
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists service_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service text not null,
  availability numeric(6,3) not null check (availability between 0 and 100),
  latency_ms integer not null check (latency_ms >= 0),
  error_rate numeric(6,3) not null check (error_rate between 0 and 100),
  state text not null check (state in ('nominal', 'degraded', 'critical')),
  observed_at timestamptz not null,
  unique (organization_id, service, observed_at)
);

create table if not exists event_volume_samples (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sampled_at timestamptz not null,
  requests integer not null check (requests >= 0),
  errors integer not null check (errors >= 0 and errors <= requests),
  unique (organization_id, sampled_at)
);

create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  name text not null,
  provider text not null check (provider in ('github', 'otel', 'generic')),
  status text not null default 'active' check (status in ('active', 'paused')),
  last_delivery_at timestamptz,
  last_delivery_status text check (last_delivery_status in ('accepted', 'duplicate', 'rejected', 'failed')),
  signal_count integer not null default 0 check (signal_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ingestion_deliveries (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  external_id text not null,
  status text not null check (status in ('accepted', 'duplicate', 'rejected', 'failed')),
  signal_count integer not null default 0,
  incident_ids uuid[] not null default '{}',
  error text,
  received_at timestamptz not null default now(),
  unique (integration_id, external_id)
);

create table if not exists ingestion_signals (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  external_id text not null,
  occurred_at timestamptz not null,
  service text not null,
  kind text not null check (kind in ('alert', 'deploy', 'dependency', 'metric', 'action', 'recovery')),
  title text not null,
  detail text not null,
  impact_score integer not null check (impact_score between 0 and 100),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  correlation_key text,
  trace_id text,
  source_url text,
  environment text,
  metadata jsonb not null default '{}'::jsonb,
  incident_id uuid references incidents(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (integration_id, external_id)
);

create table if not exists service_catalog (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  owner_team text not null,
  tier text not null check (tier in ('critical','standard','internal')),
  repository_url text,
  runbook_url text,
  dependencies text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,name)
);

create table if not exists incident_policies (
  organization_id uuid primary key references organizations(id) on delete cascade,
  incident_threshold integer not null default 65 check (incident_threshold between 1 and 100),
  grouping_window_minutes integer not null default 120 check (grouping_window_minutes between 5 and 1440),
  suppress_low_severity boolean not null default true,
  maintenance_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','responder','viewer')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists workspace_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor text not null,
  action text not null,
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists mitigation_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  requested_by text not null,
  reviewed_by text,
  title text not null,
  action text not null,
  rollback_plan text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists ingestion_queue (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  external_id text not null,
  batch jsonb not null,
  status text not null default 'queued' check(status in ('queued','processing','completed','retrying','dead_letter')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(integration_id,external_id)
);

create index if not exists incidents_started_at_idx on incidents(organization_id, started_at desc);
create index if not exists incidents_status_idx on incidents(organization_id, status);
create index if not exists incident_events_incident_time_idx on incident_events(incident_id, timestamp);
create index if not exists incident_activities_org_time_idx on incident_activities(organization_id, timestamp desc);
create index if not exists replay_runs_org_created_idx on replay_runs(organization_id, created_at desc);
create index if not exists service_health_org_time_idx on service_health_snapshots(organization_id, observed_at desc);
create index if not exists event_volume_org_time_idx on event_volume_samples(organization_id, sampled_at);
create index if not exists incidents_embedding_idx on incidents using hnsw (embedding vector_cosine_ops);
create index if not exists integrations_org_idx on integrations(organization_id, created_at desc);
create index if not exists ingestion_deliveries_source_idx on ingestion_deliveries(integration_id, received_at desc);
create index if not exists ingestion_signals_match_idx on ingestion_signals(service, occurred_at desc) where incident_id is null;
create index if not exists ingestion_signals_correlation_idx on ingestion_signals(correlation_key) where correlation_key is not null;
create index if not exists service_catalog_org_idx on service_catalog(organization_id,name);
create index if not exists workspace_audit_org_idx on workspace_audit_log(organization_id,created_at desc);
create index if not exists mitigation_incident_idx on mitigation_requests(incident_id,created_at desc);
create index if not exists ingestion_queue_ready_idx on ingestion_queue(status,next_attempt_at);

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table incidents enable row level security;
alter table incident_events enable row level security;
alter table incident_activities enable row level security;
alter table replay_runs enable row level security;
alter table service_health_snapshots enable row level security;
alter table event_volume_samples enable row level security;
alter table integrations enable row level security;
alter table ingestion_deliveries enable row level security;
alter table ingestion_signals enable row level security;
alter table service_catalog enable row level security;
alter table incident_policies enable row level security;
alter table organization_invitations enable row level security;
alter table workspace_audit_log enable row level security;
alter table mitigation_requests enable row level security;
alter table ingestion_queue enable row level security;

create policy "members can read own memberships" on organization_members for select
using (user_id = auth.uid());

create policy "members can read organizations" on organizations for select
using (exists (select 1 from organization_members m where m.organization_id = id and m.user_id = auth.uid()));

create policy "members can read incidents" on incidents for select
using (exists (select 1 from organization_members m where m.organization_id = incidents.organization_id and m.user_id = auth.uid()));

create policy "responders can manage incidents" on incidents for all
using (exists (select 1 from organization_members m where m.organization_id = incidents.organization_id and m.user_id = auth.uid() and m.role in ('admin', 'responder')))
with check (exists (select 1 from organization_members m where m.organization_id = incidents.organization_id and m.user_id = auth.uid() and m.role in ('admin', 'responder')));

create policy "members can read incident events" on incident_events for select
using (exists (
  select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
  where i.id = incident_events.incident_id and m.user_id = auth.uid()
));

create policy "responders can manage incident events" on incident_events for all
using (exists (
  select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
  where i.id = incident_events.incident_id and m.user_id = auth.uid() and m.role in ('admin', 'responder')
))
with check (exists (
  select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
  where i.id = incident_events.incident_id and m.user_id = auth.uid() and m.role in ('admin', 'responder')
));

create policy "members can read activities" on incident_activities for select
using (exists (select 1 from organization_members m where m.organization_id = incident_activities.organization_id and m.user_id = auth.uid()));

create policy "members can read replay runs" on replay_runs for select
using (exists (select 1 from organization_members m where m.organization_id = replay_runs.organization_id and m.user_id = auth.uid()));

create policy "members can read service health" on service_health_snapshots for select
using (exists (select 1 from organization_members m where m.organization_id = service_health_snapshots.organization_id and m.user_id = auth.uid()));

create policy "members can read event volume" on event_volume_samples for select
using (exists (select 1 from organization_members m where m.organization_id = event_volume_samples.organization_id and m.user_id = auth.uid()));

create policy "members can read integrations" on integrations for select
using (exists (select 1 from organization_members m where m.organization_id = integrations.organization_id and m.user_id = auth.uid()));

create policy "responders can manage integrations" on integrations for all
using (exists (select 1 from organization_members m where m.organization_id = integrations.organization_id and m.user_id = auth.uid() and m.role in ('admin', 'responder')))
with check (exists (select 1 from organization_members m where m.organization_id = integrations.organization_id and m.user_id = auth.uid() and m.role in ('admin', 'responder')));

create policy "members can read deliveries" on ingestion_deliveries for select
using (exists (
  select 1 from integrations x join organization_members m on m.organization_id = x.organization_id
  where x.id = ingestion_deliveries.integration_id and m.user_id = auth.uid()
));

create policy "members can read ingestion signals" on ingestion_signals for select
using (exists (
  select 1 from integrations x join organization_members m on m.organization_id = x.organization_id
  where x.id = ingestion_signals.integration_id and m.user_id = auth.uid()
));

create policy "members can read service catalog" on service_catalog for select
using (exists (select 1 from organization_members m where m.organization_id = service_catalog.organization_id and m.user_id = auth.uid()));

create policy "responders can manage service catalog" on service_catalog for all
using (exists (select 1 from organization_members m where m.organization_id = service_catalog.organization_id and m.user_id = auth.uid() and m.role in ('admin','responder')))
with check (exists (select 1 from organization_members m where m.organization_id = service_catalog.organization_id and m.user_id = auth.uid() and m.role in ('admin','responder')));

create policy "members can read incident policy" on incident_policies for select
using (exists (select 1 from organization_members m where m.organization_id = incident_policies.organization_id and m.user_id = auth.uid()));

create policy "admins can manage incident policy" on incident_policies for all
using (exists (select 1 from organization_members m where m.organization_id = incident_policies.organization_id and m.user_id = auth.uid() and m.role = 'admin'))
with check (exists (select 1 from organization_members m where m.organization_id = incident_policies.organization_id and m.user_id = auth.uid() and m.role = 'admin'));

create policy "admins can manage invitations" on organization_invitations for all
using (exists (select 1 from organization_members m where m.organization_id = organization_invitations.organization_id and m.user_id = auth.uid() and m.role = 'admin'))
with check (exists (select 1 from organization_members m where m.organization_id = organization_invitations.organization_id and m.user_id = auth.uid() and m.role = 'admin'));

create policy "members can read workspace audit" on workspace_audit_log for select
using (exists (select 1 from organization_members m where m.organization_id = workspace_audit_log.organization_id and m.user_id = auth.uid()));

create policy "members can read mitigation requests" on mitigation_requests for select
using (exists (select 1 from organization_members m where m.organization_id = mitigation_requests.organization_id and m.user_id = auth.uid()));

create policy "responders can create mitigation requests" on mitigation_requests for insert
with check (exists (select 1 from organization_members m where m.organization_id = mitigation_requests.organization_id and m.user_id = auth.uid() and m.role in ('admin','responder')));

create policy "members can read ingestion queue" on ingestion_queue for select
using (exists (
  select 1 from integrations x join organization_members m on m.organization_id = x.organization_id
  where x.id = ingestion_queue.integration_id and m.user_id = auth.uid()
));

create or replace function public.seed_replayops_workspace(target_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  checkout_incident_id uuid := gen_random_uuid();
  search_incident_id uuid := gen_random_uuid();
  identity_incident_id uuid := gen_random_uuid();
begin
  if exists (
    select 1 from public.incidents
    where organization_id = target_organization_id and code = 'ROP-1842'
  ) then
    return;
  end if;

  insert into public.incidents (
    id, organization_id, code, title, summary, service, severity, status, owner,
    started_at, resolved_at, created_at, updated_at
  ) values
    (checkout_incident_id, target_organization_id, 'ROP-1842', 'Checkout retries amplified inventory latency', 'A delayed inventory replica triggered synchronized checkout retries and elevated payment authorization latency.', 'checkout-api', 'critical', 'identified', 'Maya Chen', '2026-09-20T05:41:12Z', null, '2026-09-20T05:44:00Z', '2026-09-20T06:06:00Z'),
    (search_incident_id, target_organization_id, 'ROP-1838', 'Search indexing backlog after catalog import', 'A bulk catalog import exceeded the indexing consumer''s safe concurrency and delayed search freshness.', 'search-indexer', 'high', 'monitoring', 'Noah Williams', '2026-09-19T21:18:00Z', null, '2026-09-19T21:22:00Z', '2026-09-20T04:10:00Z'),
    (identity_incident_id, target_organization_id, 'ROP-1829', 'Session cache eviction storm', 'A cache node replacement shifted hot keys to one shard and increased authentication misses.', 'identity-edge', 'medium', 'resolved', 'Ishan Rao', '2026-09-18T09:10:00Z', '2026-09-18T10:02:00Z', '2026-09-18T09:13:00Z', '2026-09-18T11:20:00Z');

  insert into public.incident_events (incident_id, timestamp, service, kind, title, detail, impact_score, metadata)
  values
    (checkout_incident_id, '2026-09-20T05:41:12Z', 'inventory-api', 'metric', 'Connection pool saturation begins', 'Pool utilization crossed 92% while median query time remained within baseline.', 42, '{"signal":"pool.utilization","value":92}'),
    (checkout_incident_id, '2026-09-20T05:43:28Z', 'inventory-api', 'dependency', 'Replica lag exceeds checkout budget', 'Read replica lag reached 8.4 seconds while availability checks continued to pass.', 68, '{"signal":"replica.lag.seconds","value":8.4}'),
    (checkout_incident_id, '2026-09-20T05:45:03Z', 'checkout-api', 'alert', 'Retry amplification detected', 'Checkout retries increased 7.2× and propagated load to payment authorization.', 91, '{"signal":"retry.multiplier","value":7.2}'),
    (checkout_incident_id, '2026-09-20T05:47:19Z', 'payments-api', 'alert', 'Payment latency breaches SLO', 'P95 authorization latency reached 3.8 seconds; customer timeouts began.', 96, '{"signal":"latency.p95.ms","value":3800}'),
    (checkout_incident_id, '2026-09-20T05:54:44Z', 'checkout-api', 'action', 'Retry ceiling reduced', 'On-call changed retry attempts from four to one and drained the oldest queue partition.', 58, '{"approvedBy":"Maya Chen"}'),
    (checkout_incident_id, '2026-09-20T06:02:11Z', 'payments-api', 'recovery', 'Authorization latency recovers', 'P95 returned below 620ms. Duplicate-order reconciliation remains in progress.', 24, '{"signal":"latency.p95.ms","value":620}'),
    (search_incident_id, '2026-09-19T21:18:00Z', 'search-indexer', 'alert', 'Index freshness exceeds ten minutes', 'Consumer lag rose after a 2.1 million item catalog import.', 72, '{"catalogItems":2100000}'),
    (search_incident_id, '2026-09-19T21:31:00Z', 'search-indexer', 'action', 'Consumer concurrency capped', 'Concurrency was reduced to prevent database connection exhaustion.', 43, '{"concurrency":12}'),
    (identity_incident_id, '2026-09-18T09:10:00Z', 'identity-edge', 'deploy', 'Cache node replacement completed', 'Consistent-hash ring converged with one shard carrying 46% of hot keys.', 61, '{"hotKeyShare":46}');

  insert into public.incident_activities (organization_id, incident_id, actor, action, detail, timestamp)
  values
    (target_organization_id, checkout_incident_id, 'Maya Chen', 'isolated initiating dependency', 'Marked inventory replica lag as the likely trigger.', '2026-09-20T06:06:00Z'),
    (target_organization_id, search_incident_id, 'Replay worker', 'completed candidate replay', 'Concurrency cap prevented connection saturation in 18 of 18 runs.', '2026-09-20T05:58:00Z'),
    (target_organization_id, null, 'System', 'ingested synthetic telemetry', '1,248 normalized events added to the demonstration workspace.', '2026-09-20T05:36:00Z');

  insert into public.replay_runs (organization_id, incident_id, name, status, progress, created_at)
  values
    (target_organization_id, checkout_incident_id, 'Retry ceiling: 4 → 1', 'running', 68, '2026-09-20T06:03:00Z'),
    (target_organization_id, search_incident_id, 'Indexer concurrency cap', 'passed', 100, '2026-09-20T05:35:00Z');

  insert into public.service_health_snapshots (organization_id, service, availability, latency_ms, error_rate, state, observed_at)
  values
    (target_organization_id, 'checkout-api', 98.720, 842, 3.800, 'critical', '2026-09-20T06:05:00Z'),
    (target_organization_id, 'inventory-api', 99.310, 486, 1.700, 'degraded', '2026-09-20T06:05:00Z'),
    (target_organization_id, 'payments-api', 99.860, 612, 0.800, 'degraded', '2026-09-20T06:05:00Z'),
    (target_organization_id, 'identity-edge', 99.990, 84, 0.030, 'nominal', '2026-09-20T06:05:00Z');

  insert into public.event_volume_samples (organization_id, sampled_at, requests, errors)
  values
    (target_organization_id, '2026-09-20T05:35:00Z', 48, 2),
    (target_organization_id, '2026-09-20T05:40:00Z', 52, 3),
    (target_organization_id, '2026-09-20T05:45:00Z', 74, 18),
    (target_organization_id, '2026-09-20T05:50:00Z', 91, 31),
    (target_organization_id, '2026-09-20T05:55:00Z', 82, 22),
    (target_organization_id, '2026-09-20T06:00:00Z', 68, 10),
    (target_organization_id, '2026-09-20T06:05:00Z', 58, 4);
end;
$$;

revoke all on function public.seed_replayops_workspace(uuid) from public;

create or replace function public.provision_replayops_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := gen_random_uuid();
  workspace_name text := coalesce(
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'ReplayOps operator'
  );
begin
  insert into public.organizations (id, name, slug)
  values (workspace_id, workspace_name || ' workspace', 'workspace-' || new.id::text);

  insert into public.organization_members (organization_id, user_id, email, display_name, role)
  values (workspace_id, new.id, new.email, workspace_name, 'admin');

  perform public.seed_replayops_workspace(workspace_id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.provision_replayops_workspace();
