import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { seedActivities, seedDashboardSeries, seedIncidents, seedReplayRuns } from "./seed.js";
import type { Activity, DashboardData, Incident, IncidentDecision, IncidentEvent, IngestionBatch, IngestionResult, Integration, IntegrationDelivery, IntegrationProvider, IntegrationTarget, NormalizedSignal, ReplayConfig, ReplayProjection, ReplayResult, ReplayRun, SearchResult } from "./types.js";
import { workspaceService } from "./workspace.js";

export type IncidentInput = Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events">;
export type EventInput = Omit<IncidentEvent, "id" | "incidentId">;
export type DecisionInput = Pick<IncidentDecision, "kind" | "status" | "title" | "detail">;
export type IntegrationInput = { name: string; provider: IntegrationProvider };

export interface Repository {
  initialize(): Promise<void>;
  dashboard(userId: string): Promise<DashboardData>;
  listIncidents(userId: string): Promise<Incident[]>;
  getIncident(userId: string, id: string): Promise<Incident | null>;
  createIncident(userId: string, input: IncidentInput, embedding?: number[]): Promise<Incident>;
  updateIncident(userId: string, id: string, input: Partial<IncidentInput>, embedding?: number[]): Promise<Incident | null>;
  deleteIncident(userId: string, id: string): Promise<boolean>;
  createEvent(userId: string, incidentId: string, input: EventInput): Promise<IncidentEvent | null>;
  updateEvent(userId: string, incidentId: string, eventId: string, input: Partial<EventInput>): Promise<IncidentEvent | null>;
  deleteEvent(userId: string, incidentId: string, eventId: string): Promise<boolean>;
  listDecisions(userId: string, incidentId: string): Promise<IncidentDecision[]>;
  createDecision(userId: string, incidentId: string, input: DecisionInput): Promise<IncidentDecision | null>;
  runReplay(userId: string, incidentId: string, config: ReplayConfig): Promise<ReplayResult | null>;
  search(userId: string, query: string, embedding?: number[]): Promise<SearchResult[]>;
  listIntegrations(userId: string): Promise<Integration[]>;
  createIntegration(userId: string, input: IntegrationInput): Promise<Integration>;
  deleteIntegration(userId: string, integrationId: string): Promise<boolean>;
  getIntegrationTarget(integrationId: string): Promise<IntegrationTarget | null>;
  ingest(integration: IntegrationTarget, batch: IngestionBatch): Promise<IngestionResult>;
}

const clone = <T>(value: T): T => structuredClone(value);

export function simulateReplay(incident: Incident, config: ReplayConfig): ReplayProjection {
  const baselinePeak = incident.events.reduce((peak, event) => Math.max(peak, event.impactScore), 0);
  const retryRelief = Math.max(0, 4 - config.retryCeiling) * 8;
  const concurrencyRelief = Math.max(-5, Math.min(9, (30 - config.concurrencyCap) * 0.45));
  const timeoutRelief = Math.max(-4, Math.min(8, (3000 - config.timeoutMs) / 250));
  const evidenceCoverage = Math.min(1, incident.events.length / 6);
  const totalRelief = Math.max(0, retryRelief + concurrencyRelief + timeoutRelief) * (0.72 + evidenceCoverage * 0.28);
  const projectedPeak = Math.max(12, Math.round(baselinePeak - totalRelief));
  const improvement = Math.max(0, baselinePeak - projectedPeak);
  const avoidedHighImpactEvents = Math.min(
    incident.events.filter((event) => event.impactScore >= 65).length,
    Math.floor(improvement / 14)
  );
  const recoveryGainMinutes = Math.round(improvement / 3.5);
  const hasRecovery = incident.events.some((event) => event.kind === "recovery");
  const confidence = Math.min(94, Math.round(46 + incident.events.length * 6 + (hasRecovery ? 8 : 0)));
  const state: ReplayProjection["state"] = projectedPeak <= 60 ? "contained" : projectedPeak <= 78 ? "degraded" : "critical";
  const summary = state === "contained"
    ? "The candidate contains propagation below the high-impact threshold."
    : state === "degraded"
      ? "The candidate reduces pressure, but one degraded path remains."
      : "The candidate does not sufficiently interrupt the recorded propagation path.";

  return {
    baselinePeak,
    projectedPeak,
    avoidedHighImpactEvents,
    recoveryGainMinutes,
    confidence,
    state,
    summary,
    signals: [
      `Retry amplification relief: ${Math.round(retryRelief)} points`,
      `Concurrency pressure relief: ${Math.round(concurrencyRelief)} points`,
      `Timeout budget relief: ${Math.round(timeoutRelief)} points`
    ]
  };
}

