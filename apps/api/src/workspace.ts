import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { sendInvitationEmail } from "./mailer.js";
import type { ActionNotification, AuditEntry, HypothesisTest, HypothesisTestStatus, IncidentComment, IncidentPolicy, IncidentPostmortem, MitigationRequest, PrivacySettings, RecoveryVerification, ReplayResult, ServiceDefinition, TeamInvitation, TeamMember, WorkspaceContext, WorkspaceRole } from "./types.js";

type Row = Record<string, unknown>;
type ServiceInput = Pick<ServiceDefinition, "name" | "ownerTeam" | "tier" | "repositoryUrl" | "runbookUrl" | "dependencies">;

const mapService = (row: Row): ServiceDefinition => ({
  id: String(row.id), name: String(row.name), ownerTeam: String(row.owner_team), tier: row.tier as ServiceDefinition["tier"],
  repositoryUrl: row.repository_url ? String(row.repository_url) : null, runbookUrl: row.runbook_url ? String(row.runbook_url) : null,
  dependencies: Array.isArray(row.dependencies) ? row.dependencies.map(String) : [], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString()
});
const mapPolicy = (row: Row): IncidentPolicy => ({
  incidentThreshold: Number(row.incident_threshold), groupingWindowMinutes: Number(row.grouping_window_minutes),
  suppressLowSeverity: Boolean(row.suppress_low_severity), maintenanceMode: Boolean(row.maintenance_mode), updatedAt: new Date(String(row.updated_at)).toISOString()
});
const mapMember = (row: Row): TeamMember => ({
  userId: String(row.user_id), email: String(row.email ?? "unknown@workspace.local"), displayName: String(row.display_name ?? String(row.email ?? "Responder").split("@")[0]),
  role: row.role as WorkspaceRole, joinedAt: new Date(String(row.created_at)).toISOString()
});
const mapInvite = (row: Row): TeamInvitation => ({
  id: String(row.id), email: String(row.email), role: row.role as WorkspaceRole, status: row.status as TeamInvitation["status"],
  emailDeliveryStatus: (row.email_delivery_status ?? "manual") as TeamInvitation["emailDeliveryStatus"],
  emailedAt: row.emailed_at ? new Date(String(row.emailed_at)).toISOString() : null,
  emailLastError: row.email_last_error ? String(row.email_last_error) : null,
  expiresAt: new Date(String(row.expires_at)).toISOString(), createdAt: new Date(String(row.created_at)).toISOString()
});
const mapAudit = (row: Row): AuditEntry => ({
  id: String(row.id), actor: String(row.actor), action: String(row.action), targetType: String(row.target_type),
  targetId: row.target_id ? String(row.target_id) : null, detail: (row.detail ?? {}) as Record<string, unknown>, createdAt: new Date(String(row.created_at)).toISOString()
});
const mapMitigation = (row: Row): MitigationRequest => ({
  id: String(row.id), incidentId: String(row.incident_id), requestedBy: String(row.requested_by), reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
  title: String(row.title), action: String(row.action), rollbackPlan: String(row.rollback_plan), status: row.status as MitigationRequest["status"],
  currentValue:String(row.current_value??"Not recorded"),proposedValue:String(row.proposed_value??"Not recorded"),blastRadius:String(row.blast_radius??"Not recorded"),changeOwner:String(row.change_owner??row.requested_by),observationMinutes:Number(row.observation_minutes??15),
  replayRunId: row.replay_run_id ? String(row.replay_run_id) : "", replayConfig: (row.replay_config ?? { retryCeiling: 0, concurrencyCap: 0, timeoutMs: 0 }) as MitigationRequest["replayConfig"], replayProjection: (row.replay_projection ?? { baselinePeak: 0, projectedPeak: 0, avoidedHighImpactEvents: 0, recoveryGainMinutes: 0, confidence: 0, state: "critical", summary: "Legacy approval created before replay binding was enabled.", signals: [] }) as MitigationRequest["replayProjection"],
  evidenceVersion: new Date(String(row.evidence_version ?? row.created_at)).toISOString(), stale: !row.replay_run_id || (row.incident_evidence_revision ? new Date(String(row.incident_evidence_revision)).toISOString() !== new Date(String(row.evidence_version ?? row.created_at)).toISOString() : false),
  createdAt: new Date(String(row.created_at)).toISOString(), reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : null
});
const mapHypothesisTest = (row: Row): HypothesisTest => ({
  id: String(row.id), incidentId: String(row.incident_id), hypothesisId: String(row.hypothesis_id), title: String(row.title), instruction: String(row.instruction), assignee: String(row.assignee), status: row.status as HypothesisTestStatus, result: String(row.result ?? ""), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(), completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null
});
const mapRecovery = (row: Row): RecoveryVerification => ({
  id: String(row.id), incidentId: String(row.incident_id), metric: String(row.metric), targetValue: Number(row.target_value), baselineValue: Number(row.baseline_value), observedValue: row.observed_value === null || row.observed_value === undefined ? null : Number(row.observed_value), observationMinutes: Number(row.observation_minutes), status: row.status as RecoveryVerification["status"], reason: String(row.reason ?? ""), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString()
  , unit: String(row.unit ?? "value"), comparison: (row.comparison ?? "lte") as RecoveryVerification["comparison"],
  source: String(row.source ?? "Legacy observation"), query: String(row.query ?? "Unavailable for legacy observation"),
  windowStartedAt: row.window_started_at ? new Date(String(row.window_started_at)).toISOString() : new Date(String(row.created_at)).toISOString(),
  windowEndedAt: row.window_ended_at ? new Date(String(row.window_ended_at)).toISOString() : new Date(String(row.created_at)).toISOString(),
  observedAt: row.observed_at ? new Date(String(row.observed_at)).toISOString() : new Date(String(row.created_at)).toISOString(),
  freshnessMinutes: Number(row.freshness_minutes ?? 0)
});
const mapPostmortem = (row: Row): IncidentPostmortem => ({
  incidentId: String(row.incident_id), summary: String(row.summary), rootCause: String(row.root_cause), impact: String(row.impact), recovery: String(row.recovery), followUps: String(row.follow_ups), status: row.status as IncidentPostmortem["status"], updatedAt: new Date(String(row.updated_at)).toISOString()
});
const mapPrivacy=(row:Row):PrivacySettings=>({externalAiEnabled:Boolean(row.external_ai_enabled),captureRequestBodies:Boolean(row.capture_request_bodies),productAnalyticsEnabled:Boolean(row.product_analytics_enabled),updatedAt:new Date(String(row.updated_at)).toISOString()});

