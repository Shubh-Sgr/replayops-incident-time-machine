-- Reset one workspace's activity so a trial can start from scratch.
--
-- Deletes: incidents (and everything attached to them), the activity feed, received signals and deliveries, the change log
-- and stored commits, health and volume samples, read state, and the audit log.
-- Keeps: the workspace, members, connected sources (URLs, tokens, GitHub secret), service map, intake
-- policy, alert destinations, and API tokens, so nothing has to be set up again.
--
-- Run in the Supabase SQL editor. Set the admin's email on the marked line. It resets the workspace that
-- admin has open in the app (or their only one), refuses if that is unclear, and runs in one transaction: all or nothing.

begin;

create temporary table reset_target on commit drop as
select m.organization_id as id
from organization_members m
join auth.users u on u.id = m.user_id
where lower(u.email) = lower('you@example.com')   -- ← the admin's sign-in email
  and m.role = 'admin'
  -- With several workspaces, the one currently open in the app.
  and ((select count(*) from organization_members x where x.user_id = u.id and x.role = 'admin') = 1
    or m.organization_id = (select a.organization_id from replayops_internal.active_workspaces a where a.user_id = u.id));

do $$
begin
  if (select count(*) from reset_target) <> 1 then
    raise exception 'Could not tell which workspace to reset (% matched). Check the email, and open the workspace to reset in the app first.', (select count(*) from reset_target);
  end if;
end $$;

delete from ingestion_queue where integration_id in (select id from integrations where organization_id = (select id from reset_target));
delete from ingestion_signals where integration_id in (select id from integrations where organization_id = (select id from reset_target));
delete from ingestion_deliveries where integration_id in (select id from integrations where organization_id = (select id from reset_target));
delete from incidents where organization_id = (select id from reset_target);
delete from incident_activities where organization_id = (select id from reset_target);  -- workspace-level feed entries
delete from change_events where organization_id = (select id from reset_target);
delete from repository_commits where organization_id = (select id from reset_target);
delete from event_volume_samples where organization_id = (select id from reset_target);
delete from service_health_snapshots where organization_id = (select id from reset_target);
delete from notification_states where organization_id = (select id from reset_target);
delete from workspace_audit_log where organization_id = (select id from reset_target);

update integrations
set accepted_today = 0, dropped_today = 0, counter_date = current_date, last_delivery_at = null, last_delivery_status = null
where organization_id = (select id from reset_target);
update alert_channels set last_status = null, last_error = null, last_sent_at = null
where organization_id = (select id from reset_target);

-- What is left, for a quick check: every count should be 0.
select
  (select count(*) from incidents where organization_id = (select id from reset_target)) as incidents,
  (select count(*) from change_events where organization_id = (select id from reset_target)) as changes,
  (select count(*) from repository_commits where organization_id = (select id from reset_target)) as commits,
  (select count(*) from ingestion_signals s join integrations i on i.id = s.integration_id where i.organization_id = (select id from reset_target)) as signals;

commit;
