-- Workspace API tokens for scripts, CI, and the CLI. A token is its own principal, pinned to one
-- workspace with a capped role (viewer or responder), so it never follows its creator's workspace
-- switches and never has admin rights. Only a SHA-256 hash of the secret is stored.
create table if not exists replayops_internal.api_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  role text not null check (role in ('viewer', 'responder')),
  token_hash text not null unique,
  prefix text not null,
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_tokens_org_idx on replayops_internal.api_tokens(organization_id, created_at desc);

-- Request scoping now covers both people (their active workspace) and live API tokens.
drop view if exists replayops_internal.active_memberships;
create view replayops_internal.active_memberships as
select m.organization_id, m.user_id, m.role, m.email, m.display_name, m.created_at
from public.organization_members m
where m.organization_id = coalesce(
  (select a.organization_id
     from replayops_internal.active_workspaces a
     join public.organization_members x on x.user_id = a.user_id and x.organization_id = a.organization_id
    where a.user_id = m.user_id),
  (select x.organization_id from public.organization_members x where x.user_id = m.user_id order by x.created_at desc, x.organization_id limit 1)
)
union all
select t.organization_id, t.id as user_id, t.role, null::text as email, t.name as display_name, t.created_at
from replayops_internal.api_tokens t
where t.revoked_at is null and (t.expires_at is null or t.expires_at > now());
