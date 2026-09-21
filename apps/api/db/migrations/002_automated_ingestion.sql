-- Automated connector ingestion. Safe to apply repeatedly to a ReplayOps database.
-- The API also runs the CREATE TABLE/INDEX subset at startup so an existing free-tier
-- deployment upgrades without a separate paid migration worker.

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

create index if not exists integrations_org_idx on integrations(organization_id, created_at desc);
create index if not exists ingestion_deliveries_source_idx on ingestion_deliveries(integration_id, received_at desc);
create index if not exists ingestion_signals_match_idx on ingestion_signals(service, occurred_at desc) where incident_id is null;
create index if not exists ingestion_signals_correlation_idx on ingestion_signals(correlation_key) where correlation_key is not null;

alter table integrations enable row level security;
alter table ingestion_deliveries enable row level security;
alter table ingestion_signals enable row level security;