class WorkspaceService {
  private pool?: Pool;
  private memoryServices: ServiceDefinition[] = [
    { id: "svc-checkout", name: "checkout-api", ownerTeam: "Commerce", tier: "critical", repositoryUrl: "https://github.com/example/checkout", runbookUrl: null, dependencies: ["inventory-api", "payments-api"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: "svc-inventory", name: "inventory-api", ownerTeam: "Commerce", tier: "critical", repositoryUrl: null, runbookUrl: null, dependencies: ["catalog-db"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ];
  private memoryPolicy: IncidentPolicy = { incidentThreshold: 65, groupingWindowMinutes: 120, suppressLowSeverity: true, maintenanceMode: false, updatedAt: new Date().toISOString() };
  private memoryMembers: TeamMember[] = [{ userId: "00000000-0000-4000-8000-000000000001", email: "operator@replayops.dev", displayName: "Maya Chen", role: "admin", joinedAt: new Date().toISOString() }];
  private memoryInvites: TeamInvitation[] = [];
  private memoryAudit: AuditEntry[] = [];
  private memoryMitigations: MitigationRequest[] = [];
  private memoryHypothesisTests: HypothesisTest[] = [];
  private memoryRecoveries: RecoveryVerification[] = [];
  private memoryPostmortems: IncidentPostmortem[] = [];
  private memoryNotificationStates = new Map<string,{read:boolean;resolved:boolean}>();
  private memoryPrivacy:PrivacySettings={externalAiEnabled:true,captureRequestBodies:false,productAnalyticsEnabled:true,updatedAt:new Date().toISOString()};
  private memoryComments:IncidentComment[]=[];

  constructor() {
    if (config.databaseUrl) this.pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }, max: 3 });
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`
      alter table organization_members add column if not exists email text;
      alter table organization_members add column if not exists display_name text;
      update organization_members m
      set email=coalesce(m.email,u.email), display_name=coalesce(m.display_name,nullif(u.raw_user_meta_data->>'full_name',''),split_part(coalesce(u.email,''),'@',1))
      from auth.users u where u.id=m.user_id and (m.email is null or m.display_name is null);
      create table if not exists service_catalog (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        name text not null, owner_team text not null, tier text not null check (tier in ('critical','standard','internal')),
        repository_url text, runbook_url text, dependencies text[] not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id,name)
      );
      create table if not exists incident_policies (
        organization_id uuid primary key references organizations(id) on delete cascade, incident_threshold integer not null default 65 check (incident_threshold between 1 and 100),
        grouping_window_minutes integer not null default 120 check (grouping_window_minutes between 5 and 1440), suppress_low_severity boolean not null default true,
        maintenance_mode boolean not null default false, updated_at timestamptz not null default now()
      );
      create table if not exists organization_invitations (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, email text not null,
        role text not null check (role in ('admin','responder','viewer')), token_hash text not null unique, status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
        email_delivery_status text not null default 'manual' check (email_delivery_status in ('sent','manual','failed')),
        emailed_at timestamptz, email_last_error text, expires_at timestamptz not null, created_by uuid, created_at timestamptz not null default now()
      );
      alter table organization_invitations add column if not exists email_delivery_status text not null default 'manual';
      alter table organization_invitations add column if not exists emailed_at timestamptz;
      alter table organization_invitations add column if not exists email_last_error text;
      do $$ begin
        if not exists (select 1 from pg_constraint where conname='organization_invitations_email_delivery_status_check') then
          alter table organization_invitations add constraint organization_invitations_email_delivery_status_check check (email_delivery_status in ('sent','manual','failed'));
        end if;
      end $$;
      create table if not exists workspace_audit_log (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        actor text not null, action text not null, target_type text not null, target_id text, detail jsonb not null default '{}', created_at timestamptz not null default now()
      );
      create table if not exists mitigation_requests (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, incident_id uuid not null references incidents(id) on delete cascade,
        requested_by text not null, reviewed_by text, title text not null, action text not null, rollback_plan text not null,
        status text not null default 'pending' check (status in ('pending','approved','rejected','executed')), created_at timestamptz not null default now(), reviewed_at timestamptz
      );
      alter table mitigation_requests add column if not exists replay_run_id uuid references replay_runs(id) on delete restrict;
      alter table mitigation_requests add column if not exists replay_config jsonb;
      alter table mitigation_requests add column if not exists replay_projection jsonb;
      alter table mitigation_requests add column if not exists evidence_version timestamptz;
      alter table mitigation_requests add column if not exists current_value text not null default 'Not recorded';
      alter table mitigation_requests add column if not exists proposed_value text not null default 'Not recorded';
      alter table mitigation_requests add column if not exists blast_radius text not null default 'Not recorded';
      alter table mitigation_requests add column if not exists change_owner text not null default 'Unassigned';
      alter table mitigation_requests add column if not exists observation_minutes integer not null default 15;
      create table if not exists hypothesis_tests (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, incident_id uuid not null references incidents(id) on delete cascade,
        hypothesis_id text not null, title text not null, instruction text not null, assignee text not null, status text not null default 'planned' check(status in ('planned','running','supported','disproved','inconclusive')),
        result text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz
      );
      create table if not exists recovery_verifications (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, incident_id uuid not null references incidents(id) on delete cascade,
        metric text not null, target_value numeric not null, baseline_value numeric not null, observed_value numeric, observation_minutes integer not null check(observation_minutes between 1 and 10080),
        status text not null default 'pending' check(status in ('pending','verified','failed')), reason text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      alter table recovery_verifications add column if not exists unit text not null default 'value';
      alter table recovery_verifications add column if not exists comparison text not null default 'lte';
      alter table recovery_verifications add column if not exists source text not null default 'Legacy observation';
      alter table recovery_verifications add column if not exists query text not null default 'Unavailable for legacy observation';
      alter table recovery_verifications add column if not exists window_started_at timestamptz;
      alter table recovery_verifications add column if not exists window_ended_at timestamptz;
      alter table recovery_verifications add column if not exists observed_at timestamptz;
      alter table recovery_verifications add column if not exists freshness_minutes integer not null default 0;
      create table if not exists incident_postmortems (
        incident_id uuid primary key references incidents(id) on delete cascade, organization_id uuid not null references organizations(id) on delete cascade,
        summary text not null default '', root_cause text not null default '', impact text not null default '', recovery text not null default '', follow_ups text not null default '',
        status text not null default 'draft' check(status in ('draft','published')), updated_at timestamptz not null default now()
      );
      create table if not exists notification_states (
        organization_id uuid not null references organizations(id) on delete cascade,user_id uuid not null references auth.users(id) on delete cascade,
        notification_id text not null,read_at timestamptz,resolved_at timestamptz,updated_at timestamptz not null default now(),primary key(user_id,notification_id)
      );
      create table if not exists workspace_privacy_settings (
        organization_id uuid primary key references organizations(id) on delete cascade,external_ai_enabled boolean not null default true,
        capture_request_bodies boolean not null default false,product_analytics_enabled boolean not null default true,updated_at timestamptz not null default now()
      );
      create table if not exists incident_comments(id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id) on delete cascade,incident_id uuid not null references incidents(id) on delete cascade,actor text not null,body text not null,event_id uuid,created_at timestamptz not null default now());
      create index if not exists service_catalog_org_idx on service_catalog(organization_id,name);
      create index if not exists workspace_audit_org_idx on workspace_audit_log(organization_id,created_at desc);
      create index if not exists mitigation_incident_idx on mitigation_requests(incident_id,created_at desc);
      alter table service_catalog enable row level security;
      alter table incident_policies enable row level security;
      alter table organization_invitations enable row level security;
      alter table workspace_audit_log enable row level security;
      alter table mitigation_requests enable row level security;
      alter table hypothesis_tests enable row level security;
      alter table recovery_verifications enable row level security;
      alter table incident_postmortems enable row level security;
      alter table notification_states enable row level security;
      alter table workspace_privacy_settings enable row level security;
      alter table incident_comments enable row level security;
    `);
  }

  async context(userId: string): Promise<WorkspaceContext> {
    if (!this.pool) return { organizationId: "demo-organization", organizationName: "ReplayOps demonstration", role: "admin" };
    const result = await this.pool.query(`select m.organization_id,m.role,o.name from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 order by m.created_at desc limit 1`, [userId]);
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new Error("No workspace membership exists for this account.");
    return { organizationId: String(row.organization_id), organizationName: String(row.name), role: row.role as WorkspaceRole };
  }

  async assertRole(userId: string, roles: WorkspaceRole[]) {
    const context = await this.context(userId);
    if (!roles.includes(context.role)) throw new Error("Your workspace role does not allow this action.");
    return context;
  }

  async getPrivacy(userId:string){const context=await this.context(userId);if(!this.pool)return structuredClone(this.memoryPrivacy);const result=await this.pool.query(`insert into workspace_privacy_settings(organization_id) values($1) on conflict(organization_id) do update set organization_id=excluded.organization_id returning *`,[context.organizationId]);return mapPrivacy(result.rows[0] as Row);}
  async updatePrivacy(userId:string,actor:string,input:Omit<PrivacySettings,"updatedAt">){const context=await this.assertRole(userId,["admin"]);if(!this.pool){this.memoryPrivacy={...input,updatedAt:new Date().toISOString()};await this.audit(userId,actor,"updated privacy settings","workspace",context.organizationId,input);return this.memoryPrivacy;}const result=await this.pool.query(`insert into workspace_privacy_settings(organization_id,external_ai_enabled,capture_request_bodies,product_analytics_enabled) values($1,$2,$3,$4) on conflict(organization_id) do update set external_ai_enabled=excluded.external_ai_enabled,capture_request_bodies=excluded.capture_request_bodies,product_analytics_enabled=excluded.product_analytics_enabled,updated_at=now() returning *`,[context.organizationId,input.externalAiEnabled,input.captureRequestBodies,input.productAnalyticsEnabled]);await this.audit(userId,actor,"updated privacy settings","workspace",context.organizationId,input);return mapPrivacy(result.rows[0] as Row);}

  async recordProductOutcome(userId:string,actor:string,event:string,detail:Record<string,unknown>){const privacy=await this.getPrivacy(userId);if(!privacy.productAnalyticsEnabled)return{recorded:false};await this.audit(userId,actor,`[product-outcome] ${event}`,"product-outcome",undefined,detail);return{recorded:true};}
  async listProductOutcomes(userId:string){return (await this.listAudit(userId)).filter((item)=>item.action.startsWith("[product-outcome]"));}

  async audit(userId: string, actor: string, action: string, targetType: string, targetId?: string, detail: Record<string, unknown> = {}) {
    const context = await this.context(userId);
    if (!this.pool) {
      this.memoryAudit.unshift({ id: randomUUID(), actor, action, targetType, targetId: targetId ?? null, detail, createdAt: new Date().toISOString() });
      return;
    }
    await this.pool.query(`insert into workspace_audit_log(organization_id,actor,action,target_type,target_id,detail) values($1,$2,$3,$4,$5,$6)`, [context.organizationId, actor, action, targetType, targetId ?? null, detail]);
  }

  async listServices(userId: string) {
    const context = await this.context(userId);
    if (!this.pool) return structuredClone(this.memoryServices);
    return (await this.pool.query(`select * from service_catalog where organization_id=$1 order by case tier when 'critical' then 1 when 'standard' then 2 else 3 end,name`, [context.organizationId])).rows.map(mapService);
  }

  async relatedServicesForOrganization(organizationId: string, serviceName: string): Promise<string[]> {
    if (!this.pool) {
      const related = new Set([serviceName]);
      for (const service of this.memoryServices) {
        if (service.name === serviceName) service.dependencies.forEach((dependency) => related.add(dependency));
        if (service.dependencies.includes(serviceName)) related.add(service.name);
      }
      return [...related];
    }
    const result = await this.pool.query(
      `select distinct related_name from (
         select unnest(dependencies) as related_name from service_catalog where organization_id=$1 and name=$2
         union
         select name as related_name from service_catalog where organization_id=$1 and $2=any(dependencies)
       ) related where related_name is not null`,
      [organizationId, serviceName]
    );
    return [serviceName, ...result.rows.map((row) => String((row as Row).related_name)).filter((name) => name !== serviceName)];
  }

  async upsertService(userId: string, actor: string, input: ServiceInput) {
    const context = await this.assertRole(userId, ["admin", "responder"]);
    if (!this.pool) {
      const existing = this.memoryServices.find((service) => service.name === input.name);
      const value: ServiceDefinition = existing ? { ...existing, ...input, updatedAt: new Date().toISOString() } : { ...input, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.memoryServices = existing ? this.memoryServices.map((service) => service.id === existing.id ? value : service) : [value, ...this.memoryServices];
      await this.audit(userId, actor, existing ? "updated service" : "created service", "service", value.id, { name: value.name });
      return value;
    }
    const result = await this.pool.query(`insert into service_catalog(organization_id,name,owner_team,tier,repository_url,runbook_url,dependencies) values($1,$2,$3,$4,$5,$6,$7) on conflict(organization_id,name) do update set owner_team=excluded.owner_team,tier=excluded.tier,repository_url=excluded.repository_url,runbook_url=excluded.runbook_url,dependencies=excluded.dependencies,updated_at=now() returning *`, [context.organizationId, input.name, input.ownerTeam, input.tier, input.repositoryUrl ?? null, input.runbookUrl ?? null, input.dependencies]);
    const value = mapService(result.rows[0] as Row);
    await this.audit(userId, actor, "upserted service", "service", value.id, { name: value.name, tier: value.tier });
    return value;
  }

  async policyForOrganization(organizationId: string): Promise<IncidentPolicy> {
    if (!this.pool) return this.memoryPolicy;
    const result = await this.pool.query(`insert into incident_policies(organization_id) values($1) on conflict(organization_id) do update set organization_id=excluded.organization_id returning *`, [organizationId]);
    return mapPolicy(result.rows[0] as Row);
  }

  async getPolicy(userId: string) { return this.policyForOrganization((await this.context(userId)).organizationId); }

  async updatePolicy(userId: string, actor: string, input: Omit<IncidentPolicy, "updatedAt">) {
    const context = await this.assertRole(userId, ["admin"]);
    if (!this.pool) { this.memoryPolicy = { ...input, updatedAt: new Date().toISOString() }; await this.audit(userId, actor, "updated intake policy", "policy", undefined, input); return this.memoryPolicy; }
    const result = await this.pool.query(`insert into incident_policies(organization_id,incident_threshold,grouping_window_minutes,suppress_low_severity,maintenance_mode,updated_at) values($1,$2,$3,$4,$5,now()) on conflict(organization_id) do update set incident_threshold=excluded.incident_threshold,grouping_window_minutes=excluded.grouping_window_minutes,suppress_low_severity=excluded.suppress_low_severity,maintenance_mode=excluded.maintenance_mode,updated_at=now() returning *`, [context.organizationId, input.incidentThreshold, input.groupingWindowMinutes, input.suppressLowSeverity, input.maintenanceMode]);
    await this.audit(userId, actor, "updated intake policy", "policy", undefined, input);
    return mapPolicy(result.rows[0] as Row);
  }

  async listMembers(userId: string) {
    const context = await this.context(userId);
    if (!this.pool) return structuredClone(this.memoryMembers);
    return (await this.pool.query(`select m.*,coalesce(m.email,u.email) as email,coalesce(m.display_name,nullif(u.raw_user_meta_data->>'full_name',''),split_part(coalesce(u.email,''),'@',1)) as display_name from organization_members m left join auth.users u on u.id=m.user_id where m.organization_id=$1 order by m.created_at`, [context.organizationId])).rows.map(mapMember);
  }

  async updateMemberRole(userId: string, actor: string, memberId: string, role: WorkspaceRole) {
    const context = await this.assertRole(userId, ["admin"]);
    if (memberId === userId) throw new Error("Ask another administrator to change your own role.");
    if (!this.pool) { const member = this.memoryMembers.find((item) => item.userId === memberId); if (!member) throw new Error("Team member not found."); member.role = role; await this.audit(userId, actor, "changed member role", "member", memberId, { role }); return member; }
    const result = await this.pool.query(`update organization_members set role=$3 where organization_id=$1 and user_id=$2 returning *`, [context.organizationId, memberId, role]);
    if (!result.rows[0]) throw new Error("Team member not found.");
    await this.audit(userId, actor, "changed member role", "member", memberId, { role });
    return mapMember(result.rows[0] as Row);
  }

  async listInvitations(userId: string) {
    const context = await this.assertRole(userId, ["admin"]);
    if (!this.pool) return structuredClone(this.memoryInvites);
    return (await this.pool.query(`select *,case when status='pending' and expires_at<now() then 'expired' else status end as status from organization_invitations where organization_id=$1 order by created_at desc`, [context.organizationId])).rows.map(mapInvite);
  }

  async createInvitation(userId: string, actor: string, email: string, role: WorkspaceRole) {
    const context = await this.assertRole(userId, ["admin"]);
    const token = randomBytes(24).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    let invite: TeamInvitation;
    if (!this.pool) {
      invite = { id: randomUUID(), email, role, status: "pending", emailDeliveryStatus: "manual", emailedAt: null, emailLastError: null, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), createdAt: new Date().toISOString(), inviteToken: token };
      this.memoryInvites.unshift(invite);
    } else {
      const result = await this.pool.query(`insert into organization_invitations(organization_id,email,role,token_hash,expires_at,created_by) values($1,$2,$3,$4,now()+interval '7 days',$5) returning *`, [context.organizationId, email.toLowerCase(), role, tokenHash, userId]);
      invite = { ...mapInvite(result.rows[0] as Row), inviteToken: token };
    }
    const baseWebUrl = config.publicWebUrl ?? config.webOrigin.split(",")[0]?.trim() ?? "http://localhost:5173";
    const delivery = await sendInvitationEmail({ invitationId: invite.id, to: invite.email, role, organizationName: context.organizationName, invitedBy: actor, inviteUrl: `${baseWebUrl}/accept-invite?token=${encodeURIComponent(token)}` });
    invite.emailDeliveryStatus = delivery.status;
    invite.emailedAt = delivery.status === "sent" ? new Date().toISOString() : null;
    invite.emailLastError = delivery.error ?? null;
    if (this.pool) {
      await this.pool.query(`update organization_invitations set email_delivery_status=$2,emailed_at=case when $2='sent' then now() else null end,email_last_error=$3 where id=$1`, [invite.id, delivery.status, delivery.error ?? null]);
    }
    await this.audit(userId, actor, "created invitation", "invitation", invite.id, { email, role, emailDeliveryStatus: delivery.status, providerMessageId: delivery.providerMessageId });
    return invite;
  }

  async acceptInvitation(userId: string, email: string, token: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (!this.pool) {
      const invite = this.memoryInvites.find((item) => item.inviteToken === token && item.email.toLowerCase() === email.toLowerCase() && item.status === "pending");
      if (!invite || new Date(invite.expiresAt) < new Date()) throw new Error("This invitation is invalid, expired, or belongs to another email address.");
      invite.status = "accepted";
      this.memoryMembers.push({ userId, email, displayName: email.split("@")[0] ?? "Responder", role: invite.role, joinedAt: new Date().toISOString() });
      return { organizationName: "ReplayOps demonstration", role: invite.role };
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(`select i.*,o.name as organization_name from organization_invitations i join organizations o on o.id=i.organization_id where i.token_hash=$1 and lower(i.email)=lower($2) and i.status='pending' and i.expires_at>now() for update`, [tokenHash, email]);
      const row = found.rows[0] as Row | undefined;
      if (!row) throw new Error("This invitation is invalid, expired, or belongs to another email address.");
      await client.query(`insert into organization_members(organization_id,user_id,role,email,display_name) values($1,$2,$3,$4,$5) on conflict(organization_id,user_id) do update set role=excluded.role,email=excluded.email`, [row.organization_id, userId, row.role, email, email.split("@")[0] ?? "Responder"]);
      await client.query(`update organization_invitations set status='accepted' where id=$1`, [row.id]);
      await client.query(`insert into workspace_audit_log(organization_id,actor,action,target_type,target_id,detail) values($1,$2,'accepted invitation','member',$3,$4)`, [row.organization_id, email, userId, { role: row.role }]);
      await client.query("commit");
      return { organizationName: String(row.organization_name), role: row.role as WorkspaceRole };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  async listAudit(userId: string) {
    const context = await this.context(userId);
    if (!this.pool) return structuredClone(this.memoryAudit.slice(0, 100));
    return (await this.pool.query(`select * from workspace_audit_log where organization_id=$1 order by created_at desc limit 100`, [context.organizationId])).rows.map(mapAudit);
  }

  async listMitigations(userId: string, incidentId: string) {
    const context = await this.context(userId);
    if (!this.pool) return structuredClone(this.memoryMitigations.filter((item) => item.incidentId === incidentId));
    return (await this.pool.query(`select m.*,i.evidence_revision as incident_evidence_revision from mitigation_requests m join incidents i on i.id=m.incident_id where m.organization_id=$1 and m.incident_id=$2 order by m.created_at desc`, [context.organizationId, incidentId])).rows.map(mapMitigation);
  }

  async requestMitigation(userId: string, actor: string, incidentId: string, input: Pick<MitigationRequest, "title" | "action" | "rollbackPlan"|"currentValue"|"proposedValue"|"blastRadius"|"changeOwner"|"observationMinutes"> & { replay: ReplayResult }) {
    const context = await this.assertRole(userId, ["admin", "responder"]);
    let request: MitigationRequest;
    if (!this.pool) {
      request = { id: randomUUID(), incidentId, requestedBy: actor, title: input.title, action: input.action, rollbackPlan: input.rollbackPlan,currentValue:input.currentValue,proposedValue:input.proposedValue,blastRadius:input.blastRadius,changeOwner:input.changeOwner,observationMinutes:input.observationMinutes, replayRunId: input.replay.id, replayConfig: input.replay.config, replayProjection: input.replay.projection, evidenceVersion: input.replay.evidenceVersion, stale: false, status: "pending", createdAt: new Date().toISOString() };
      this.memoryMitigations.unshift(request);
    } else {
      const result = await this.pool.query(`insert into mitigation_requests(organization_id,incident_id,requested_by,title,action,rollback_plan,current_value,proposed_value,blast_radius,change_owner,observation_minutes,replay_run_id,replay_config,replay_projection,evidence_version) select $1,i.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15 from incidents i where i.id=$2 and i.organization_id=$1 returning *,null::timestamptz as incident_evidence_revision`, [context.organizationId, incidentId, actor, input.title, input.action, input.rollbackPlan,input.currentValue,input.proposedValue,input.blastRadius,input.changeOwner,input.observationMinutes, input.replay.id, input.replay.config, input.replay.projection, input.replay.evidenceVersion]);
      if (!result.rows[0]) throw new Error("Incident not found in this workspace.");
      request = mapMitigation(result.rows[0] as Row);
    }
    await this.audit(userId, actor, "requested mitigation approval", "mitigation", request.id, { incidentId, title: input.title });
    return request;
  }

  async reviewMitigation(userId: string, actor: string, requestId: string, status: "approved" | "rejected") {
    const context = await this.assertRole(userId, ["admin"]);
    let request: MitigationRequest | undefined;
    if (!this.pool) {
      request = this.memoryMitigations.find((item) => item.id === requestId);
      if (request?.requestedBy === actor) throw new Error("A mitigation requester cannot approve their own production action.");
      if (request) Object.assign(request, { status, reviewedBy: actor, reviewedAt: new Date().toISOString() });
    } else {
      const result = await this.pool.query(`update mitigation_requests m set status=$3,reviewed_by=$4,reviewed_at=now() from incidents i where m.id=$2 and m.organization_id=$1 and m.status='pending' and m.requested_by<>$4 and i.id=m.incident_id and i.evidence_revision=m.evidence_version returning m.*,i.evidence_revision as incident_evidence_revision`, [context.organizationId, requestId, status, actor]);
      request = result.rows[0] ? mapMitigation(result.rows[0] as Row) : undefined;
    }
    if (!request) throw new Error("This request is unavailable, already reviewed, or cannot be self-approved.");
    await this.audit(userId, actor, `${status} mitigation`, "mitigation", request.id, { incidentId: request.incidentId });
    return request;
  }

  async listHypothesisTests(userId: string, incidentId: string) {
    const context = await this.context(userId);
    if (!this.pool) return structuredClone(this.memoryHypothesisTests.filter((item) => item.incidentId === incidentId));
    return (await this.pool.query(`select * from hypothesis_tests where organization_id=$1 and incident_id=$2 order by created_at desc`, [context.organizationId, incidentId])).rows.map(mapHypothesisTest);
  }

  async createHypothesisTest(userId: string, actor: string, incidentId: string, input: Pick<HypothesisTest, "hypothesisId" | "title" | "instruction" | "assignee">) {
    const context = await this.assertRole(userId, ["admin", "responder"]);
    const existing = (await this.listHypothesisTests(userId, incidentId)).find((item) => item.hypothesisId === input.hypothesisId && ["planned", "running"].includes(item.status));
    if (existing) throw new Error("This explanation already has an active test. Open that test instead of creating a duplicate.");
    let value: HypothesisTest;
    if (!this.pool) {
      const now = new Date().toISOString(); value = { id: randomUUID(), incidentId, ...input, status: "planned", result: "", createdAt: now, updatedAt: now }; this.memoryHypothesisTests.unshift(value);
    } else {
      const result = await this.pool.query(`insert into hypothesis_tests(organization_id,incident_id,hypothesis_id,title,instruction,assignee) select $1,i.id,$3,$4,$5,$6 from incidents i where i.id=$2 and i.organization_id=$1 returning *`, [context.organizationId, incidentId, input.hypothesisId, input.title, input.instruction, input.assignee]);
      if (!result.rows[0]) throw new Error("Incident not found in this workspace."); value = mapHypothesisTest(result.rows[0] as Row);
    }
    await this.audit(userId, actor, "created hypothesis test", "hypothesis-test", value.id, { incidentId, hypothesisId: input.hypothesisId, assignee: input.assignee }); return value;
  }

  async updateHypothesisTest(userId: string, actor: string, id: string, input: { status: HypothesisTestStatus; result: string }) {
    const context = await this.assertRole(userId, ["admin", "responder"]); let value: HypothesisTest | undefined;
    if (!this.pool) { value = this.memoryHypothesisTests.find((item) => item.id === id); if (value) Object.assign(value, input, { updatedAt: new Date().toISOString(), completedAt: ["supported","disproved","inconclusive"].includes(input.status) ? new Date().toISOString() : null }); }
    else { const result = await this.pool.query(`update hypothesis_tests set status=$3,result=$4,updated_at=now(),completed_at=case when $3 in ('supported','disproved','inconclusive') then now() else null end where organization_id=$1 and id=$2 returning *`, [context.organizationId, id, input.status, input.result]); value = result.rows[0] ? mapHypothesisTest(result.rows[0] as Row) : undefined; }
    if (!value) throw new Error("Hypothesis test not found."); await this.audit(userId, actor, "updated hypothesis test", "hypothesis-test", id, { status: input.status }); return value;
  }

  async listRecoveries(userId: string, incidentId: string) { const context = await this.context(userId); if (!this.pool) return structuredClone(this.memoryRecoveries.filter((item) => item.incidentId === incidentId)); return (await this.pool.query(`select * from recovery_verifications where organization_id=$1 and incident_id=$2 order by created_at desc`, [context.organizationId, incidentId])).rows.map(mapRecovery); }
  async saveRecovery(userId: string, actor: string, incidentId: string, input: Omit<RecoveryVerification, "id" | "incidentId" | "createdAt" | "updatedAt" | "status" | "freshnessMinutes">) {
    const context = await this.assertRole(userId, ["admin", "responder"]); let value: RecoveryVerification;
    const freshnessMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(input.observedAt ?? "")) / 60_000));
    const fresh = Number.isFinite(freshnessMinutes) && freshnessMinutes <= Math.max(5, input.observationMinutes);
    const meetsTarget = input.comparison === "gte" ? Number(input.observedValue) >= input.targetValue : Number(input.observedValue) <= input.targetValue;
    const status: RecoveryVerification["status"] = !fresh ? "pending" : meetsTarget ? "verified" : "failed";
    const normalized = { ...input, status, freshnessMinutes };
    if (!this.pool) { const now = new Date().toISOString(); value = { id: randomUUID(), incidentId, ...normalized, createdAt: now, updatedAt: now }; this.memoryRecoveries.unshift(value); }
    else { const result = await this.pool.query(`insert into recovery_verifications(organization_id,incident_id,metric,target_value,baseline_value,observed_value,observation_minutes,status,reason,unit,comparison,source,query,window_started_at,window_ended_at,observed_at,freshness_minutes) select $1,i.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17 from incidents i where i.id=$2 and i.organization_id=$1 returning *`, [context.organizationId, incidentId, input.metric, input.targetValue, input.baselineValue, input.observedValue, input.observationMinutes, status, input.reason, input.unit, input.comparison, input.source, input.query, input.windowStartedAt, input.windowEndedAt, input.observedAt, freshnessMinutes]); if (!result.rows[0]) throw new Error("Incident not found in this workspace."); value = mapRecovery(result.rows[0] as Row); }
    await this.audit(userId, actor, "recorded recovery verification", "recovery", value.id, { incidentId, status, source: input.source, observedAt: input.observedAt }); return value;
  }
  async assertRecoveryVerified(userId: string, incidentId: string) { const values = await this.listRecoveries(userId, incidentId); const latest = values.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]; if (!latest || latest.status !== "verified") throw new Error(latest?.status === "failed" ? "The latest recovery observation regressed. Keep monitoring and record a newer passing window before resolving." : "Record a fresh, server-verified recovery observation before resolving this incident."); }

  async getPostmortem(userId: string, incidentId: string) { const context = await this.context(userId); if (!this.pool) return this.memoryPostmortems.find((item) => item.incidentId === incidentId) ?? null; const result = await this.pool.query(`select * from incident_postmortems where organization_id=$1 and incident_id=$2`, [context.organizationId, incidentId]); return result.rows[0] ? mapPostmortem(result.rows[0] as Row) : null; }
  async savePostmortem(userId: string, actor: string, incidentId: string, input: Omit<IncidentPostmortem, "incidentId" | "updatedAt">) { const context = await this.assertRole(userId, ["admin", "responder"]); let value: IncidentPostmortem; if (!this.pool) { value = { incidentId, ...input, updatedAt: new Date().toISOString() }; this.memoryPostmortems = [value, ...this.memoryPostmortems.filter((item) => item.incidentId !== incidentId)]; } else { const result = await this.pool.query(`insert into incident_postmortems(incident_id,organization_id,summary,root_cause,impact,recovery,follow_ups,status) select i.id,$1,$3,$4,$5,$6,$7,$8 from incidents i where i.id=$2 and i.organization_id=$1 on conflict(incident_id) do update set summary=excluded.summary,root_cause=excluded.root_cause,impact=excluded.impact,recovery=excluded.recovery,follow_ups=excluded.follow_ups,status=excluded.status,updated_at=now() returning *`, [context.organizationId, incidentId, input.summary, input.rootCause, input.impact, input.recovery, input.followUps, input.status]); if (!result.rows[0]) throw new Error("Incident not found in this workspace."); value = mapPostmortem(result.rows[0] as Row); } await this.audit(userId, actor, "saved postmortem", "postmortem", incidentId, { status: input.status }); return value; }

  async listComments(userId:string,incidentId:string){const context=await this.context(userId);if(!this.pool)return structuredClone(this.memoryComments.filter((item)=>item.incidentId===incidentId));const result=await this.pool.query(`select * from incident_comments where organization_id=$1 and incident_id=$2 order by created_at`,[context.organizationId,incidentId]);return(result.rows as Row[]).map((row)=>({id:String(row.id),incidentId:String(row.incident_id),actor:String(row.actor),body:String(row.body),eventId:row.event_id?String(row.event_id):null,createdAt:new Date(String(row.created_at)).toISOString()} satisfies IncidentComment));}
  async createComment(userId:string,actor:string,incidentId:string,input:{body:string;eventId?:string|null}){const context=await this.assertRole(userId,["admin","responder"]);let value:IncidentComment;if(!this.pool){value={id:randomUUID(),incidentId,actor,...input,createdAt:new Date().toISOString()};this.memoryComments.push(value);}else{const result=await this.pool.query(`insert into incident_comments(organization_id,incident_id,actor,body,event_id) select $1,i.id,$3,$4,$5 from incidents i where i.id=$2 and i.organization_id=$1 returning *`,[context.organizationId,incidentId,actor,input.body,input.eventId??null]);if(!result.rows[0])throw new Error("Incident not found in this workspace.");const row=result.rows[0] as Row;value={id:String(row.id),incidentId:String(row.incident_id),actor:String(row.actor),body:String(row.body),eventId:row.event_id?String(row.event_id):null,createdAt:new Date(String(row.created_at)).toISOString()};}await this.audit(userId,actor,"added evidence-linked comment","incident-comment",value.id,{incidentId,eventId:input.eventId??null});return value;}

  async listNotifications(userId: string, actor: string): Promise<ActionNotification[]> {
    const context = await this.context(userId);
    if (!this.pool) return [
      ...this.memoryMitigations.filter((item) => item.status === "pending" && item.requestedBy !== actor).map((item) => ({ id: `approval-${item.id}`, kind: "approval" as const, title: "Mitigation review required", detail: item.title, incidentId: item.incidentId, href: `/incidents/${item.incidentId}?area=validate&approval=${item.id}#approval-${item.id}`, createdAt: item.createdAt,urgency:"urgent" as const,reason:"A bounded production change is waiting for independent review.",owner:actor })),
      ...this.memoryHypothesisTests.filter((item) => item.assignee === actor && ["planned","running"].includes(item.status)).map((item) => ({ id: `test-${item.id}`, kind: "hypothesis" as const, title: "Investigation test assigned", detail: item.title, incidentId: item.incidentId, href: `/incidents/${item.incidentId}?area=investigate&test=${item.id}#test-${item.id}`, createdAt: item.createdAt,urgency:"normal" as const,reason:"A test assigned to you is still open.",owner:item.assignee }))
    ].map((item)=>({...item,read:this.memoryNotificationStates.get(`${userId}:${item.id}`)?.read??false,resolved:this.memoryNotificationStates.get(`${userId}:${item.id}`)?.resolved??false})).filter((item)=>!item.resolved);
    const result = await this.pool.query(`
      select 'approval-'||m.id as id,'approval' as kind,'Mitigation approval required' as title,m.title as detail,m.incident_id,m.created_at from mitigation_requests m where m.organization_id=$1 and m.status='pending' and m.requested_by<>$2
      union all select 'test-'||h.id,'hypothesis','Hypothesis test assigned',h.title,h.incident_id,h.created_at from hypothesis_tests h where h.organization_id=$1 and lower(h.assignee)=lower($2) and h.status in ('planned','running')
      union all select 'queue-'||q.id,'ingestion','Ingestion delivery needs attention',coalesce(q.last_error,'Delivery exhausted its retries'),null,q.updated_at from ingestion_queue q join integrations i on i.id=q.integration_id where i.organization_id=$1 and q.status='dead_letter'
      order by created_at desc limit 30`, [context.organizationId, actor]);
    const values=(result.rows as Row[]).map((row) => ({ id: String(row.id), kind: row.kind as ActionNotification["kind"], title: String(row.title), detail: String(row.detail), ...(row.incident_id ? { incidentId: String(row.incident_id) } : {}), href: row.incident_id ? `/incidents/${row.incident_id}?area=${row.kind==="approval"?"validate":"investigate"}&${row.kind==="approval"?"approval":"test"}=${String(row.id).replace(/^[^-]+-/,"")}#${String(row.id)}` : "/integrations", createdAt: new Date(String(row.created_at)).toISOString(),urgency:row.kind==="ingestion"||row.kind==="approval"?"urgent" as const:"normal" as const,reason:row.kind==="ingestion"?"A delivery exhausted retries and evidence may be missing.":row.kind==="approval"?"A bounded production change is waiting for independent review.":"A test assigned to you is still open.",owner:actor }));
    if(!values.length)return[];const states=await this.pool.query(`select * from notification_states where user_id=$1 and notification_id=any($2::text[])`,[userId,values.map((item)=>item.id)]);const byId=new Map((states.rows as Row[]).map((row)=>[String(row.notification_id),row]));return values.map((item)=>{const state=byId.get(item.id);return{...item,read:Boolean(state?.read_at),resolved:Boolean(state?.resolved_at)};}).filter((item)=>!item.resolved);
  }

  async updateNotificationState(userId:string,notificationId:string,input:{read?:boolean;resolved?:boolean}){const context=await this.context(userId);if(!this.pool){const key=`${userId}:${notificationId}`;const current=this.memoryNotificationStates.get(key)??{read:false,resolved:false};const value={read:input.read??current.read,resolved:input.resolved??current.resolved};this.memoryNotificationStates.set(key,value);return{notificationId,...value};}const result=await this.pool.query(`insert into notification_states(organization_id,user_id,notification_id,read_at,resolved_at) values($1,$2,$3,case when $4 then now() else null end,case when $5 then now() else null end) on conflict(user_id,notification_id) do update set read_at=case when $4 then coalesce(notification_states.read_at,now()) when $4=false then null else notification_states.read_at end,resolved_at=case when $5 then coalesce(notification_states.resolved_at,now()) when $5=false then null else notification_states.resolved_at end,updated_at=now() returning *`,[context.organizationId,userId,notificationId,input.read??null,input.resolved??null]);const row=result.rows[0] as Row;return{notificationId,read:Boolean(row.read_at),resolved:Boolean(row.resolved_at)};}
}

export const workspaceService = new WorkspaceService();
