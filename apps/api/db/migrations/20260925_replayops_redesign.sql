begin;

alter table incidents add column if not exists environment text not null default 'unknown';
alter table incidents add column if not exists customer_impact text not null default 'Unknown until measured';
alter table incidents add column if not exists evidence_revision timestamptz not null default now();

alter table incident_events add column if not exists evidence_state text not null default 'active';
alter table incident_events add column if not exists provenance text not null default 'manual';
alter table incident_events add column if not exists correction_reason text;
alter table incident_events add column if not exists corrected_from_id uuid;

alter table integrations add column if not exists expected_cadence_minutes integer not null default 180;
alter table integrations add column if not exists retention_days integer not null default 14;
alter table integrations add column if not exists daily_quota integer not null default 10000;
alter table integrations add column if not exists healthy_sample_rate numeric not null default 0.05;
alter table integrations add column if not exists accepted_today integer not null default 0;
alter table integrations add column if not exists dropped_today integer not null default 0;
alter table integrations add column if not exists counter_date date not null default current_date;

alter table mitigation_requests add column if not exists replay_run_id uuid references replay_runs(id) on delete restrict;
alter table mitigation_requests add column if not exists replay_config jsonb;
alter table mitigation_requests add column if not exists replay_projection jsonb;
alter table mitigation_requests add column if not exists evidence_version timestamptz;
alter table mitigation_requests add column if not exists current_value text not null default 'Not recorded';
alter table mitigation_requests add column if not exists proposed_value text not null default 'Not recorded';
alter table mitigation_requests add column if not exists blast_radius text not null default 'Not recorded';
alter table mitigation_requests add column if not exists change_owner text not null default 'Unassigned';
alter table mitigation_requests add column if not exists observation_minutes integer not null default 15;

alter table recovery_verifications add column if not exists unit text not null default 'value';
alter table recovery_verifications add column if not exists comparison text not null default 'lte';
alter table recovery_verifications add column if not exists source text not null default 'Legacy observation';
alter table recovery_verifications add column if not exists query text not null default 'Unavailable for legacy observation';
alter table recovery_verifications add column if not exists window_started_at timestamptz;
alter table recovery_verifications add column if not exists window_ended_at timestamptz;
alter table recovery_verifications add column if not exists observed_at timestamptz;
alter table recovery_verifications add column if not exists freshness_minutes integer not null default 0;

create table if not exists notification_states (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_id text not null,
  read_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(user_id,notification_id)
);

create table if not exists workspace_privacy_settings (
  organization_id uuid primary key references organizations(id) on delete cascade,
  external_ai_enabled boolean not null default true,
  capture_request_bodies boolean not null default false,
  product_analytics_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists incident_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  actor text not null,
  body text not null,
  event_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists http_replay_specs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  name text not null,
  evidence_revision timestamptz not null,
  application_version text not null,
  request jsonb not null,
  assertions jsonb not null,
  dependencies jsonb not null default '[]',
  network_policy text not null default 'deny_except_loopback_target',
  created_at timestamptz not null default now()
);

create table if not exists http_replay_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  spec_id uuid not null references http_replay_specs(id) on delete cascade,
  evidence_revision timestamptz not null,
  status text not null check(status in ('passed','failed','unsupported')),
  assertion_results jsonb not null default '[]',
  response_status integer,
  response_body text,
  duration_ms integer,
  nondeterministic boolean not null default false,
  limitation text,
  created_at timestamptz not null default now()
);

create index if not exists incident_comments_incident_idx on incident_comments(incident_id,created_at);
create index if not exists http_replay_incident_idx on http_replay_specs(incident_id,created_at desc);

alter table notification_states enable row level security;
alter table workspace_privacy_settings enable row level security;
alter table incident_comments enable row level security;
alter table http_replay_specs enable row level security;
alter table http_replay_executions enable row level security;

commit;
