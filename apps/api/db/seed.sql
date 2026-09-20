-- Existing accounts are normally seeded by the auth trigger in schema.sql.
-- This idempotent block backfills the first account if it predates that trigger.
do $$
declare
  target_user_id uuid;
  target_organization_id uuid;
  target_email text;
begin
  select id, email into target_user_id, target_email
  from auth.users
  order by created_at
  limit 1;

  if target_user_id is null then
    raise notice 'No auth user exists yet. Create an account and the provisioning trigger will seed its workspace automatically.';
    return;
  end if;

  select organization_id into target_organization_id
  from public.organization_members
  where user_id = target_user_id
  order by created_at
  limit 1;

  if target_organization_id is null then
    target_organization_id := gen_random_uuid();

    insert into public.organizations (id, name, slug)
    values (
      target_organization_id,
      coalesce(nullif(split_part(target_email, '@', 1), ''), 'ReplayOps operator') || ' workspace',
      'workspace-' || target_user_id::text
    )
    on conflict (slug) do update set name = excluded.name
    returning id into target_organization_id;

    insert into public.organization_members (organization_id, user_id, role)
    values (target_organization_id, target_user_id, 'admin')
    on conflict (organization_id, user_id) do nothing;
  end if;

  perform public.seed_replayops_workspace(target_organization_id);
end;
$$;
