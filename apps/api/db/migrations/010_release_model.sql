-- The release model. Incidents are explained by what is running in an environment and what changed in
-- it, not by how close in time a commit happened. See src/release.ts.

-- Environments (with aliases and tiers) and which branches can open delivery incidents.
alter table public.incident_policies add column if not exists environments jsonb;
alter table public.incident_policies add column if not exists release_branches text[] not null default '{main,master,release/*,hotfix/*}';

-- Repositories and monorepo paths that belong to each service.
alter table public.service_catalog add column if not exists repositories text[] not null default '{}';
alter table public.service_catalog add column if not exists paths text[] not null default '{}';

-- Every change to a running system: deploys and rollbacks with their commit ranges, feature flags, config,
-- migrations, infrastructure. Changes are linked to incidents by relevance, never grouped by time.
create table if not exists public.change_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  service text not null,
  environment text not null,
  kind text not null check (kind in ('deploy','rollback','feature_flag','config','migration','infra')),
  status text not null default 'success' check (status in ('success','failure','in_progress')),
  title text not null,
  version text, previous_version text, sha text, previous_sha text,
  repository text, author text, url text,
  occurred_at timestamptz not null,
  commits jsonb not null default '[]',
  files text[] not null default '{}',
  source text not null,
  external_id text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, external_id)
);
create index if not exists change_events_lookup_idx on public.change_events(organization_id, service, environment, occurred_at desc);
alter table public.change_events enable row level security;

-- Commits seen on pushes (with their changed files), so a deploy's commit range can be shown without
-- calling the GitHub API.
create table if not exists public.repository_commits (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  repository text not null,
  sha text not null,
  branch text,
  message text not null,
  author text,
  url text,
  files text[] not null default '{}',
  committed_at timestamptz,
  push_before text,
  push_after text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (organization_id, repository, sha)
);
create index if not exists repository_commits_push_idx on public.repository_commits(organization_id, repository, push_after);
alter table public.repository_commits enable row level security;