export class MemoryRepository implements Repository {
  private incidents = clone(seedIncidents);
  private decisions: IncidentDecision[] = [];
  private replayRuns = clone(seedReplayRuns);
  private integrations: Integration[] = [];
  private deliveries = new Set<string>();
  private bufferedSignals: Array<NormalizedSignal & { integrationId: string; incidentId?: string }> = [];

  async initialize() {}

  async dashboard(_userId: string): Promise<DashboardData> {
    return { incidents: clone(this.incidents), activities: clone(seedActivities), replayRuns: clone(this.replayRuns), ...clone(seedDashboardSeries) };
  }
  async listIncidents(_userId: string) { return clone(this.incidents).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  async getIncident(_userId: string, id: string) { return clone(this.incidents.find((incident) => incident.id === id) ?? null); }
  async createIncident(_userId: string, input: IncidentInput) {
    const now = new Date().toISOString();
    const incident: Incident = { ...input, id: randomUUID(), code: `ROP-${Math.floor(2000 + Math.random() * 7000)}`, createdAt: now, updatedAt: now, events: [] };
    this.incidents.unshift(incident);
    return clone(incident);
  }
  async updateIncident(_userId: string, id: string, input: Partial<IncidentInput>) {
    const incident = this.incidents.find((item) => item.id === id);
    if (!incident) return null;
    Object.assign(incident, input, { updatedAt: new Date().toISOString() });
    return clone(incident);
  }
  async deleteIncident(_userId: string, id: string) {
    const before = this.incidents.length;
    this.incidents = this.incidents.filter((incident) => incident.id !== id);
    return this.incidents.length < before;
  }
  async createEvent(_userId: string, incidentId: string, input: EventInput) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return null;
    const event: IncidentEvent = { ...input, id: randomUUID(), incidentId };
    incident.events.push(event);
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString();
    return clone(event);
  }
  async updateEvent(_userId: string, incidentId: string, eventId: string, input: Partial<EventInput>) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    const event = incident?.events.find((item) => item.id === eventId);
    if (!incident || !event) return null;
    Object.assign(event, input);
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString();
    return clone(event);
  }
  async deleteEvent(_userId: string, incidentId: string, eventId: string) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return false;
    const before = incident.events.length;
    incident.events = incident.events.filter((event) => event.id !== eventId);
    incident.updatedAt = new Date().toISOString();
    return incident.events.length < before;
  }
  async listDecisions(_userId: string, incidentId: string) {
    return clone(this.decisions.filter((decision) => decision.incidentId === incidentId).sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  }
  async createDecision(_userId: string, incidentId: string, input: DecisionInput) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return null;
    const decision: IncidentDecision = { ...input, id: randomUUID(), incidentId, actor: incident.owner, timestamp: new Date().toISOString() };
    this.decisions.unshift(decision);
    return clone(decision);
  }
  async runReplay(_userId: string, incidentId: string, config: ReplayConfig) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return null;
    const projection = simulateReplay(incident, config);
    const run: ReplayResult = {
      id: randomUUID(), incidentId, config, projection,
      name: `Retry ${config.retryCeiling} · cap ${config.concurrencyCap} · ${config.timeoutMs}ms`,
      status: projection.state === "critical" ? "failed" : "passed",
      progress: 100,
      createdAt: new Date().toISOString()
    };
    this.replayRuns.unshift(run);
    return clone(run);
  }
  async search(_userId: string, query: string) {
    const tokens = query.toLowerCase().split(/\W+/).filter(Boolean);
    return this.incidents.map((incident) => {
      const haystack = [incident.code, incident.title, incident.summary, incident.service, ...incident.events.flatMap((event) => [event.title, event.detail, event.service])].join(" ").toLowerCase();
      const matches = tokens.filter((token) => haystack.includes(token)).length;
      return { incident: clone(incident), score: tokens.length ? matches / tokens.length : 0, matchReason: matches ? `${matches} query signal${matches === 1 ? "" : "s"} matched incident evidence` : "Related operational history" };
    }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  }
  async listIntegrations(_userId: string) {
    return clone(this.integrations);
  }
  async createIntegration(_userId: string, input: IntegrationInput) {
    const integration: Integration = {
      id: randomUUID(), name: input.name, provider: input.provider, status: "active", createdAt: new Date().toISOString(),
      lastDeliveryAt: null, lastDeliveryStatus: null, signalCount: 0, deliveries: []
    };
    this.integrations.unshift(integration);
    return clone(integration);
  }
  async deleteIntegration(_userId: string, integrationId: string) {
    const before = this.integrations.length;
    this.integrations = this.integrations.filter((integration) => integration.id !== integrationId);
    this.bufferedSignals = this.bufferedSignals.filter((signal) => signal.integrationId !== integrationId);
    return this.integrations.length < before;
  }
  async getIntegrationTarget(integrationId: string) {
    const integration = this.integrations.find((item) => item.id === integrationId);
    return integration ? { id: integration.id, organizationId: "demo-organization", name: integration.name, provider: integration.provider, status: integration.status } : null;
  }
  async ingest(integration: IntegrationTarget, batch: IngestionBatch) {
    const policy = await workspaceService.policyForOrganization(integration.organizationId);
    const deliveryKey = `${integration.id}:${batch.externalId}`;
    if (this.deliveries.has(deliveryKey)) return { status: "duplicate", acceptedSignals: 0, incidentIds: [] } satisfies IngestionResult;
    this.deliveries.add(deliveryKey);
    const incidentIds = new Set<string>();
    let acceptedSignals = 0;
    for (const signal of batch.signals) {
      const relatedServices = await workspaceService.relatedServicesForOrganization(integration.organizationId, signal.service);
      if (this.bufferedSignals.some((item) => item.integrationId === integration.id && item.externalId === signal.externalId)) continue;
      const buffered: NormalizedSignal & { integrationId: string; incidentId?: string } = { ...signal, integrationId: integration.id };
      this.bufferedSignals.push(buffered);
      acceptedSignals += 1;
      let incident = signal.correlationKey
        ? this.incidents.find((item) => item.status !== "resolved" && item.events.some((event) => event.metadata?.correlationKey === signal.correlationKey))
        : undefined;
      incident ??= this.incidents.find((item) => item.status !== "resolved" && relatedServices.includes(item.service) && Math.abs(new Date(item.startedAt).getTime() - new Date(signal.timestamp).getTime()) <= policy.groupingWindowMinutes * 60_000);
      const suppressed = policy.maintenanceMode || (policy.suppressLowSeverity && signal.severity === "low");
      if (!incident && !suppressed && signal.impactScore >= policy.incidentThreshold) {
        const now = new Date().toISOString();
        incident = {
          id: randomUUID(), code: `AUTO-${String(Date.now()).slice(-6)}`, title: signal.title,
          summary: `Automatically opened from ${integration.name} after ${signal.service} crossed the incident threshold.`,
          service: signal.service, severity: signal.severity, status: "investigating", owner: "Automation",
          startedAt: signal.timestamp, resolvedAt: null, createdAt: now, updatedAt: now, events: []
        };
        this.incidents.unshift(incident);
        const triggerTime = new Date(signal.timestamp).getTime();
        for (const precursor of this.bufferedSignals.filter((item) => !item.incidentId && relatedServices.includes(item.service) && new Date(item.timestamp).getTime() >= triggerTime - 1_800_000 && new Date(item.timestamp).getTime() <= triggerTime)) {
          precursor.incidentId = incident.id;
          incident.events.push(signalToEvent(incident.id, precursor));
        }
      }
      if (incident && !buffered.incidentId) {
        buffered.incidentId = incident.id;
        if (!incident.events.some((event) => event.metadata?.sourceExternalId === signal.externalId)) incident.events.push(signalToEvent(incident.id, signal));
      }
      if (incident) {
        incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        incident.updatedAt = new Date().toISOString();
        if (signal.kind === "recovery") incident.status = "monitoring";
        incidentIds.add(incident.id);
      }
    }
    const now = new Date().toISOString();
    const storedIntegration = this.integrations.find((item) => item.id === integration.id);
    if (storedIntegration) {
      const delivery: IntegrationDelivery = { id: randomUUID(), integrationId: integration.id, externalId: batch.externalId, status: "accepted", signalCount: acceptedSignals, incidentIds: [...incidentIds], receivedAt: now };
      storedIntegration.lastDeliveryAt = now;
      storedIntegration.lastDeliveryStatus = "accepted";
      storedIntegration.signalCount += acceptedSignals;
      storedIntegration.deliveries.unshift(delivery);
      storedIntegration.deliveries = storedIntegration.deliveries.slice(0, 8);
    }
    return { status: "accepted", acceptedSignals, incidentIds: [...incidentIds] } satisfies IngestionResult;
  }
}

