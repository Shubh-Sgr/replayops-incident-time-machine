-- ReplayOps final investigation, exact validation, and recovery lifecycle.
-- Additive and backward-compatible: legacy replay/recovery records remain readable.

create table if not exists investigation_checks (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, template_id text not null, title text not null,
  question text not null, method text not null, expected_signal text not null, conditions text not null,
  result text not null default '', status text not null check(status in ('planned','running','supported','disproved','inconclusive')),
  assignee text not null, evidence_ids uuid[] not null default '{}', evidence_revision timestamptz not null,
  conclusion_state text not null default 'current' check(conclusion_state in ('current','needs_recheck')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists evidence_review_cursors (
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  evidence_revision timestamptz not null, reviewed_at timestamptz not null default now(), primary key(incident_id,user_id)
);

create table if not exists change_proposals (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, version integer not null,
  supersedes_id uuid references change_proposals(id), title text not null, change_text text not null, rollback_plan text not null,
  target jsonb not null default '{}', evidence_revision timestamptz not null, created_by text not null,
  created_at timestamptz not null default now(), unique(incident_id,version)
);

create table if not exists validation_artifacts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, proposal_id uuid not null references change_proposals(id) on delete cascade,
  proposal_version integer not null, kind text not null check(kind in ('ci','manual','isolated_http')),
  status text not null check(status in ('passed','failed','unsupported')), summary text not null,
  provenance jsonb not null default '{}', evidence_revision timestamptz not null, created_by text not null, created_at timestamptz not null default now()
);

create table if not exists proposal_reviews (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, proposal_id uuid not null references change_proposals(id) on delete cascade,
  proposal_version integer not null, requested_by text not null, reviewed_by text,
  status text not null default 'pending' check(status in ('pending','approved','rejected')), reason text not null default '',
  evidence_revision timestamptz not null, created_at timestamptz not null default now(), reviewed_at timestamptz
);

create table if not exists recovery_criteria (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, version integer not null,
  kind text not null check(kind in ('runtime','delivery')), name text not null, source text not null, query text not null,
  unit text not null, comparison text not null check(comparison in ('lte','gte')), target_value double precision not null,
  min_consecutive_windows integer not null check(min_consecutive_windows > 0), max_age_minutes integer not null check(max_age_minutes > 0),
  observation_minutes integer not null check(observation_minutes > 0), delivery_identity jsonb,
  created_at timestamptz not null default now(), unique(incident_id,version)
);

create table if not exists typed_measurements (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, criterion_id uuid not null references recovery_criteria(id) on delete cascade,
  value double precision, unit text not null, source text not null, query text not null,
  window_started_at timestamptz not null, window_ended_at timestamptz not null, observed_at timestamptz not null,
  state text not null check(state in ('valid','missing','invalid')), note text not null default '', created_at timestamptz not null default now()
);

create table if not exists incident_resolutions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade, actor text not null, reason text not null,
  recovery_evaluation jsonb not null, evidence_revision timestamptz not null, resolved_at timestamptz not null default now()
);

create index if not exists investigation_checks_incident_idx on investigation_checks(incident_id,updated_at desc);
create index if not exists validation_artifacts_incident_idx on validation_artifacts(incident_id,created_at desc);
create index if not exists typed_measurements_incident_idx on typed_measurements(incident_id,observed_at desc);

alter table investigation_checks enable row level security;
alter table evidence_review_cursors enable row level security;
alter table change_proposals enable row level security;
alter table validation_artifacts enable row level security;
alter table proposal_reviews enable row level security;
alter table recovery_criteria enable row level security;
alter table typed_measurements enable row level security;
alter table incident_resolutions enable row level security;
