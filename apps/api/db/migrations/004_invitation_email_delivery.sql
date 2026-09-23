alter table organization_invitations
  add column if not exists email_delivery_status text not null default 'manual',
  add column if not exists emailed_at timestamptz,
  add column if not exists email_last_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organization_invitations_email_delivery_status_check'
  ) then
    alter table organization_invitations
      add constraint organization_invitations_email_delivery_status_check
      check (email_delivery_status in ('sent', 'manual', 'failed'));
  end if;
end $$;