const signalToEvent = (incidentId: string, signal: NormalizedSignal): IncidentEvent => ({
  id: randomUUID(), incidentId, timestamp: signal.timestamp, service: signal.service, kind: signal.kind,
  title: signal.title, detail: signal.detail, impactScore: signal.impactScore,
  metadata: {
    ...signal.metadata, sourceExternalId: signal.externalId, correlationKey: signal.correlationKey,
    traceId: signal.traceId, sourceUrl: signal.sourceUrl, environment: signal.environment, automated: true
  }
});

type Row = Record<string, unknown>;
const mapEvent = (row: Row): IncidentEvent => ({
  id: String(row.id), incidentId: String(row.incident_id), timestamp: new Date(String(row.timestamp)).toISOString(),
  service: String(row.service), kind: row.kind as IncidentEvent["kind"], title: String(row.title), detail: String(row.detail),
  impactScore: Number(row.impact_score), metadata: (row.metadata ?? {}) as Record<string, unknown>
});
const mapIncident = (row: Row, events: IncidentEvent[] = []): Incident => ({
  id: String(row.id), code: String(row.code), title: String(row.title), summary: String(row.summary), service: String(row.service),
  severity: row.severity as Incident["severity"], status: row.status as Incident["status"], owner: String(row.owner),
  startedAt: new Date(String(row.started_at)).toISOString(), resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : null,
  createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(), events
});
const mapActivity = (row: Row): Activity => ({
  id: String(row.id),
  ...(row.incident_id ? { incidentId: String(row.incident_id) } : {}),
  actor: String(row.actor), action: String(row.action).replace(/^\[decision:[^:]+:[^\]]+\]\s*/, ""), detail: String(row.detail),
  timestamp: new Date(String(row.timestamp)).toISOString()
});
const mapDecision = (row: Row): IncidentDecision => {
  const match = String(row.action).match(/^\[decision:(hypothesis|mitigation|communication):(proposed|approved|rejected)\]\s*(.+)$/);
  return {
    id: String(row.id), incidentId: String(row.incident_id), actor: String(row.actor),
    kind: (match?.[1] ?? "mitigation") as IncidentDecision["kind"],
    status: (match?.[2] ?? "proposed") as IncidentDecision["status"],
    title: match?.[3] ?? String(row.action), detail: String(row.detail),
    timestamp: new Date(String(row.timestamp)).toISOString()
  };
};
const mapReplayRun = (row: Row): ReplayRun => ({
  id: String(row.id), incidentId: String(row.incident_id), name: String(row.name),
  status: row.status as ReplayRun["status"], progress: Number(row.progress),
  createdAt: new Date(String(row.created_at)).toISOString()
});
const mapDelivery = (row: Row): IntegrationDelivery => ({
  id: String(row.id), integrationId: String(row.integration_id), externalId: String(row.external_id),
  status: row.status as IntegrationDelivery["status"], signalCount: Number(row.signal_count),
  incidentIds: Array.isArray(row.incident_ids) ? row.incident_ids.map(String) : [],
  error: row.error ? String(row.error) : null, receivedAt: new Date(String(row.received_at)).toISOString()
});
const mapIntegration = (row: Row, deliveries: IntegrationDelivery[] = []): Integration => ({
  id: String(row.id), name: String(row.name), provider: row.provider as Integration["provider"],
  status: row.status as Integration["status"], createdAt: new Date(String(row.created_at)).toISOString(),
  lastDeliveryAt: row.last_delivery_at ? new Date(String(row.last_delivery_at)).toISOString() : null,
  lastDeliveryStatus: row.last_delivery_status ? row.last_delivery_status as IntegrationDelivery["status"] : null,
  signalCount: Number(row.signal_count ?? 0), deliveries
});

