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
  role text not null check (role in ('admin', 'responder', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  code text not null unique,
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
  updated_at timestamptz not null default now()
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

create index if not exists incidents_started_at_idx on incidents(started_at desc);
create index if not exists incidents_status_idx on incidents(status);
create index if not exists incident_events_incident_time_idx on incident_events(incident_id, timestamp);
create index if not exists incidents_embedding_idx on incidents using hnsw (embedding vector_cosine_ops);

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table incidents enable row level security;
alter table incident_events enable row level security;

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

  insert into public.organization_members (organization_id, user_id, role)
  values (workspace_id, new.id, 'admin');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.provision_replayops_workspace();

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
