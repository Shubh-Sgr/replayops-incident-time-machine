-- Real-user readiness: durable ingestion, service context, governance, and approval controls.
alter table organization_members add column if not exists email text;
alter table organization_members add column if not exists display_name text;

update organization_members m
set email = coalesce(m.email, u.email),
    display_name = coalesce(m.display_name, nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(u.email, ''), '@', 1))
from auth.users u
where u.id = m.user_id and (m.email is null or m.display_name is null);

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

create index if not exists service_catalog_org_idx on service_catalog(organization_id,name);
create index if not exists workspace_audit_org_idx on workspace_audit_log(organization_id,created_at desc);
create index if not exists mitigation_incident_idx on mitigation_requests(incident_id,created_at desc);
create index if not exists ingestion_queue_ready_idx on ingestion_queue(status,next_attempt_at);

alter table service_catalog enable row level security;
alter table incident_policies enable row level security;
alter table organization_invitations enable row level security;
alter table workspace_audit_log enable row level security;
alter table mitigation_requests enable row level security;
alter table ingestion_queue enable row level security;