class PostgresRepository implements Repository {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }, max: 6 });
  }
  async initialize() {
    await this.pool.query(`
      create table if not exists integrations (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        created_by uuid references auth.users(id) on delete set null,
        name text not null,
        provider text not null check (provider in ('github', 'otel', 'generic')),
        status text not null default 'active' check (status in ('active', 'paused')),
        last_delivery_at timestamptz,
        last_delivery_status text check (last_delivery_status in ('accepted', 'duplicate', 'rejected', 'failed')),
        signal_count integer not null default 0 check (signal_count >= 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists ingestion_deliveries (
        id uuid primary key default gen_random_uuid(),
        integration_id uuid not null references integrations(id) on delete cascade,
        external_id text not null,
        status text not null check (status in ('accepted', 'duplicate', 'rejected', 'failed')),
        signal_count integer not null default 0,
        incident_ids uuid[] not null default '{}',
        error text,
        received_at timestamptz not null default now(),
        unique (integration_id, external_id)
      );
      create table if not exists ingestion_signals (
        id uuid primary key default gen_random_uuid(),
        integration_id uuid not null references integrations(id) on delete cascade,
        external_id text not null,
        occurred_at timestamptz not null,
        service text not null,
        kind text not null check (kind in ('alert', 'deploy', 'dependency', 'metric', 'action', 'recovery')),
        title text not null,
        detail text not null,
        impact_score integer not null check (impact_score between 0 and 100),
        severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
        correlation_key text,
        trace_id text,
        source_url text,
        environment text,
        metadata jsonb not null default '{}'::jsonb,
        incident_id uuid references incidents(id) on delete set null,
        created_at timestamptz not null default now(),
        unique (integration_id, external_id)
      );
      create index if not exists integrations_org_idx on integrations(organization_id, created_at desc);
      create index if not exists ingestion_deliveries_source_idx on ingestion_deliveries(integration_id, received_at desc);
      create index if not exists ingestion_signals_match_idx on ingestion_signals(service, occurred_at desc) where incident_id is null;
      create index if not exists ingestion_signals_correlation_idx on ingestion_signals(correlation_key) where correlation_key is not null;
      alter table integrations enable row level security;
      alter table ingestion_deliveries enable row level security;
      alter table ingestion_signals enable row level security;
    `);
  }
  private async hydrated(userId: string, where = "", values: unknown[] = []) {
    const incidentResult = await this.pool.query(
      `select i.* from incidents i
       where exists (
         select 1 from organization_members m
         where m.organization_id = i.organization_id and m.user_id = $1
       ) ${where}
       order by i.started_at desc`,
      [userId, ...values]
    );
    if (!incidentResult.rows.length) return [];
    const ids = incidentResult.rows.map((row: Row) => row.id);
    const eventResult = await this.pool.query("select * from incident_events where incident_id = any($1::uuid[]) order by timestamp", [ids]);
    const grouped = new Map<string, IncidentEvent[]>();
    for (const row of eventResult.rows as Row[]) {
      const event = mapEvent(row);
      grouped.set(event.incidentId, [...(grouped.get(event.incidentId) ?? []), event]);
    }
    return (incidentResult.rows as Row[]).map((row) => mapIncident(row, grouped.get(String(row.id)) ?? []));
  }
  async dashboard(userId: string): Promise<DashboardData> {
    const [incidents, activities, replayRuns, serviceHealth, eventVolume] = await Promise.all([
      this.listIncidents(userId),
      this.pool.query(
        `select a.* from incident_activities a
         where exists (select 1 from organization_members m where m.organization_id = a.organization_id and m.user_id = $1)
         order by a.timestamp desc limit 20`,
        [userId]
      ),
      this.pool.query(
        `select r.* from replay_runs r
         where exists (select 1 from organization_members m where m.organization_id = r.organization_id and m.user_id = $1)
         order by r.created_at desc limit 20`,
        [userId]
      ),
      this.pool.query(
        `select * from (
           select distinct on (s.service) s.* from service_health_snapshots s
           where exists (select 1 from organization_members m where m.organization_id = s.organization_id and m.user_id = $1)
           order by s.service, s.observed_at desc
         ) latest order by case latest.state when 'critical' then 1 when 'degraded' then 2 else 3 end, latest.service`,
        [userId]
      ),
      this.pool.query(
        `select v.* from event_volume_samples v
         where exists (select 1 from organization_members m where m.organization_id = v.organization_id and m.user_id = $1)
         order by v.sampled_at asc limit 48`,
        [userId]
      )
    ]);

    return {
      incidents,
      activities: (activities.rows as Row[]).map(mapActivity),
      replayRuns: (replayRuns.rows as Row[]).map(mapReplayRun),
      serviceHealth: (serviceHealth.rows as Row[]).map((row) => ({
        service: String(row.service), availability: Number(row.availability), latencyMs: Number(row.latency_ms),
        errorRate: Number(row.error_rate), state: row.state as DashboardData["serviceHealth"][number]["state"]
      })),
      eventVolume: (eventVolume.rows as Row[]).map((row) => ({
        time: new Date(String(row.sampled_at)).toISOString().slice(11, 16),
        requests: Number(row.requests), errors: Number(row.errors)
      }))
    };
  }
  listIncidents(userId: string) { return this.hydrated(userId); }
  async getIncident(userId: string, id: string) { return (await this.hydrated(userId, "and i.id = $2", [id]))[0] ?? null; }
  async createIncident(userId: string, input: IncidentInput, embedding?: number[]) {
    const result = await this.pool.query(
      `insert into incidents (organization_id,code,title,summary,service,severity,status,owner,started_at,resolved_at,embedding)
       select m.organization_id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector
       from organization_members m where m.user_id = $1
       order by m.created_at desc limit 1 returning *`,
      [userId, `ROP-${Math.floor(2000 + Math.random() * 7000)}`, input.title, input.summary, input.service, input.severity, input.status, input.owner, input.startedAt, input.resolvedAt ?? null, embedding ? `[${embedding.join(",")}]` : null]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new Error("No organization membership exists for this account. Complete workspace onboarding before creating incidents.");
    return mapIncident(row);
  }
  async updateIncident(userId: string, id: string, input: Partial<IncidentInput>, embedding?: number[]) {
    const fields: Array<[string, unknown, boolean?]> = [
      ["title", input.title], ["summary", input.summary], ["service", input.service], ["severity", input.severity], ["status", input.status],
      ["owner", input.owner], ["started_at", input.startedAt], ["resolved_at", input.resolvedAt], ["embedding", embedding ? `[${embedding.join(",")}]` : undefined, true]
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown, boolean?]>;
    if (!fields.length) return this.getIncident(userId, id);
    const values = [userId, ...fields.map((entry) => entry[1])];
    const sets = fields.map(([key, , vector], index) => `${key} = $${index + 2}${vector ? "::vector" : ""}`);
    values.push(id);
    await this.pool.query(
      `update incidents i set ${sets.join(", ")}, updated_at = now()
       where i.id = $${values.length}
       and exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)`,
      values
    );
    return this.getIncident(userId, id);
  }
  async deleteIncident(userId: string, id: string) {
    return (await this.pool.query(
      `delete from incidents i where i.id = $2
       and exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)`,
      [userId, id]
    )).rowCount === 1;
  }
  async createEvent(userId: string, incidentId: string, input: EventInput) {
    if (!await this.getIncident(userId, incidentId)) return null;
    const result = await this.pool.query(`insert into incident_events (incident_id,timestamp,service,kind,title,detail,impact_score,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [incidentId, input.timestamp, input.service, input.kind, input.title, input.detail, input.impactScore, input.metadata ?? {}]);
    const row = result.rows[0] as Row | undefined;
    return row ? mapEvent(row) : null;
  }
  async updateEvent(userId: string, incidentId: string, eventId: string, input: Partial<EventInput>) {
    const fields = [["timestamp", input.timestamp], ["service", input.service], ["kind", input.kind], ["title", input.title], ["detail", input.detail], ["impact_score", input.impactScore], ["metadata", input.metadata]].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (!fields.length) return null;
    const values = [userId, ...fields.map((entry) => entry[1])];
    const sets = fields.map(([key], index) => `${key} = $${index + 2}`);
    values.push(incidentId, eventId);
    const result = await this.pool.query(
      `update incident_events e set ${sets.join(", ")}
       where e.incident_id = $${values.length - 1} and e.id = $${values.length}
       and exists (
         select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
         where i.id = e.incident_id and m.user_id = $1
       ) returning e.*`,
      values
    );
    const row = result.rows[0] as Row | undefined;
    return row ? mapEvent(row) : null;
  }
  async deleteEvent(userId: string, incidentId: string, eventId: string) {
    return (await this.pool.query(
      `delete from incident_events e where e.incident_id = $2 and e.id = $3
       and exists (
         select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
         where i.id = e.incident_id and m.user_id = $1
       )`,
      [userId, incidentId, eventId]
    )).rowCount === 1;
  }
  async listDecisions(userId: string, incidentId: string) {
    const result = await this.pool.query(
      `select a.* from incident_activities a
       where a.incident_id = $2 and a.action like '[decision:%'
       and exists (
         select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
         where i.id = a.incident_id and m.user_id = $1
       )
       order by a.timestamp desc`,
      [userId, incidentId]
    );
    return (result.rows as Row[]).map(mapDecision);
  }
  async createDecision(userId: string, incidentId: string, input: DecisionInput) {
    const action = `[decision:${input.kind}:${input.status}] ${input.title}`;
    const result = await this.pool.query(
      `insert into incident_activities (organization_id, incident_id, actor, action, detail, timestamp)
       select i.organization_id, i.id, i.owner, $3, $4, now()
       from incidents i join organization_members m on m.organization_id = i.organization_id
       where i.id = $2 and m.user_id = $1
       returning *`,
      [userId, incidentId, action, input.detail]
    );
    const row = result.rows[0] as Row | undefined;
    return row ? mapDecision(row) : null;
  }
  async runReplay(userId: string, incidentId: string, config: ReplayConfig) {
    const incident = await this.getIncident(userId, incidentId);
    if (!incident) return null;
    const projection = simulateReplay(incident, config);
    const name = `Retry ${config.retryCeiling} · cap ${config.concurrencyCap} · ${config.timeoutMs}ms · ${new Date().toISOString().slice(11, 19)}`;
    const status = projection.state === "critical" ? "failed" : "passed";
    const result = await this.pool.query(
      `insert into replay_runs (organization_id, incident_id, name, status, progress)
       select i.organization_id, i.id, $3, $4, 100
       from incidents i join organization_members m on m.organization_id = i.organization_id
       where i.id = $2 and m.user_id = $1
       returning *`,
      [userId, incidentId, name, status]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return { ...mapReplayRun(row), config, projection } satisfies ReplayResult;
  }
  async search(userId: string, query: string, embedding?: number[]) {
    const result = embedding
      ? await this.pool.query(
        `select i.*, 1 - (i.embedding <=> $2::vector) as score from incidents i
         where i.embedding is not null
         and exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)
         order by i.embedding <=> $2::vector limit 6`,
        [userId, `[${embedding.join(",")}]`]
      )
      : await this.pool.query(
        `select i.*, ts_rank_cd(to_tsvector('english', i.title || ' ' || i.summary || ' ' || i.service), plainto_tsquery('english', $2)) as score
         from incidents i
         where exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)
         and to_tsvector('english', i.title || ' ' || i.summary || ' ' || i.service) @@ plainto_tsquery('english', $2)
         order by score desc limit 6`,
        [userId, query]
      );
    const hydrated = await Promise.all((result.rows as Row[]).map((row) => this.getIncident(userId, String(row.id))));
    return hydrated.flatMap((incident, index) => incident ? [{ incident, score: Number((result.rows[index] as Row | undefined)?.score ?? 0), matchReason: embedding ? "Semantic similarity across incident evidence" : "Full-text match across incident evidence" }] : []);
  }
  async listIntegrations(userId: string) {
    const integrations = await this.pool.query(
      `select x.* from integrations x
       where exists (select 1 from organization_members m where m.organization_id = x.organization_id and m.user_id = $1)
       order by x.created_at desc`,
      [userId]
    );
    if (!integrations.rows.length) return [];
    const ids = integrations.rows.map((row: Row) => row.id);
    const deliveries = await this.pool.query(
      `select * from (
         select d.*, row_number() over (partition by d.integration_id order by d.received_at desc) as row_number
         from ingestion_deliveries d where d.integration_id = any($1::uuid[])
       ) ranked where row_number <= 8 order by received_at desc`,
      [ids]
    );
    const grouped = new Map<string, IntegrationDelivery[]>();
    for (const row of deliveries.rows as Row[]) {
      const delivery = mapDelivery(row);
      grouped.set(delivery.integrationId, [...(grouped.get(delivery.integrationId) ?? []), delivery]);
    }
    return (integrations.rows as Row[]).map((row) => mapIntegration(row, grouped.get(String(row.id)) ?? []));
  }
  async createIntegration(userId: string, input: IntegrationInput) {
    const result = await this.pool.query(
      `insert into integrations (organization_id, created_by, name, provider)
       select m.organization_id, $1, $2, $3 from organization_members m
       where m.user_id = $1 and m.role in ('admin', 'responder')
       order by m.created_at desc limit 1 returning *`,
      [userId, input.name, input.provider]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new Error("A responder workspace is required before a connector can be created.");
    return mapIntegration(row);
  }
  async deleteIntegration(userId: string, integrationId: string) {
    return (await this.pool.query(
      `delete from integrations x where x.id = $2
       and exists (
         select 1 from organization_members m
         where m.organization_id = x.organization_id and m.user_id = $1 and m.role in ('admin', 'responder')
       )`,
      [userId, integrationId]
    )).rowCount === 1;
  }
  async getIntegrationTarget(integrationId: string) {
    const result = await this.pool.query("select id, organization_id, name, provider, status from integrations where id = $1", [integrationId]);
    const row = result.rows[0] as Row | undefined;
    return row ? {
      id: String(row.id), organizationId: String(row.organization_id), name: String(row.name),
      provider: row.provider as IntegrationTarget["provider"], status: row.status as IntegrationTarget["status"]
    } : null;
  }
  async ingest(integration: IntegrationTarget, batch: IngestionBatch) {
    const policy = await workspaceService.policyForOrganization(integration.organizationId);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const delivery = await client.query(
        `insert into ingestion_deliveries (integration_id, external_id, status, signal_count)
         values ($1, $2, 'accepted', 0)
         on conflict (integration_id, external_id) do nothing returning id`,
        [integration.id, batch.externalId]
      );
      if (!delivery.rowCount) {
        await client.query("rollback");
        return { status: "duplicate", acceptedSignals: 0, incidentIds: [] } satisfies IngestionResult;
      }

      const incidentIds = new Set<string>();
      let acceptedSignals = 0;
      for (const signal of batch.signals) {
        const relatedServices = await workspaceService.relatedServicesForOrganization(integration.organizationId, signal.service);
        const insertedSignal = await client.query(
          `insert into ingestion_signals (
             integration_id, external_id, occurred_at, service, kind, title, detail, impact_score, severity,
             correlation_key, trace_id, source_url, environment, metadata
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           on conflict (integration_id, external_id) do nothing returning id`,
          [integration.id, signal.externalId, signal.timestamp, signal.service, signal.kind, signal.title, signal.detail,
            signal.impactScore, signal.severity, signal.correlationKey ?? null, signal.traceId ?? null,
            signal.sourceUrl ?? null, signal.environment ?? null, signal.metadata]
        );
        if (!insertedSignal.rowCount) continue;
        acceptedSignals += 1;
        const signalId = String((insertedSignal.rows[0] as Row).id);

        const match = await client.query(
          `select i.id from incidents i
           where i.organization_id = $1 and i.status <> 'resolved'
           and (
             ($2::text is not null and exists (
               select 1 from ingestion_signals prior where prior.incident_id = i.id and prior.correlation_key = $2
             ))
             or (i.service = any($3::text[]) and i.started_at between $4::timestamptz - ($5 * interval '1 minute') and $4::timestamptz + ($5 * interval '1 minute'))
           )
           order by
             case when $2::text is not null and exists (
               select 1 from ingestion_signals prior where prior.incident_id = i.id and prior.correlation_key = $2
             ) then 0 else 1 end,
             i.started_at desc limit 1`,
          [integration.organizationId, signal.correlationKey ?? null, relatedServices, signal.timestamp, policy.groupingWindowMinutes]
        );
        let incidentId = match.rows[0] ? String((match.rows[0] as Row).id) : undefined;

        const suppressed = policy.maintenanceMode || (policy.suppressLowSeverity && signal.severity === "low");
        if (!incidentId && !suppressed && signal.impactScore >= policy.incidentThreshold) {
          const code = `AUTO-${new Date(signal.timestamp).toISOString().slice(5, 16).replace(/[-T:]/g, "")}-${randomUUID().slice(0, 4).toUpperCase()}`;
          const created = await client.query(
            `insert into incidents (organization_id, code, title, summary, service, severity, status, owner, started_at)
             values ($1,$2,$3,$4,$5,$6,'investigating','Automation',$7) returning id`,
            [integration.organizationId, code, signal.title,
              `Automatically opened from ${integration.name} after ${signal.service} crossed the incident threshold.`,
              signal.service, signal.severity, signal.timestamp]
          );
          incidentId = String((created.rows[0] as Row).id);
          await client.query(
            `update ingestion_signals s set incident_id = $1
             where s.incident_id is null and s.occurred_at between $2::timestamptz - interval '30 minutes' and $2::timestamptz + interval '5 minutes'
             and (s.service = any($3::text[]) or ($4::text is not null and s.correlation_key = $4))
             and exists (select 1 from integrations x where x.id = s.integration_id and x.organization_id = $5)`,
            [incidentId, signal.timestamp, relatedServices, signal.correlationKey ?? null, integration.organizationId]
          );
          await client.query(
            `insert into incident_events (incident_id, timestamp, service, kind, title, detail, impact_score, metadata)
             select $1, s.occurred_at, s.service, s.kind, s.title, s.detail, s.impact_score,
               s.metadata || jsonb_strip_nulls(jsonb_build_object(
                 'sourceExternalId', s.external_id, 'correlationKey', s.correlation_key, 'traceId', s.trace_id,
                 'sourceUrl', s.source_url, 'environment', s.environment, 'automated', true
               ))
             from ingestion_signals s where s.incident_id = $1
             and not exists (
               select 1 from incident_events e where e.incident_id = $1 and e.metadata->>'sourceExternalId' = s.external_id
             )`,
            [incidentId]
          );
        } else if (incidentId) {
          await client.query("update ingestion_signals set incident_id = $1 where id = $2", [incidentId, signalId]);
          await client.query(
            `insert into incident_events (incident_id, timestamp, service, kind, title, detail, impact_score, metadata)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [incidentId, signal.timestamp, signal.service, signal.kind, signal.title, signal.detail, signal.impactScore, {
              ...signal.metadata, sourceExternalId: signal.externalId, correlationKey: signal.correlationKey,
              traceId: signal.traceId, sourceUrl: signal.sourceUrl, environment: signal.environment, automated: true
            }]
          );
        }

        if (incidentId) {
          incidentIds.add(incidentId);
          await client.query(
            `update incidents set updated_at = now(), status = case when $2 = 'recovery' then 'monitoring' else status end where id = $1`,
            [incidentId, signal.kind]
          );
        }
      }

      const incidentIdList = [...incidentIds];
      await client.query(
        `update ingestion_deliveries set signal_count = $2, incident_ids = $3::uuid[] where integration_id = $1 and external_id = $4`,
        [integration.id, acceptedSignals, incidentIdList, batch.externalId]
      );
      await client.query(
        `update integrations set last_delivery_at = now(), last_delivery_status = 'accepted',
         signal_count = signal_count + $2, updated_at = now() where id = $1`,
        [integration.id, acceptedSignals]
      );
      if (incidentIdList[0]) {
        await client.query(
          `insert into incident_activities (organization_id, incident_id, actor, action, detail, timestamp)
           values ($1,$2,'Connector','ingested automated evidence',$3,now())`,
          [integration.organizationId, incidentIdList[0], `${integration.name} accepted ${acceptedSignals} signal${acceptedSignals === 1 ? "" : "s"}; ${incidentIdList.length} incident${incidentIdList.length === 1 ? "" : "s"} matched.`]
        );
      }
      await client.query("commit");
      return { status: "accepted", acceptedSignals, incidentIds: incidentIdList } satisfies IngestionResult;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const repository: Repository = config.databaseUrl ? new PostgresRepository(config.databaseUrl) : new MemoryRepository();
