-- A user can belong to several workspaces. Every request is scoped to one "active" workspace:
-- the one the user last switched to, or their newest membership. Request scoping reads
-- replayops_internal.active_memberships instead of organization_members, so data from two
-- workspaces is never mixed.
-- The schema is private: Supabase's public Data API must not expose membership rows.
create schema if not exists replayops_internal;
revoke all on schema replayops_internal from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema replayops_internal from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema replayops_internal from authenticated'; end if;
end $$;

create table if not exists replayops_internal.active_workspaces (
  user_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  updated_at timestamptz not null default now()
);

create or replace view replayops_internal.active_memberships as
select m.*
from public.organization_members m
where m.organization_id = coalesce(
  (select a.organization_id
     from replayops_internal.active_workspaces a
     join public.organization_members x on x.user_id = a.user_id and x.organization_id = a.organization_id
    where a.user_id = m.user_id),
  (select x.organization_id from public.organization_members x where x.user_id = m.user_id order by x.created_at desc, x.organization_id limit 1)
);
