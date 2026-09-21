import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import type { AuditEntry, IncidentPolicy, MitigationRequest, ServiceDefinition, TeamInvitation, TeamMember, WorkspaceContext, WorkspaceRole } from "./types.js";

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
  expiresAt: new Date(String(row.expires_at)).toISOString(), createdAt: new Date(String(row.created_at)).toISOString()
});
const mapAudit = (row: Row): AuditEntry => ({
  id: String(row.id), actor: String(row.actor), action: String(row.action), targetType: String(row.target_type),
  targetId: row.target_id ? String(row.target_id) : null, detail: (row.detail ?? {}) as Record<string, unknown>, createdAt: new Date(String(row.created_at)).toISOString()
});
const mapMitigation = (row: Row): MitigationRequest => ({
  id: String(row.id), incidentId: String(row.incident_id), requestedBy: String(row.requested_by), reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
  title: String(row.title), action: String(row.action), rollbackPlan: String(row.rollback_plan), status: row.status as MitigationRequest["status"],
  createdAt: new Date(String(row.created_at)).toISOString(), reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : null
});

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
        expires_at timestamptz not null, created_by uuid, created_at timestamptz not null default now()
      );
      create table if not exists workspace_audit_log (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        actor text not null, action text not null, target_type text not null, target_id text, detail jsonb not null default '{}', created_at timestamptz not null default now()
      );
      create table if not exists mitigation_requests (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, incident_id uuid not null references incidents(id) on delete cascade,
        requested_by text not null, reviewed_by text, title text not null, action text not null, rollback_plan text not null,
        status text not null default 'pending' check (status in ('pending','approved','rejected','executed')), created_at timestamptz not null default now(), reviewed_at timestamptz
      );
      create index if not exists service_catalog_org_idx on service_catalog(organization_id,name);
      create index if not exists workspace_audit_org_idx on workspace_audit_log(organization_id,created_at desc);
      create index if not exists mitigation_incident_idx on mitigation_requests(incident_id,created_at desc);
      alter table service_catalog enable row level security;
      alter table incident_policies enable row level security;
      alter table organization_invitations enable row level security;
      alter table workspace_audit_log enable row level security;
      alter table mitigation_requests enable row level security;
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
      invite = { id: randomUUID(), email, role, status: "pending", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), createdAt: new Date().toISOString(), inviteToken: token };
      this.memoryInvites.unshift(invite);
    } else {
      const result = await this.pool.query(`insert into organization_invitations(organization_id,email,role,token_hash,expires_at,created_by) values($1,$2,$3,$4,now()+interval '7 days',$5) returning *`, [context.organizationId, email.toLowerCase(), role, tokenHash, userId]);
      invite = { ...mapInvite(result.rows[0] as Row), inviteToken: token };
    }
    await this.audit(userId, actor, "created invitation", "invitation", invite.id, { email, role });
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
    return (await this.pool.query(`select * from mitigation_requests where organization_id=$1 and incident_id=$2 order by created_at desc`, [context.organizationId, incidentId])).rows.map(mapMitigation);
  }

  async requestMitigation(userId: string, actor: string, incidentId: string, input: Pick<MitigationRequest, "title" | "action" | "rollbackPlan">) {
    const context = await this.assertRole(userId, ["admin", "responder"]);
    let request: MitigationRequest;
    if (!this.pool) {
      request = { id: randomUUID(), incidentId, requestedBy: actor, title: input.title, action: input.action, rollbackPlan: input.rollbackPlan, status: "pending", createdAt: new Date().toISOString() };
      this.memoryMitigations.unshift(request);
    } else {
      const result = await this.pool.query(`insert into mitigation_requests(organization_id,incident_id,requested_by,title,action,rollback_plan) select $1,i.id,$3,$4,$5,$6 from incidents i where i.id=$2 and i.organization_id=$1 returning *`, [context.organizationId, incidentId, actor, input.title, input.action, input.rollbackPlan]);
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
      const result = await this.pool.query(`update mitigation_requests set status=$3,reviewed_by=$4,reviewed_at=now() where id=$2 and organization_id=$1 and status='pending' and requested_by<>$4 returning *`, [context.organizationId, requestId, status, actor]);
      request = result.rows[0] ? mapMitigation(result.rows[0] as Row) : undefined;
    }
    if (!request) throw new Error("This request is unavailable, already reviewed, or cannot be self-approved.");
    await this.audit(userId, actor, `${status} mitigation`, "mitigation", request.id, { incidentId: request.incidentId });
    return request;
  }
}

export const workspaceService = new WorkspaceService();
