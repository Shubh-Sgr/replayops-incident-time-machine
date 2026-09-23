alter table replay_runs add column if not exists config jsonb;
alter table replay_runs add column if not exists projection jsonb;
alter table replay_runs add column if not exists evidence_version timestamptz;
alter table replay_runs add column if not exists event_count integer;

alter table mitigation_requests add column if not exists replay_run_id uuid references replay_runs(id) on delete restrict;
alter table mitigation_requests add column if not exists replay_config jsonb;
alter table mitigation_requests add column if not exists replay_projection jsonb;
alter table mitigation_requests add column if not exists evidence_version timestamptz;

create table if not exists hypothesis_tests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  hypothesis_id text not null,
  title text not null,
  instruction text not null,
  assignee text not null,
  status text not null default 'planned' check(status in ('planned','running','supported','disproved','inconclusive')),
  result text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists recovery_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  metric text not null,
  target_value numeric not null,
  baseline_value numeric not null,
  observed_value numeric,
  observation_minutes integer not null check(observation_minutes between 1 and 10080),
  status text not null default 'pending' check(status in ('pending','verified','failed')),
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists incident_postmortems (
  incident_id uuid primary key references incidents(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  summary text not null default '',
  root_cause text not null default '',
  impact text not null default '',
  recovery text not null default '',
  follow_ups text not null default '',
  status text not null default 'draft' check(status in ('draft','published')),
  updated_at timestamptz not null default now()
);

create index if not exists replay_runs_incident_idx on replay_runs(incident_id,created_at desc);
create index if not exists hypothesis_tests_incident_idx on hypothesis_tests(incident_id,created_at desc);
create index if not exists recovery_verifications_incident_idx on recovery_verifications(incident_id,created_at desc);

alter table hypothesis_tests enable row level security;
alter table recovery_verifications enable row level security;
alter table incident_postmortems enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='members can read hypothesis tests') then
    create policy "members can read hypothesis tests" on hypothesis_tests for select using (exists (select 1 from organization_members m where m.organization_id=hypothesis_tests.organization_id and m.user_id=auth.uid()));
    create policy "responders can manage hypothesis tests" on hypothesis_tests for all using (exists (select 1 from organization_members m where m.organization_id=hypothesis_tests.organization_id and m.user_id=auth.uid() and m.role in ('admin','responder'))) with check (exists (select 1 from organization_members m where m.organization_id=hypothesis_tests.organization_id and m.user_id=auth.uid() and m.role in ('admin','responder')));
    create policy "members can read recovery verifications" on recovery_verifications for select using (exists (select 1 from organization_members m where m.organization_id=recovery_verifications.organization_id and m.user_id=auth.uid()));
    create policy "responders can manage recovery verifications" on recovery_verifications for all using (exists (select 1 from organization_members m where m.organization_id=recovery_verifications.organization_id and m.user_id=auth.uid() and m.role in ('admin','responder'))) with check (exists (select 1 from organization_members m where m.organization_id=recovery_verifications.organization_id and m.user_id=auth.uid() and m.role in ('admin','responder')));
    create policy "members can read incident postmortems" on incident_postmortems for select using (exists (select 1 from organization_members m where m.organization_id=incident_postmortems.organization_id and m.user_id=auth.uid()));
    create policy "responders can manage incident postmortems" on incident_postmortems for all using (exists (select 1 from organization_members m where m.organization_id=incident_postmortems.organization_id and m.user_id=auth.uid() and m.role in ('admin','responder'))) with check (exists (select 1 from organization_members m where m.organization_id=incident_postmortems.organization_id and m.user_id=auth.uid() and m.role in ('admin','responder')));
  end if;
end $$;
