import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { config } from "./config.js";
import { MEMBERSHIPS } from "./scope.js";
import { placeSignals, resolveEnvironment, type ServiceMapping } from "./release.js";
import { chooseIncident, incidentFacts, joinOutcome, type GroupingCandidate } from "./grouping.js";
import { changeEvidence, commitFilesLookup, resolveChange, selectChangesForIncident, type ChangeRecord, type CommitRecord, type ExtractedDelivery } from "./changes.js";
import { seedActivities, seedDashboardSeries, seedIncidents, seedReplayRuns } from "./seed.js";
import type { Activity, DashboardData, Incident, IncidentDecision, IncidentEvent, IncidentHeadline, IncidentPolicy, IngestionBatch, IngestionResult, Integration, IntegrationDelivery, IntegrationProvider, IntegrationTarget, NormalizedSignal, ReplayConfig, ReplayProjection, ReplayResult, ReplayRun, SearchResult, Severity } from "./types.js";
import { forbidden } from "./errors.js";
import { workspaceService } from "./workspace.js";

export type IncidentInput = Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events">;
export type EventInput = Omit<IncidentEvent, "id" | "incidentId">;
export type DecisionInput = Pick<IncidentDecision, "kind" | "status" | "title" | "detail">;
export type IntegrationInput = { name: string; provider: IntegrationProvider };
export type IntegrationConfigInput = { expectedCadenceMinutes: number; retentionDays: number; dailyQuota: number; healthySampleRate: number };

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
  moveEvent(userId: string, incidentId: string, eventId: string, targetIncidentId: string): Promise<IncidentEvent | null>;
  listDecisions(userId: string, incidentId: string): Promise<IncidentDecision[]>;
  createDecision(userId: string, incidentId: string, input: DecisionInput): Promise<IncidentDecision | null>;
  listReplays(userId: string, incidentId: string): Promise<ReplayResult[]>;
  runReplay(userId: string, incidentId: string, config: ReplayConfig): Promise<ReplayResult | null>;
  search(userId: string, query: string, embedding?: number[]): Promise<SearchResult[]>;
  setIncidentEmbedding(incidentId: string, embedding: number[]): Promise<void>;
  impactPreview(userId: string, threshold: number): Promise<{ atOrAbove: number; below: number }>;
  /** Earliest sighting of each exception fingerprint across the workspace's incidents and retained signals. */
  exceptionFirstSeen(userId: string, fingerprints: string[]): Promise<Map<string, string>>;
  listChanges(userId: string, filter?: { environment?: string; service?: string; limit?: number }): Promise<ChangeRecord[]>;
  /** Where and when each fingerprint has been seen, per environment, with the releases it came from. */
  exceptionHistory(userId: string, fingerprints: string[]): Promise<Map<string, ExceptionSighting[]>>;
  listIntegrations(userId: string): Promise<Integration[]>;
  createIntegration(userId: string, input: IntegrationInput): Promise<Integration>;
  updateIntegrationConfig(userId: string, integrationId: string, input: IntegrationConfigInput): Promise<Integration | null>;
  deleteIntegration(userId: string, integrationId: string): Promise<boolean>;
  /**
   * Deletes what each source's retention setting says to forget: unattached-or-not raw signals, finished queue
   * entries (they hold the original delivery) and delivery receipts. Incident timelines are the permanent copy.
   */
  purgeExpired(): Promise<{ signals: number; queueJobs: number; deliveries: number }>;
  /** Issues a new connector secret; the old one stops working immediately. Admins only. */
  rotateIntegrationToken(userId: string, integrationId: string): Promise<Integration | null>;
  getIntegrationTarget(integrationId: string): Promise<IntegrationTarget | null>;
  ingest(integration: IntegrationTarget, batch: IngestionBatch): Promise<IngestionResult>;
}

const clone = <T>(value: T): T => structuredClone(value);

export function simulateReplay(incident: Incident, config: ReplayConfig): ReplayProjection {
  const evidenceText = `${incident.title} ${incident.summary} ${incident.events.map((event) => `${event.title} ${event.detail}`).join(" ")}`;
  const applicable = /retr|concurr|queue|timeout|latency|saturat/i.test(evidenceText);
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
  const recoveryGainMinutes = 0;
  const confidence = 0;
  const state: ReplayProjection["state"] = projectedPeak <= 60 ? "contained" : projectedPeak <= 78 ? "degraded" : "critical";
  const summary = !applicable
    ? "This incident does not contain evidence that makes retry, concurrency, or timeout controls applicable. No scenario conclusion is available."
    : state === "contained"
    ? "The arithmetic scenario places the recorded propagation below the configured severity boundary; this is not an executed replay."
    : state === "degraded"
      ? "The arithmetic scenario lowers recorded pressure, but one degraded path remains. This is not an executed replay."
      : "The arithmetic scenario does not interrupt the recorded propagation path. This is not an executed replay.";

  return {
    baselinePeak,
    projectedPeak,
    avoidedHighImpactEvents,
    recoveryGainMinutes,
    confidence,
    state,
    summary,
    kind: "scenario_estimate",
    target: `${incident.service} in ${incident.environment ?? "unknown environment"}`,
    assumptions: [
      "Uses stored event severity as a relative signal, not as request-level telemetry.",
      "Assumes the selected limits apply to the affected service and remain constant for the recorded window.",
      "Does not execute application code, dependencies, or production traffic."
    ],
    unsupportedReasons: applicable ? [] : ["No retry, concurrency, queue, timeout, or latency evidence was found in this investigation."],
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
  private bufferedSignals: Array<NormalizedSignal & { integrationId: string; incidentId?: string; receivedAt?: string }> = [];
  private changes: ChangeRecord[] = [];
  private commits: CommitRecord[] = [];

  async initialize() {}

  /** Stores the delivery's commits and changes; returns the changes that are new. */
  private recordDelivery(delivery: ExtractedDelivery | undefined, policy: Pick<IncidentPolicy, "environments" | "releaseBranches">, services: ServiceMapping[]) {
    if (!delivery) return [];
    for (const commit of delivery.commits) if (!this.commits.some((item) => item.repository === commit.repository && item.sha === commit.sha)) this.commits.push(commit);
    const created: ChangeRecord[] = [];
    for (const input of delivery.changes) {
      const environment = resolveEnvironment(input.environment, policy.environments).name;
      const previousDeploys: Record<string, { sha?: string; version?: string }> = {};
      for (const change of [...this.changes].filter((item) => item.environment === environment && ["deploy", "rollback"].includes(item.kind) && item.status === "success" && item.occurredAt < input.occurredAt && (input.repository ? item.repository === input.repository : item.service === input.service)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
        previousDeploys[change.service] = { sha: change.sha, version: change.version };
      }
      for (const record of resolveChange(input, { environments: policy.environments, services, releaseBranches: policy.releaseBranches, repositoryCommits: this.commits.filter((commit) => commit.repository === input.repository), previousDeploys })) {
        if (this.changes.some((change) => change.externalId === record.externalId)) continue;
        const change = { ...record, id: randomUUID() };
        this.changes.push(change);
        created.push(change);
      }
    }
    return created;
  }

  private linkChange(incident: Incident, change: ChangeRecord, liveRelease: boolean, services: ServiceMapping[]) {
    if (incident.events.some((event) => event.metadata?.changeId === change.id)) return false;
    const evidence = changeEvidence(change, { liveRelease, incidentService: incident.service, services, afterStart: change.occurredAt > incident.startedAt });
    incident.events.push({ id: randomUUID(), incidentId: incident.id, ...evidence, evidenceState: "active", provenance: "derived" });
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString(); incident.evidenceRevision = incident.updatedAt;
    return true;
  }

  /** Links what changed to newly opened incidents, and new changes to incidents already open. */
  private async linkChanges(organizationId: string, openedIds: string[], newChanges: ChangeRecord[], services: ServiceMapping[]) {
    const touched = new Set<string>();
    for (const incident of this.incidents.filter((item) => openedIds.includes(item.id))) {
      const relatedServices = await workspaceService.relatedServicesForOrganization(organizationId, incident.service);
      for (const { change, liveRelease } of selectChangesForIncident(this.changes, { service: incident.service, relatedServices, environment: incident.environment ?? "unknown", startedAt: incident.startedAt })) if (this.linkChange(incident, change, liveRelease, services)) touched.add(incident.id);
    }
    for (const change of newChanges.filter((item) => item.status !== "failure")) {
      for (const incident of this.incidents.filter((item) => item.status !== "resolved" && item.environment === change.environment && !openedIds.includes(item.id))) {
        const relatedServices = await workspaceService.relatedServicesForOrganization(organizationId, incident.service);
        if (!relatedServices.includes(change.service)) continue;
        const selected = change.occurredAt > incident.startedAt ? [{ change, liveRelease: false }] : selectChangesForIncident([change, ...this.changes.filter((item) => item.id !== change.id)], { service: incident.service, relatedServices, environment: change.environment, startedAt: incident.startedAt }).filter((item) => item.change.id === change.id);
        for (const item of selected) if (this.linkChange(incident, item.change, item.liveRelease, services)) touched.add(incident.id);
      }
    }
    return [...touched];
  }

  async listChanges(_userId: string, filter: { environment?: string; service?: string; limit?: number } = {}) {
    return clone(this.changes.filter((change) => (!filter.environment || change.environment === filter.environment) && (!filter.service || change.service === filter.service)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, filter.limit ?? 100));
  }

  async dashboard(_userId: string): Promise<DashboardData> {
    return { incidents: clone(this.incidents), activities: clone(seedActivities), replayRuns: clone(this.replayRuns), ...clone(seedDashboardSeries) };
  }
  async listIncidents(_userId: string) { return clone(this.incidents).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summarize); }
  async getIncident(_userId: string, id: string) { return clone(this.incidents.find((incident) => incident.id === id) ?? null); }
  async createIncident(_userId: string, input: IncidentInput) {
    const now = new Date().toISOString();
    const incident: Incident = { ...input, environment: input.environment ?? "unknown", customerImpact: input.customerImpact ?? "Unknown until measured", id: randomUUID(), code: nextManualCode(this.incidents), createdAt: now, updatedAt: now, evidenceRevision: now, events: [] };
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
    const event: IncidentEvent = { ...input, evidenceState: input.evidenceState ?? "active", provenance: input.provenance ?? "manual", id: randomUUID(), incidentId };
    incident.events.push(event);
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString(); incident.evidenceRevision = incident.updatedAt;
    return clone(event);
  }
  async updateEvent(_userId: string, incidentId: string, eventId: string, input: Partial<EventInput>) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    const event = incident?.events.find((item) => item.id === eventId);
    if (!incident || !event) return null;
    Object.assign(event, input);
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString(); incident.evidenceRevision = incident.updatedAt;
    return clone(event);
  }
  async deleteEvent(_userId: string, incidentId: string, eventId: string) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return false;
    const before = incident.events.length;
    incident.events = incident.events.filter((event) => event.id !== eventId);
    incident.updatedAt = new Date().toISOString(); incident.evidenceRevision = incident.updatedAt;
    return incident.events.length < before;
  }
  async moveEvent(_userId: string, incidentId: string, eventId: string, targetIncidentId: string) {
    const source = this.incidents.find((item) => item.id === incidentId); const target = this.incidents.find((item) => item.id === targetIncidentId); const event = source?.events.find((item) => item.id === eventId);
    if (!source || !target || !event || source.id === target.id) return null;
    source.events = source.events.filter((item) => item.id !== eventId); event.incidentId = target.id; target.events.push(event); target.events.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)); const now = new Date().toISOString(); source.updatedAt=now; target.updatedAt=now; source.evidenceRevision=now; target.evidenceRevision=now; return clone(event);
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
  async listReplays(_userId: string, incidentId: string) {
    return clone(this.replayRuns.filter((run) => run.incidentId === incidentId && run.config && run.projection) as ReplayResult[]);
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
      createdAt: new Date().toISOString(),
      evidenceVersion: incident.evidenceRevision ?? incident.updatedAt,
      eventCount: incident.events.length
    };
    this.replayRuns.unshift(run);
    return clone(run);
  }
  async search(_userId: string, query: string) {
    const exact = query.trim().toLowerCase();
    const exactResults = this.incidents.flatMap((incident) => {
      const event = incident.events.find((item) => item.id.toLowerCase() === exact || String(item.metadata?.traceId ?? "").toLowerCase() === exact || String(item.metadata?.sourceExternalId ?? "").toLowerCase() === exact);
      return incident.id.toLowerCase() === exact || incident.code.toLowerCase() === exact || event
        ? [{ incident: clone(incident), score: 1, matchReason: event ? "Exact trace, source, or evidence identifier" : "Exact incident identifier", ...(event ? { matchedEventId: event.id } : {}) }]
        : [];
    });
    if (exactResults.length) return exactResults;
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
      lastDeliveryAt: null, lastDeliveryStatus: null, signalCount: 0,
      expectedCadenceMinutes: input.provider === "otel" ? 15 : input.provider === "github" ? 10080 : 180,
      retentionDays: 14, dailyQuota: 10000, healthySampleRate: .05, acceptedToday: 0, droppedToday: 0, tokenVersion: 0, deliveries: []
    };
    this.integrations.unshift(integration);
    return clone(integration);
  }
  async updateIntegrationConfig(_userId: string, integrationId: string, input: IntegrationConfigInput) {
    const integration=this.integrations.find((item)=>item.id===integrationId);if(!integration)return null;Object.assign(integration,input);return clone(integration);
  }
  async deleteIntegration(_userId: string, integrationId: string) {
    const before = this.integrations.length;
    this.integrations = this.integrations.filter((integration) => integration.id !== integrationId);
    this.bufferedSignals = this.bufferedSignals.filter((signal) => signal.integrationId !== integrationId);
    return this.integrations.length < before;
  }
  async purgeExpired() {
    const before = this.bufferedSignals.length;
    const now = Date.now();
    const retention = new Map(this.integrations.map((item) => [item.id, item.retentionDays * 86_400_000]));
    this.bufferedSignals = this.bufferedSignals.filter((signal) => now - Date.parse(signal.receivedAt ?? signal.timestamp) <= (retention.get(signal.integrationId) ?? 14 * 86_400_000));
    return { signals: before - this.bufferedSignals.length, queueJobs: 0, deliveries: 0 };
  }
  async rotateIntegrationToken(_userId: string, integrationId: string) {
    const integration = this.integrations.find((item) => item.id === integrationId);
    if (!integration) return null;
    integration.tokenVersion += 1;
    return clone(integration);
  }
  async getIntegrationTarget(integrationId: string) {
    const integration = this.integrations.find((item) => item.id === integrationId);
    return integration ? { id: integration.id, organizationId: "demo-organization", name: integration.name, provider: integration.provider, status: integration.status, healthySampleRate: integration.healthySampleRate, tokenVersion: integration.tokenVersion } : null;
  }
  async ingest(integration: IntegrationTarget, batch: IngestionBatch) {
    const policy = await workspaceService.policyForOrganization(integration.organizationId);
    const deliveryKey = `${integration.id}:${batch.externalId}`;
    if (this.deliveries.has(deliveryKey)) return { status: "duplicate", acceptedSignals: 0, incidentIds: [] } satisfies IngestionResult;
    this.deliveries.add(deliveryKey);
    const storedIntegration = this.integrations.find((item) => item.id === integration.id);
    if (storedIntegration && storedIntegration.acceptedToday + batch.signals.length > storedIntegration.dailyQuota) {
      const now=new Date().toISOString();storedIntegration.droppedToday+=batch.signals.length;storedIntegration.lastDeliveryAt=now;storedIntegration.lastDeliveryStatus="rejected";storedIntegration.deliveries.unshift({id:randomUUID(),integrationId:integration.id,externalId:batch.externalId,status:"rejected",signalCount:0,incidentIds:[],error:`Daily quota ${storedIntegration.dailyQuota} would be exceeded.`,receivedAt:now});
      return {status:"rejected",acceptedSignals:0,incidentIds:[],reason:`Daily quota ${storedIntegration.dailyQuota} would be exceeded.`} satisfies IngestionResult;
    }
    const incidentIds = new Set<string>();
    const opened: IncidentHeadline[] = [];
    const movedToMonitoring: IncidentHeadline[] = [];
    const escalatedIncidents = new Map<string, IncidentHeadline>();
    const reopened = new Map<string, ReopenedHeadline>();
    let acceptedSignals = 0;
    const services = await workspaceService.servicesForOrganization(integration.organizationId);
    const newChanges = this.recordDelivery(batch.delivery, policy, services);
    const commitFiles = commitFilesLookup(this.commits, newChanges);
    for (const placement of placeSignals(batch.signals, policy, services, commitFiles)) {
      if (placement.drop) continue;
      const signal = placement.signal;
      const relatedServices = await workspaceService.relatedServicesForOrganization(integration.organizationId, signal.service);
      if (this.bufferedSignals.some((item) => item.integrationId === integration.id && item.externalId === signal.externalId)) continue;
      const buffered: NormalizedSignal & { integrationId: string; incidentId?: string; receivedAt?: string } = { ...signal, integrationId: integration.id, receivedAt: new Date().toISOString() };
      this.bufferedSignals.push(buffered);
      acceptedSignals += 1;
      const suppressed = policy.maintenanceMode || (policy.suppressLowSeverity && signal.severity === "low");
      const context = { relatedServices, windowMinutes: policy.groupingWindowMinutes, laneOnly: Boolean(placement.laneOnly), problem: !suppressed && placement.mayOpen && signal.kind !== "recovery" && signal.impactScore >= policy.incidentThreshold };
      const keys = groupingKeys(signal, Boolean(placement.laneOnly));
      const open = this.incidents.filter((item) => item.status !== "resolved");
      const match = chooseIncident(open.map((item) => incidentFacts(item, keys, eventKeys)), signal, context);
      let incident = match ? open.find((item) => item.id === match.candidate.id) : undefined;
      const outcome = match ? joinOutcome(match.candidate, match.reason, signal, context) : undefined;
      if (!incident && context.problem) {
        const now = new Date().toISOString();
        incident = {
          id: randomUUID(), code: nextManualCode(this.incidents), title: signal.title,
          summary: `Automatically opened from ${integration.name} after ${signal.service} crossed the incident threshold.`,
          service: signal.service, environment: signal.environment ?? "unknown", customerImpact: "Unknown until measured", severity: signal.severity, status: "investigating", owner: "Automation",
          startedAt: signal.timestamp, resolvedAt: null, createdAt: now, updatedAt: now, evidenceRevision: now, events: []
        };
        this.incidents.unshift(incident);
        opened.push(headline(incident));
        const triggerTime = new Date(signal.timestamp).getTime();
        for (const precursor of this.bufferedSignals.filter((item) => !item.incidentId && !item.metadata?.laneOnly && (item.environment ?? "unknown") === (signal.environment ?? "unknown") && compatibleBranch(branchOf(item), branchOf(signal)) && relatedServices.includes(item.service) && new Date(item.timestamp).getTime() >= triggerTime - 1_800_000 && new Date(item.timestamp).getTime() <= triggerTime + 300_000)) {
          precursor.incidentId = incident.id;
          incident.events.push(signalToEvent(incident.id, precursor));
        }
      }
      if (incident && !buffered.incidentId) {
        buffered.incidentId = incident.id;
        const autoTitle = incident.owner === "Automation" && incident.events.some((event) => event.title === incident!.title && event.provenance === "ingested");
        if (!incident.events.some((event) => event.metadata?.sourceExternalId === signal.externalId)) incident.events.push(signalToEvent(incident.id, signal));
        if (signal.kind === "alert" && incident.status !== "resolved" && severityRank[signal.severity] > severityRank[incident.severity]) {
          incident.severity = signal.severity;
          if (autoTitle) incident.title = signal.title;
          const index = opened.findIndex((item) => item.id === incident!.id);
          if (index >= 0) opened[index] = headline(incident);
          else escalatedIncidents.set(incident.id, headline(incident));
        }
      }
      if (incident) {
        incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        incident.updatedAt = new Date().toISOString(); incident.evidenceRevision = incident.updatedAt;
        if (outcome?.monitoring) { incident.status = "monitoring"; movedToMonitoring.push(headline(incident)); }
        if (outcome?.reopen) incident.status = "investigating";
        if (outcome?.repage && !opened.some((item) => item.id === incident!.id)) reopened.set(incident.id, { ...headline(incident), reason: outcome.repage });
        incidentIds.add(incident.id);
      }
    }
    for (const id of await this.linkChanges(integration.organizationId, opened.map((item) => item.id), newChanges, services)) incidentIds.add(id);
    const now = new Date().toISOString();
    if (storedIntegration) {
      const delivery: IntegrationDelivery = { id: randomUUID(), integrationId: integration.id, externalId: batch.externalId, status: "accepted", signalCount: acceptedSignals, incidentIds: [...incidentIds], receivedAt: now };
      storedIntegration.lastDeliveryAt = now;
      storedIntegration.lastDeliveryStatus = "accepted";
      storedIntegration.signalCount += acceptedSignals;
      storedIntegration.acceptedToday += acceptedSignals;
      storedIntegration.deliveries.unshift(delivery);
      storedIntegration.deliveries = storedIntegration.deliveries.slice(0, 8);
    }
    return { status: "accepted", acceptedSignals, acceptedChanges: newChanges.length, incidentIds: [...incidentIds], opened, movedToMonitoring, escalated: [...escalatedIncidents.values()], reopened: [...reopened.values()] } satisfies IngestionResult;
  }
  async setIncidentEmbedding(_incidentId: string, _embedding: number[]) {}
  async exceptionHistory(_userId: string, fingerprints: string[]) {
    const rows: Array<{ fingerprint: string; environment: string; timestamp: string; release?: string }> = [];
    const add = (metadata: Record<string, unknown> | undefined, timestamp: string, environment: string | undefined) => {
      const fingerprint = exceptionFingerprintOf({ metadata });
      if (fingerprint && fingerprints.includes(fingerprint)) rows.push({ fingerprint, environment: environment ?? "unknown", timestamp, release: typeof metadata?.release === "string" ? metadata.release : undefined });
    };
    for (const incident of this.incidents) for (const event of incident.events) add(event.metadata, event.timestamp, typeof event.metadata?.environment === "string" ? event.metadata.environment : incident.environment);
    for (const signal of this.bufferedSignals) add(signal.metadata, signal.timestamp, signal.environment);
    return summarizeSightings(rows);
  }
  async exceptionFirstSeen(_userId: string, fingerprints: string[]) {
    const seen = new Map<string, string>();
    const consider = (metadata: Record<string, unknown> | undefined, timestamp: string) => {
      const fingerprint = (metadata?.exception as { fingerprint?: string } | undefined)?.fingerprint;
      if (fingerprint && fingerprints.includes(fingerprint) && (!seen.has(fingerprint) || timestamp < seen.get(fingerprint)!)) seen.set(fingerprint, timestamp);
    };
    for (const incident of this.incidents) for (const event of incident.events) consider(event.metadata, event.timestamp);
    for (const signal of this.bufferedSignals) consider(signal.metadata, signal.timestamp);
    return seen;
  }
  async impactPreview(_userId: string, threshold: number) {
    const scores = this.incidents.flatMap((incident) => incident.events.map((event) => event.impactScore));
    return { atOrAbove: scores.filter((score) => score >= threshold).length, below: scores.filter((score) => score < threshold).length };
  }
}

const headline = (incident: Pick<Incident, "id" | "code" | "title" | "summary" | "service" | "environment" | "severity" | "status">): IncidentHeadline => ({
  id: incident.id, code: incident.code, title: incident.title, summary: incident.summary, service: incident.service, environment: incident.environment, severity: incident.severity, status: incident.status
});

/**
 * A GitHub delivery lane: one workflow on one branch, or deploys to one environment. A later outcome in the
 * same lane (above all, the successful run that proves recovery) belongs to the incident its failure opened,
 * even when a responder has since set the incident's environment or the fix took longer than the grouping window.
 */
export interface ExceptionSighting { environment: string; firstSeen: string; releases: string[] }
const summarizeSightings = (rows: Array<{ fingerprint: string; environment: string; timestamp: string; release?: string }>) => {
  const history = new Map<string, ExceptionSighting[]>();
  for (const row of rows) {
    const list = history.get(row.fingerprint) ?? [];
    const existing = list.find((item) => item.environment === row.environment);
    if (existing) {
      if (row.timestamp < existing.firstSeen) existing.firstSeen = row.timestamp;
      if (row.release && !existing.releases.includes(row.release)) existing.releases.push(row.release);
    } else list.push({ environment: row.environment, firstSeen: row.timestamp, releases: row.release ? [row.release] : [] });
    history.set(row.fingerprint, list);
  }
  return history;
};
/** One failed deploy emits a failed deployment and a failed workflow run for the same commit: they are one problem. */
const githubCommitOf = (item: { metadata?: Record<string, unknown> }) => {
  const meta = item.metadata ?? {};
  return meta.provider === "github" && ["workflow_run", "deployment_status"].includes(String(meta.eventType)) && typeof meta.repository === "string" && typeof meta.sha === "string" && meta.sha ? `${meta.repository.toLowerCase()}@${meta.sha}` : undefined;
};
const exceptionFingerprintOf = (item: { metadata?: Record<string, unknown> }) => {
  const value = (item.metadata?.exception as { fingerprint?: unknown } | undefined)?.fingerprint;
  return typeof value === "string" ? value : undefined;
};
// A deployment lane is per service: in a shared repository, one service's good deploy must not recover another's failure.
export const deliveryLaneOf = (item: { service?: string; metadata?: Record<string, unknown> }) => {
  const meta = item.metadata ?? {};
  if (meta.provider !== "github") return undefined;
  const text = (value: unknown) => typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (meta.eventType === "workflow_run") return `workflow:${text(meta.repository)}:${text(meta.workflow)}:${text(meta.branch)}`;
  if (meta.eventType === "deployment_status") return `deploy:${text(meta.repository)}:${text(item.service)}:${text(meta.deploymentEnvironment).toLowerCase()}`;
  return undefined;
};
const DELIVERY_LANE_SQL = `case b.metadata->>'eventType'
  when 'workflow_run' then 'workflow:'||coalesce(b.metadata->>'repository','')||':'||coalesce(b.metadata->>'workflow','')||':'||coalesce(b.metadata->>'branch','')
  when 'deployment_status' then 'deploy:'||coalesce(b.metadata->>'repository','')||':'||coalesce(b.service,'')||':'||lower(coalesce(b.metadata->>'deploymentEnvironment','')) end`;

const RECOVERY_EVIDENCE_SQL = `(b.kind = 'recovery' or b.metadata->>'laneOnly' = 'true' or (b.metadata->>'provider' = 'github' and b.metadata->>'eventType' = 'workflow_run' and b.metadata->>'conclusion' = 'success'))`;
/** grouping.ts's facts for every open incident in a workspace, from its active ingested evidence. */
const GROUPING_FACTS_SQL = `select i.id, i.status, i.service, coalesce(i.environment,'unknown') as environment, i.started_at,
    greatest(i.started_at, coalesce(f.last_signal_at, i.started_at)) as last_signal_at, coalesce(f.recovered, false) as recovered,
    array(select distinct unnest(array_append(coalesce(f.services, '{}'::text[]), i.service))) as services,
    ($3::text is null or not coalesce(f.has_branch, false) or coalesce(f.same_branch, false)) as branch_compatible,
    coalesce(f.by_lane, false) as by_lane, coalesce(f.by_correlation, false) as by_correlation,
    coalesce(f.by_commit, false) as by_commit, coalesce(f.by_fingerprint, false) as by_fingerprint
  from incidents i
  left join lateral (
    select max(b.timestamp) as last_signal_at, array_agg(distinct b.service) as services,
      bool_or(b.metadata->>'branch' is not null) as has_branch, bool_or(b.metadata->>'branch' = $3) as same_branch,
      bool_or($2::text is not null and b.metadata->>'correlationKey' = $2) as by_correlation,
      bool_or($4::text is not null and b.metadata->>'provider' = 'github' and ${DELIVERY_LANE_SQL} = $4) as by_lane,
      bool_or($6::text is not null and b.kind = 'alert' and b.metadata->>'provider' = 'github' and b.metadata->>'eventType' in ('workflow_run','deployment_status')
        and lower(b.metadata->>'repository') || '@' || (b.metadata->>'sha') = $6) as by_commit,
      bool_or($5::text is not null and b.metadata->'exception'->>'fingerprint' = $5) as by_fingerprint,
      (array_agg(${RECOVERY_EVIDENCE_SQL} order by b.timestamp desc) filter (where b.kind = 'alert' or ${RECOVERY_EVIDENCE_SQL}))[1] as recovered
    from incident_events b where b.incident_id = i.id and b.provenance = 'ingested' and coalesce(b.evidence_state, 'active') = 'active'
  ) f on true
  where i.organization_id = $1 and i.status <> 'resolved'`;
const instant = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const mapCandidate = (row: Row): GroupingCandidate => ({
  id: String(row.id), status: row.status as GroupingCandidate["status"], service: String(row.service), environment: String(row.environment),
  startedAt: instant(row.started_at), lastSignalAt: instant(row.last_signal_at), recovered: Boolean(row.recovered),
  services: Array.isArray(row.services) ? row.services.map(String) : [], branchCompatible: Boolean(row.branch_compatible),
  byLane: Boolean(row.by_lane), byCorrelation: Boolean(row.by_correlation), byCommit: Boolean(row.by_commit), byFingerprint: Boolean(row.by_fingerprint)
});

// GitHub evidence is grouped per branch, so a failure on one branch doesn't absorb pushes and CI runs from others.
const branchOf = (item: { metadata?: Record<string, unknown> }) => typeof item.metadata?.branch === "string" && item.metadata.branch ? item.metadata.branch : undefined;
const compatibleBranch = (left?: string, right?: string) => !left || !right || left === right;
/** The identities a signal can match an open incident by. */
const groupingKeys = (signal: NormalizedSignal, laneOnly: boolean) => ({
  lane: deliveryLaneOf(signal), correlationKey: signal.correlationKey, branch: branchOf(signal),
  commit: !laneOnly && signal.kind === "alert" ? githubCommitOf(signal) : undefined,
  fingerprint: laneOnly ? undefined : exceptionFingerprintOf(signal)
});
const eventKeys = { lane: deliveryLaneOf, commit: githubCommitOf, fingerprint: exceptionFingerprintOf, branch: branchOf };
type ReopenedHeadline = IncidentHeadline & { reason: string };

const signalToEvent = (incidentId: string, signal: NormalizedSignal): IncidentEvent => ({
  id: randomUUID(), incidentId, timestamp: signal.timestamp, service: signal.service, kind: signal.kind,
  title: signal.title, detail: signal.detail, impactScore: signal.impactScore, evidenceState: "active", provenance: "ingested",
  metadata: {
    ...signal.metadata, sourceExternalId: signal.externalId, correlationKey: signal.correlationKey,
    traceId: signal.traceId, sourceUrl: signal.sourceUrl, environment: signal.environment, automated: true
  }
});

type Row = Record<string, unknown>;
const SUMMARY_EVENTS = 3;
const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const nextManualCode = (incidents: Incident[]) => `ROP-${Math.max(2000, ...incidents.map((item) => Number(/^ROP-(\d+)$/.exec(item.code)?.[1] ?? 0))) + 1}`;
const summarize = (incident: Incident): Incident => ({
  ...incident, eventCount: incident.events.length,
  eventKinds: [...new Set(incident.events.filter((event) => event.evidenceState !== "excluded").map((event) => event.kind))],
  events: [...incident.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-SUMMARY_EVENTS)
});
const mapCommit = (row: Row): CommitRecord => ({
  repository: String(row.repository), sha: String(row.sha), branch: row.branch ? String(row.branch) : undefined, message: String(row.message), author: row.author ? String(row.author) : undefined,
  url: row.url ? String(row.url) : undefined, files: Array.isArray(row.files) ? row.files.map(String) : [], committedAt: row.committed_at ? new Date(String(row.committed_at)).toISOString() : undefined,
  pushBefore: row.push_before ? String(row.push_before) : undefined, pushAfter: row.push_after ? String(row.push_after) : undefined, position: Number(row.position ?? 0)
});
const mapChange = (row: Row): ChangeRecord => ({
  id: String(row.id), kind: row.kind as ChangeRecord["kind"], status: row.status as ChangeRecord["status"], service: String(row.service), environment: String(row.environment), title: String(row.title),
  version: row.version ? String(row.version) : undefined, previousVersion: row.previous_version ? String(row.previous_version) : undefined, sha: row.sha ? String(row.sha) : undefined,
  previousSha: row.previous_sha ? String(row.previous_sha) : undefined, repository: row.repository ? String(row.repository) : undefined, author: row.author ? String(row.author) : undefined,
  url: row.url ? String(row.url) : undefined, occurredAt: new Date(String(row.occurred_at)).toISOString(), source: String(row.source), externalId: String(row.external_id),
  metadata: (row.metadata ?? {}) as Record<string, unknown>, commits: (row.commits ?? []) as ChangeRecord["commits"], files: Array.isArray(row.files) ? row.files.map(String) : []
});
const mapEvent = (row: Row): IncidentEvent => ({
  id: String(row.id), incidentId: String(row.incident_id), timestamp: new Date(String(row.timestamp)).toISOString(),
  service: String(row.service), kind: row.kind as IncidentEvent["kind"], title: String(row.title), detail: String(row.detail),
  impactScore: Number(row.impact_score),
  evidenceState: (row.evidence_state ?? "active") as IncidentEvent["evidenceState"],
  provenance: (row.provenance ?? ((row.metadata as Record<string, unknown> | undefined)?.automated ? "ingested" : "manual")) as IncidentEvent["provenance"],
  correctionReason: row.correction_reason ? String(row.correction_reason) : null,
  correctedFromId: row.corrected_from_id ? String(row.corrected_from_id) : null,
  metadata: (row.metadata ?? {}) as Record<string, unknown>
});
const mapIncident = (row: Row, events: IncidentEvent[] = []): Incident => ({
  id: String(row.id), code: String(row.code), title: String(row.title), summary: String(row.summary), service: String(row.service),
  environment: String(row.environment ?? "unknown"), customerImpact: String(row.customer_impact ?? "Unknown until measured"),
  severity: row.severity as Incident["severity"], status: row.status as Incident["status"], owner: String(row.owner),
  startedAt: new Date(String(row.started_at)).toISOString(), resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : null,
  createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  evidenceRevision: row.evidence_revision ? new Date(String(row.evidence_revision)).toISOString() : new Date(String(row.updated_at)).toISOString(), events
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
  createdAt: new Date(String(row.created_at)).toISOString(),
  ...(row.config ? { config: row.config as ReplayConfig } : {}),
  ...(row.projection ? { projection: row.projection as ReplayProjection } : {}),
  ...(row.evidence_version ? { evidenceVersion: new Date(String(row.evidence_version)).toISOString() } : {}),
  ...(row.event_count !== undefined ? { eventCount: Number(row.event_count) } : {})
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
  signalCount: Number(row.signal_count ?? 0), expectedCadenceMinutes:Number(row.expected_cadence_minutes ?? (row.provider === "otel" ? 15 : row.provider === "github" ? 10080 : 180)),
  retentionDays:Number(row.retention_days ?? 14), dailyQuota:Number(row.daily_quota ?? 10000), healthySampleRate:Number(row.healthy_sample_rate ?? .05),
  acceptedToday:Number(row.accepted_today ?? 0), droppedToday:Number(row.dropped_today ?? 0), tokenVersion:Number(row.token_version ?? 0), deliveries
});

class PostgresRepository implements Repository {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }, max: 6 });
  }
  async initialize() {
    await this.pool.query(`
      alter table incidents add column if not exists environment text not null default 'unknown';
      alter table incidents add column if not exists customer_impact text not null default 'Unknown until measured';
      alter table incidents add column if not exists evidence_revision timestamptz not null default now();
      alter table incident_events add column if not exists evidence_state text not null default 'active';
      alter table incident_events add column if not exists provenance text not null default 'manual';
      alter table incident_events add column if not exists correction_reason text;
      alter table incident_events add column if not exists corrected_from_id uuid;
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
      alter table integrations add column if not exists expected_cadence_minutes integer not null default 180;
      alter table integrations add column if not exists retention_days integer not null default 14;
      alter table integrations add column if not exists daily_quota integer not null default 10000;
      alter table integrations add column if not exists healthy_sample_rate numeric not null default 0.05;
      alter table integrations add column if not exists token_version integer not null default 0;
      alter table integrations add column if not exists accepted_today integer not null default 0;
      alter table integrations add column if not exists dropped_today integer not null default 0;
      alter table integrations add column if not exists counter_date date not null default current_date;
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
      alter table replay_runs add column if not exists config jsonb;
      alter table replay_runs add column if not exists projection jsonb;
      alter table replay_runs add column if not exists evidence_version timestamptz;
      alter table replay_runs add column if not exists event_count integer;
    `);
  }
  private async hydrated(userId: string, where = "", values: unknown[] = []) {
    const incidentResult = await this.pool.query(
      `select i.* from incidents i
       where exists (
         select 1 from ${MEMBERSHIPS} m
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
         where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = a.organization_id and m.user_id = $1)
         order by a.timestamp desc limit 20`,
        [userId]
      ),
      this.pool.query(
        `select r.* from replay_runs r
         where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = r.organization_id and m.user_id = $1)
         order by r.created_at desc limit 20`,
        [userId]
      ),
      this.pool.query(
        `select * from (
           select distinct on (s.service) s.* from service_health_snapshots s
           where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = s.organization_id and m.user_id = $1)
           order by s.service, s.observed_at desc
         ) latest order by case latest.state when 'critical' then 1 when 'degraded' then 2 else 3 end, latest.service`,
        [userId]
      ),
      this.pool.query(
        `select v.* from event_volume_samples v
         where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = v.organization_id and m.user_id = $1)
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
  /** List views get summaries: counts and kinds over all evidence, but only the latest few events. */
  async listIncidents(userId: string) {
    const result = await this.pool.query(
      `select i.*, coalesce(stats.event_count, 0) as event_count, coalesce(stats.event_kinds, '{}') as event_kinds, coalesce(latest.events, '[]'::jsonb) as latest_events
       from incidents i
       left join lateral (
         select count(*) as event_count, array_agg(distinct e.kind) filter (where coalesce(e.evidence_state, 'active') <> 'excluded') as event_kinds
         from incident_events e where e.incident_id = i.id
       ) stats on true
       left join lateral (
         select jsonb_agg(to_jsonb(recent) order by recent.timestamp) as events
         from (select * from incident_events e where e.incident_id = i.id order by e.timestamp desc limit ${SUMMARY_EVENTS}) recent
       ) latest on true
       where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1)
       order by i.started_at desc`,
      [userId]
    );
    return (result.rows as Row[]).map((row) => ({
      ...mapIncident(row, (row.latest_events as Row[]).map(mapEvent)),
      eventCount: Number(row.event_count), eventKinds: (row.event_kinds as Incident["events"][number]["kind"][]) ?? []
    }));
  }
  async getIncident(userId: string, id: string) { return (await this.hydrated(userId, "and i.id = $2", [id]))[0] ?? null; }
  async createIncident(userId: string, input: IncidentInput, embedding?: number[]) {
    // Codes are sequential per workspace (ROP-2001, ROP-2002, …), unique by (organization_id, code); a concurrent create
    // that takes the same number retries with the next one.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.pool.query(
          `with org as (select m.organization_id from ${MEMBERSHIPS} m where m.user_id = $1 limit 1),
           next_code as (
             select 'ROP-' || (greatest(coalesce(max((substring(i.code from '^ROP-([0-9]+)$'))::int), 0), 2000) + 1) as code
             from incidents i join org on org.organization_id = i.organization_id
           )
           insert into incidents (organization_id,code,title,summary,service,environment,customer_impact,severity,status,owner,started_at,resolved_at,embedding)
           select org.organization_id,next_code.code,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector from org, next_code
           returning *`,
          [userId, input.title, input.summary, input.service, input.environment ?? "unknown", input.customerImpact ?? "Unknown until measured", input.severity, input.status, input.owner, input.startedAt, input.resolvedAt ?? null, embedding ? `[${embedding.join(",")}]` : null]
        );
        const row = result.rows[0] as Row | undefined;
        if (!row) throw forbidden("No organization membership exists for this account. Complete workspace onboarding before creating incidents.");
        return mapIncident(row);
      } catch (error) {
        if ((error as { code?: string }).code !== "23505" || attempt >= 4) throw error;
      }
    }
  }

  async updateIncident(userId: string, id: string, input: Partial<IncidentInput>, embedding?: number[]) {
    const fields: Array<[string, unknown, boolean?]> = [
      ["title", input.title], ["summary", input.summary], ["service", input.service], ["environment", input.environment], ["customer_impact", input.customerImpact], ["severity", input.severity], ["status", input.status],
      ["owner", input.owner], ["started_at", input.startedAt], ["resolved_at", input.resolvedAt], ["embedding", embedding ? `[${embedding.join(",")}]` : undefined, true]
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown, boolean?]>;
    if (!fields.length) return this.getIncident(userId, id);
    const values = [userId, ...fields.map((entry) => entry[1])];
    const sets = fields.map(([key, , vector], index) => `${key} = $${index + 2}${vector ? "::vector" : ""}`);
    values.push(id);
    await this.pool.query(
      `update incidents i set ${sets.join(", ")}, updated_at = now()
       where i.id = $${values.length}
       and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1)`,
      values
    );
    return this.getIncident(userId, id);
  }
  async deleteIncident(userId: string, id: string) {
    return (await this.pool.query(
      `delete from incidents i where i.id = $2
       and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1 and m.role = 'admin')`,
      [userId, id]
    )).rowCount === 1;
  }
  async createEvent(userId: string, incidentId: string, input: EventInput) {
    if (!await this.getIncident(userId, incidentId)) return null;
    const result = await this.pool.query(`insert into incident_events (incident_id,timestamp,service,kind,title,detail,impact_score,evidence_state,provenance,correction_reason,corrected_from_id,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`, [incidentId, input.timestamp, input.service, input.kind, input.title, input.detail, input.impactScore, input.evidenceState ?? "active", input.provenance ?? "manual", input.correctionReason ?? null, input.correctedFromId ?? null, input.metadata ?? {}]);
    await this.pool.query("update incidents set updated_at=now(),evidence_revision=now() where id=$1", [incidentId]);
    const row = result.rows[0] as Row | undefined;
    return row ? mapEvent(row) : null;
  }
  async updateEvent(userId: string, incidentId: string, eventId: string, input: Partial<EventInput>) {
    const fields = [["timestamp", input.timestamp], ["service", input.service], ["kind", input.kind], ["title", input.title], ["detail", input.detail], ["impact_score", input.impactScore], ["evidence_state", input.evidenceState], ["provenance", input.provenance], ["correction_reason", input.correctionReason], ["corrected_from_id", input.correctedFromId], ["metadata", input.metadata]].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (!fields.length) return null;
    const values = [userId, ...fields.map((entry) => entry[1])];
    const sets = fields.map(([key], index) => `${key} = $${index + 2}`);
    values.push(incidentId, eventId);
    const result = await this.pool.query(
      `update incident_events e set ${sets.join(", ")}
       where e.incident_id = $${values.length - 1} and e.id = $${values.length}
       and exists (
         select 1 from incidents i join ${MEMBERSHIPS} m on m.organization_id = i.organization_id
         where i.id = e.incident_id and m.user_id = $1
       ) returning e.*`,
      values
    );
    const row = result.rows[0] as Row | undefined;
    if (row) await this.pool.query("update incidents set updated_at=now(),evidence_revision=now() where id=$1", [incidentId]);
    return row ? mapEvent(row) : null;
  }
  async deleteEvent(userId: string, incidentId: string, eventId: string) {
    const result = await this.pool.query(
      `delete from incident_events e where e.incident_id = $2 and e.id = $3
       and exists (
         select 1 from incidents i join ${MEMBERSHIPS} m on m.organization_id = i.organization_id
         where i.id = e.incident_id and m.user_id = $1
       )`,
      [userId, incidentId, eventId]
    );
    if (result.rowCount === 1) await this.pool.query("update incidents set updated_at=now(),evidence_revision=now() where id=$1", [incidentId]);
    return result.rowCount === 1;
  }
  async moveEvent(userId: string, incidentId: string, eventId: string, targetIncidentId: string) {
    const client = await this.pool.connect();
    try { await client.query("begin"); const result = await client.query(
      `update incident_events e set incident_id=$4 where e.id=$3 and e.incident_id=$2
       and exists(select 1 from incidents s join ${MEMBERSHIPS} m on m.organization_id=s.organization_id where s.id=$2 and m.user_id=$1)
       and exists(select 1 from incidents t join ${MEMBERSHIPS} m on m.organization_id=t.organization_id where t.id=$4 and m.user_id=$1 and t.organization_id=(select organization_id from incidents where id=$2)) returning e.*`,
      [userId, incidentId, eventId, targetIncidentId]
    ); const row=result.rows[0] as Row|undefined; if (!row) { await client.query("rollback"); return null; }
      await client.query(`update ingestion_signals set incident_id=$2 where incident_id=$1 and external_id=$3`, [incidentId,targetIncidentId,(row.metadata as Record<string,unknown>|undefined)?.sourceExternalId ?? ""]);
      await client.query(`update incidents set updated_at=now(),evidence_revision=now() where id=any($1::uuid[])`, [[incidentId,targetIncidentId]]); await client.query("commit"); return mapEvent(row);
    } catch(error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async listDecisions(userId: string, incidentId: string) {
    const result = await this.pool.query(
      `select a.* from incident_activities a
       where a.incident_id = $2 and a.action like '[decision:%'
       and exists (
         select 1 from incidents i join ${MEMBERSHIPS} m on m.organization_id = i.organization_id
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
       from incidents i join ${MEMBERSHIPS} m on m.organization_id = i.organization_id
       where i.id = $2 and m.user_id = $1
       returning *`,
      [userId, incidentId, action, input.detail]
    );
    const row = result.rows[0] as Row | undefined;
    return row ? mapDecision(row) : null;
  }
  async listReplays(userId: string, incidentId: string) {
    const result = await this.pool.query(
      `select r.* from replay_runs r
       where r.incident_id=$2 and r.config is not null and r.projection is not null
       and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id=r.organization_id and m.user_id=$1)
       order by r.created_at desc limit 30`,
      [userId, incidentId]
    );
    return (result.rows as Row[]).map((row) => mapReplayRun(row) as ReplayResult);
  }
  async runReplay(userId: string, incidentId: string, config: ReplayConfig) {
    const incident = await this.getIncident(userId, incidentId);
    if (!incident) return null;
    const projection = simulateReplay(incident, config);
    const name = `Retry ${config.retryCeiling} · cap ${config.concurrencyCap} · ${config.timeoutMs}ms · ${new Date().toISOString().slice(11, 19)}`;
    const status = projection.state === "critical" ? "failed" : "passed";
    const result = await this.pool.query(
      `insert into replay_runs (organization_id, incident_id, name, status, progress, config, projection, evidence_version, event_count)
       select i.organization_id, i.id, $3, $4, 100, $5, $6, i.evidence_revision, $7
       from incidents i join ${MEMBERSHIPS} m on m.organization_id = i.organization_id
       where i.id = $2 and m.user_id = $1
       returning *`,
      [userId, incidentId, name, status, config, projection, incident.events.length]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return { ...mapReplayRun(row), config, projection, evidenceVersion: incident.evidenceRevision ?? incident.updatedAt, eventCount: incident.events.length } satisfies ReplayResult;
  }
  async exceptionHistory(userId: string, fingerprints: string[]) {
    if (!fingerprints.length) return new Map<string, ExceptionSighting[]>();
    const result = await this.pool.query(
      `select fingerprint, environment, seen_at, release from (
         select e.metadata->'exception'->>'fingerprint' as fingerprint, coalesce(e.metadata->>'environment', i.environment, 'unknown') as environment, e.timestamp as seen_at, e.metadata->>'release' as release
         from incident_events e join incidents i on i.id = e.incident_id
         where e.metadata->'exception'->>'fingerprint' = any($2::text[])
           and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1)
         union all
         select s.metadata->'exception'->>'fingerprint', coalesce(s.environment, 'unknown'), s.occurred_at, s.metadata->>'release'
         from ingestion_signals s join integrations x on x.id = s.integration_id
         where s.metadata->'exception'->>'fingerprint' = any($2::text[])
           and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = x.organization_id and m.user_id = $1)
       ) sightings`,
      [userId, fingerprints]
    );
    return summarizeSightings((result.rows as Row[]).map((row) => ({ fingerprint: String(row.fingerprint), environment: String(row.environment), timestamp: new Date(String(row.seen_at)).toISOString(), release: row.release ? String(row.release) : undefined })));
  }
  async exceptionFirstSeen(userId: string, fingerprints: string[]) {
    if (!fingerprints.length) return new Map<string, string>();
    const result = await this.pool.query(
      `select fingerprint, min(seen_at) as first_seen from (
         select e.metadata->'exception'->>'fingerprint' as fingerprint, e.timestamp as seen_at
         from incident_events e join incidents i on i.id = e.incident_id
         where e.metadata->'exception'->>'fingerprint' = any($2::text[])
           and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1)
         union all
         select s.metadata->'exception'->>'fingerprint', s.occurred_at
         from ingestion_signals s join integrations x on x.id = s.integration_id
         where s.metadata->'exception'->>'fingerprint' = any($2::text[])
           and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = x.organization_id and m.user_id = $1)
       ) sightings group by fingerprint`,
      [userId, fingerprints]
    );
    return new Map((result.rows as Row[]).map((row) => [String(row.fingerprint), new Date(String(row.first_seen)).toISOString()]));
  }
  async impactPreview(userId: string, threshold: number) {
    const result = await this.pool.query(
      `select count(*) filter (where e.impact_score >= $2) as at_or_above, count(*) filter (where e.impact_score < $2) as below
       from incident_events e join incidents i on i.id = e.incident_id
       where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1)`,
      [userId, threshold]
    );
    const row = result.rows[0] as Row;
    return { atOrAbove: Number(row.at_or_above ?? 0), below: Number(row.below ?? 0) };
  }
  async setIncidentEmbedding(incidentId: string, embedding: number[]) {
    await this.pool.query(`update incidents set embedding = $2::vector where id = $1`, [incidentId, `[${embedding.join(",")}]`]);
  }
  async search(userId: string, query: string, embedding?: number[]) {
    const exactResult = await this.pool.query(
      `select distinct on (i.id) i.*, e.id as matched_event_id
       from incidents i
       join ${MEMBERSHIPS} m on m.organization_id=i.organization_id and m.user_id=$1
       left join incident_events e on e.incident_id=i.id and (
         lower(e.id::text)=lower($2) or lower(coalesce(e.metadata->>'traceId',''))=lower($2)
         or lower(coalesce(e.metadata->>'sourceExternalId',''))=lower($2)
       )
       where lower(i.id::text)=lower($2) or lower(i.code)=lower($2) or e.id is not null
       order by i.id,i.updated_at desc limit 6`,
      [userId, query.trim()]
    );
    if (exactResult.rows.length) {
      const hydratedExact = await Promise.all((exactResult.rows as Row[]).map((row) => this.getIncident(userId, String(row.id))));
      return hydratedExact.flatMap((incident, index) => incident ? [{ incident, score: 1, matchReason: (exactResult.rows[index] as Row).matched_event_id ? "Exact trace, source, or evidence identifier" : "Exact incident identifier", ...((exactResult.rows[index] as Row).matched_event_id ? { matchedEventId:String((exactResult.rows[index] as Row).matched_event_id) } : {}) }] : []);
    }
    let result = embedding
      ? await this.pool.query(
        `select i.*, 1 - (i.embedding <=> $2::vector) as score from incidents i
         where i.embedding is not null
         and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = i.organization_id and m.user_id = $1)
         order by i.embedding <=> $2::vector limit 6`,
        [userId, `[${embedding.join(",")}]`]
      )
      : { rows: [] as Row[] };
    let matchReason = "Semantic similarity across incident evidence";
    if (!result.rows.length) {
      const ignored = new Set(["about", "after", "again", "against", "could", "evidence", "from", "incident", "most", "next", "only", "recorded", "responder", "should", "that", "this", "using", "what", "when", "where", "which", "with", "would"]);
      const terms = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((term) => !ignored.has(term)))].slice(0, 12);
      const patterns = (terms.length ? terms : [query.trim().toLowerCase()]).map((term) => `%${term}%`);
      result = await this.pool.query(
        `select i.*,
           case when lower(concat_ws(' ',i.code,i.title,i.summary,i.service)) like any($2::text[]) then 0.68 else 0.52 end as score
         from incidents i
         where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id=i.organization_id and m.user_id=$1)
         and (
           lower(concat_ws(' ',i.code,i.title,i.summary,i.service)) like any($2::text[])
           or exists (
             select 1 from incident_events e where e.incident_id=i.id
             and lower(concat_ws(' ',e.title,e.detail,e.service,e.kind)) like any($2::text[])
           )
         )
         order by score desc,i.updated_at desc limit 6`,
        [userId, patterns]
      );
      matchReason = embedding
        ? "Lexical evidence fallback because matching incidents do not yet have embeddings"
        : "Full-text match across incident and timeline evidence";
    }
    const hydrated = await Promise.all((result.rows as Row[]).map((row) => this.getIncident(userId, String(row.id))));
    return hydrated.flatMap((incident, index) => incident ? [{ incident, score: Number((result.rows[index] as Row | undefined)?.score ?? 0), matchReason }] : []);
  }
  async listIntegrations(userId: string) {
    const integrations = await this.pool.query(
      `select x.*,case when x.counter_date=current_date then x.accepted_today else 0 end as accepted_today,case when x.counter_date=current_date then x.dropped_today else 0 end as dropped_today from integrations x
       where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = x.organization_id and m.user_id = $1)
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
      `insert into integrations (organization_id, created_by, name, provider, expected_cadence_minutes)
       select m.organization_id, $1, $2, $3, case when $3='otel' then 15 when $3='github' then 10080 else 180 end from ${MEMBERSHIPS} m
       where m.user_id = $1 and m.role in ('admin', 'responder')
       order by m.created_at desc limit 1 returning *`,
      [userId, input.name, input.provider]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw forbidden("A responder workspace is required before a connector can be created.");
    return mapIntegration(row);
  }
  async updateIntegrationConfig(userId:string,integrationId:string,input:IntegrationConfigInput){const result=await this.pool.query(`update integrations x set expected_cadence_minutes=$3,retention_days=$4,daily_quota=$5,healthy_sample_rate=$6,updated_at=now() where x.id=$2 and exists(select 1 from ${MEMBERSHIPS} m where m.organization_id=x.organization_id and m.user_id=$1 and m.role in ('admin','responder')) returning *`,[userId,integrationId,input.expectedCadenceMinutes,input.retentionDays,input.dailyQuota,input.healthySampleRate]);return result.rows[0]?mapIntegration(result.rows[0] as Row):null;}
  async deleteIntegration(userId: string, integrationId: string) {
    return (await this.pool.query(
      `delete from integrations x where x.id = $2
       and exists (
         select 1 from ${MEMBERSHIPS} m
         where m.organization_id = x.organization_id and m.user_id = $1 and m.role = 'admin'
       )`,
      [userId, integrationId]
    )).rowCount === 1;
  }
  async purgeExpired() {
    const expired = (table: string, column: string, extra = "") => this.pool.query(
      `delete from ${table} t using integrations x where x.id = t.integration_id and t.${column} < now() - make_interval(days => x.retention_days)${extra}`
    ).then((result) => result.rowCount ?? 0);
    return {
      signals: await expired("ingestion_signals", "created_at"),
      // Only finished entries: a queued or retrying delivery still has work to do.
      queueJobs: await expired("ingestion_queue", "updated_at", " and t.status in ('completed','dead_letter')"),
      deliveries: await expired("ingestion_deliveries", "received_at")
    };
  }

  async rotateIntegrationToken(userId: string, integrationId: string) {
    const result = await this.pool.query(
      `update integrations x set token_version = token_version + 1, updated_at = now() where x.id = $2
       and exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = x.organization_id and m.user_id = $1 and m.role = 'admin')
       returning x.*`,
      [userId, integrationId]
    );
    return result.rows[0] ? mapIntegration(result.rows[0] as Row) : null;
  }

  async getIntegrationTarget(integrationId: string) {
    const result = await this.pool.query("select id, organization_id, name, provider, status, healthy_sample_rate, token_version from integrations where id = $1", [integrationId]);
    const row = result.rows[0] as Row | undefined;
    return row ? {
      id: String(row.id), organizationId: String(row.organization_id), name: String(row.name),
      provider: row.provider as IntegrationTarget["provider"], status: row.status as IntegrationTarget["status"],
      healthySampleRate: Number(row.healthy_sample_rate ?? .05), tokenVersion: Number(row.token_version ?? 0)
    } : null;
  }
  /** Stores the delivery's commits and changes (inside the ingest transaction); returns the changes that are new. */
  /** The stored commits a batch's GitHub signals ran on (the commit itself, or the push it headed). */
  private async commitsForSignals(client: PoolClient, organizationId: string, signals: NormalizedSignal[]) {
    const shas = [...new Set(signals.filter((signal) => signal.metadata?.provider === "github" && typeof signal.metadata.sha === "string").map((signal) => String(signal.metadata.sha)))];
    if (!shas.length) return [];
    return ((await client.query(`select * from repository_commits where organization_id = $1 and (sha = any($2) or push_after = any($2)) limit 500`, [organizationId, shas])).rows as Row[]).map(mapCommit);
  }

  private async recordDelivery(client: PoolClient, organizationId: string, delivery: ExtractedDelivery | undefined, policy: Pick<IncidentPolicy, "environments" | "releaseBranches">, services: ServiceMapping[]) {
    if (!delivery) return [];
    for (const commit of delivery.commits) {
      await client.query(
        `insert into repository_commits (organization_id, repository, sha, branch, message, author, url, files, committed_at, push_before, push_after, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
        [organizationId, commit.repository, commit.sha, commit.branch ?? null, commit.message, commit.author ?? null, commit.url ?? null, commit.files, commit.committedAt ?? null, commit.pushBefore ?? null, commit.pushAfter ?? null, commit.position]
      );
    }
    const created: ChangeRecord[] = [];
    for (const input of delivery.changes) {
      const environment = resolveEnvironment(input.environment, policy.environments).name;
      const previousDeploys: Record<string, { sha?: string; version?: string }> = {};
      for (const row of (await client.query(
        `select distinct on (service) service, sha, version from change_events where organization_id = $1 and environment = $2 and kind in ('deploy','rollback') and status = 'success' and occurred_at < $3
         and (($4::text is not null and repository = $4) or ($4::text is null and service = $5)) order by service, occurred_at desc`,
        [organizationId, environment, input.occurredAt, input.repository ?? null, input.service ?? null]
      )).rows as Row[]) previousDeploys[String(row.service)] = { sha: row.sha ? String(row.sha) : undefined, version: row.version ? String(row.version) : undefined };
      const repositoryCommits = input.repository ? ((await client.query(
        `select * from repository_commits where organization_id = $1 and repository = $2 order by created_at desc limit 3000`, [organizationId, input.repository]
      )).rows as Row[]).map(mapCommit) : [];
      for (const record of resolveChange(input, { environments: policy.environments, services, releaseBranches: policy.releaseBranches, repositoryCommits, previousDeploys })) {
        const inserted = await client.query(
          `insert into change_events (organization_id, service, environment, kind, status, title, version, previous_version, sha, previous_sha, repository, author, url, occurred_at, commits, files, source, external_id, metadata)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) on conflict (organization_id, external_id) do nothing returning *`,
          [organizationId, record.service, record.environment, record.kind, record.status, record.title, record.version ?? null, record.previousVersion ?? null, record.sha ?? null, record.previousSha ?? null,
            record.repository ?? null, record.author ?? null, record.url ?? null, record.occurredAt, JSON.stringify(record.commits), record.files, record.source, record.externalId, record.metadata]
        );
        if (inserted.rows[0]) created.push(mapChange(inserted.rows[0] as Row));
      }
    }
    return created;
  }

  private async linkChange(client: PoolClient, incident: { id: string; service: string; startedAt: string }, change: ChangeRecord, liveRelease: boolean, services: ServiceMapping[]) {
    const evidence = changeEvidence(change, { liveRelease, incidentService: incident.service, services, afterStart: change.occurredAt > incident.startedAt });
    const inserted = await client.query(
      `insert into incident_events (incident_id, timestamp, service, kind, title, detail, impact_score, provenance, metadata)
       select $1,$2,$3,$4,$5,$6,$7,'derived',$8 where not exists (select 1 from incident_events where incident_id = $1 and metadata->>'changeId' = $9)`,
      [incident.id, evidence.timestamp, evidence.service, evidence.kind, evidence.title, evidence.detail, evidence.impactScore, evidence.metadata, change.id]
    );
    if (inserted.rowCount) await client.query(`update incidents set updated_at = now(), evidence_revision = now() where id = $1`, [incident.id]);
    return Boolean(inserted.rowCount);
  }

  /** Links what changed to newly opened incidents, and new changes to incidents already open. */
  private async linkChanges(client: PoolClient, organizationId: string, openedIds: string[], newChanges: ChangeRecord[], services: ServiceMapping[]) {
    const touched = new Set<string>();
    const scopeOf = (row: Row) => ({ id: String(row.id), service: String(row.service), environment: String(row.environment ?? "unknown"), startedAt: new Date(String(row.started_at)).toISOString() });
    if (openedIds.length) {
      for (const incident of ((await client.query(`select id, service, environment, started_at from incidents where id = any($1::uuid[])`, [openedIds])).rows as Row[]).map(scopeOf)) {
        if (incident.environment === "unknown") continue;
        const relatedServices = await workspaceService.relatedServicesForOrganization(organizationId, incident.service);
        const candidates = ((await client.query(
          `select * from change_events where organization_id = $1 and environment = $2 and service = any($3::text[]) and occurred_at <= $4 and occurred_at >= $4::timestamptz - interval '180 days' order by occurred_at desc limit 300`,
          [organizationId, incident.environment, relatedServices, incident.startedAt]
        )).rows as Row[]).map(mapChange);
        for (const { change, liveRelease } of selectChangesForIncident(candidates, { ...incident, relatedServices })) if (await this.linkChange(client, incident, change, liveRelease, services)) touched.add(incident.id);
      }
    }
    for (const change of newChanges.filter((item) => item.status !== "failure")) {
      const open = ((await client.query(`select id, service, environment, started_at from incidents where organization_id = $1 and status <> 'resolved' and environment = $2`, [organizationId, change.environment])).rows as Row[]).map(scopeOf).filter((incident) => !openedIds.includes(incident.id));
      for (const incident of open) {
        const relatedServices = await workspaceService.relatedServicesForOrganization(organizationId, incident.service);
        if (!relatedServices.includes(change.service)) continue;
        let liveRelease = false;
        if (change.occurredAt <= incident.startedAt) {
          // A change that reached us late but happened before the incident: link it if it is the live release or recent.
          const others = ((await client.query(`select * from change_events where organization_id = $1 and environment = $2 and service = $3 and occurred_at <= $4 and id <> $5 order by occurred_at desc limit 50`, [organizationId, change.environment, change.service, incident.startedAt, change.id])).rows as Row[]).map(mapChange);
          const selected = selectChangesForIncident([change, ...others], { ...incident, relatedServices }).find((item) => item.change.id === change.id);
          if (!selected) continue;
          liveRelease = selected.liveRelease;
        }
        if (await this.linkChange(client, incident, change, liveRelease, services)) touched.add(incident.id);
      }
    }
    return [...touched];
  }

  async listChanges(userId: string, filter: { environment?: string; service?: string; limit?: number } = {}) {
    const result = await this.pool.query(
      `select c.* from change_events c where exists (select 1 from ${MEMBERSHIPS} m where m.organization_id = c.organization_id and m.user_id = $1)
       and ($2::text is null or c.environment = $2) and ($3::text is null or c.service = $3) order by c.occurred_at desc limit $4`,
      [userId, filter.environment ?? null, filter.service ?? null, Math.min(500, filter.limit ?? 100)]
    );
    return (result.rows as Row[]).map(mapChange);
  }

  async ingest(integration: IntegrationTarget, batch: IngestionBatch) {
    const policy = await workspaceService.policyForOrganization(integration.organizationId);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Lock the source first. Inserting the delivery takes a key-share lock on it through the foreign key, so
      // taking this lock afterwards let two concurrent deliveries to one source deadlock.
      const sourceConfig=await client.query(`select daily_quota,retention_days,case when counter_date=current_date then accepted_today else 0 end as accepted_today from integrations where id=$1 for update`,[integration.id]);
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

      const sourceRow=sourceConfig.rows[0] as Row|undefined;
      if(sourceRow && Number(sourceRow.accepted_today)+batch.signals.length>Number(sourceRow.daily_quota)){
        const reason=`Daily quota ${Number(sourceRow.daily_quota)} would be exceeded.`;
        await client.query(`update ingestion_deliveries set status='rejected',error=$3 where integration_id=$1 and external_id=$2`,[integration.id,batch.externalId,reason]);
        await client.query(`update integrations set counter_date=current_date,accepted_today=case when counter_date=current_date then accepted_today else 0 end,dropped_today=case when counter_date=current_date then dropped_today+$2 else $2 end,last_delivery_at=now(),last_delivery_status='rejected',updated_at=now() where id=$1`,[integration.id,batch.signals.length]);
        await client.query("commit");return {status:"rejected",acceptedSignals:0,incidentIds:[],reason} satisfies IngestionResult;
      }

      const incidentIds = new Set<string>();
      const opened: IncidentHeadline[] = [];
      const movedToMonitoring: IncidentHeadline[] = [];
      const escalatedIncidents = new Map<string, IncidentHeadline>();
      const reopened = new Map<string, ReopenedHeadline>();
      let acceptedSignals = 0;
      const services = await workspaceService.servicesForOrganization(integration.organizationId);
      const newChanges = await this.recordDelivery(client, integration.organizationId, batch.delivery, policy, services);
      const commitFiles = commitFilesLookup(await this.commitsForSignals(client, integration.organizationId, batch.signals), newChanges);
      for (const placement of placeSignals(batch.signals, policy, services, commitFiles)) {
        if (placement.drop) continue;
        const signal = placement.signal;
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

        const suppressed = policy.maintenanceMode || (policy.suppressLowSeverity && signal.severity === "low");
        const context = { relatedServices, windowMinutes: policy.groupingWindowMinutes, laneOnly: Boolean(placement.laneOnly), problem: !suppressed && placement.mayOpen && signal.kind !== "recovery" && signal.impactScore >= policy.incidentThreshold };
        const keys = groupingKeys(signal, Boolean(placement.laneOnly));
        const candidates = await client.query(GROUPING_FACTS_SQL, [integration.organizationId, keys.correlationKey ?? null, keys.branch ?? null, keys.lane ?? null, keys.fingerprint ?? null, keys.commit ?? null]);
        const match = chooseIncident((candidates.rows as Row[]).map(mapCandidate), signal, context);
        const outcome = match ? joinOutcome(match.candidate, match.reason, signal, context) : undefined;
        let incidentId = match?.candidate.id;

        if (!incidentId && !suppressed && placement.mayOpen && signal.impactScore >= policy.incidentThreshold) {
          // Same sequence as incidents opened by hand (ROP-2001, ROP-2002, …). A concurrent open that takes the same
          // number rolls back to the savepoint and takes the next one, without failing the whole delivery.
          let created: Row | undefined;
          for (let attempt = 0; !created; attempt += 1) {
            await client.query("savepoint incident_code");
            try {
              created = (await client.query(
                `insert into incidents (organization_id, code, title, summary, service, environment, customer_impact, severity, status, owner, started_at)
                 select $1, 'ROP-' || (greatest(coalesce(max((substring(i.code from '^ROP-([0-9]+)$'))::int), 0), 2000) + 1), $2,$3,$4,$5,'Unknown until measured',$6,'investigating','Automation',$7
                 from incidents i where i.organization_id = $1 returning id, code`,
                [integration.organizationId, signal.title,
                  `Automatically opened from ${integration.name} after ${signal.service} crossed the incident threshold.`,
                  signal.service, signal.environment ?? "unknown", signal.severity, signal.timestamp]
              )).rows[0] as Row;
              await client.query("release savepoint incident_code");
            } catch (error) {
              await client.query("rollback to savepoint incident_code");
              if ((error as { code?: string }).code !== "23505" || attempt >= 4) throw error;
            }
          }
          incidentId = String(created.id);
          const code = String(created.code);
          opened.push({ id: incidentId, code, title: signal.title, summary: `Automatically opened from ${integration.name} after ${signal.service} crossed the incident threshold.`, service: signal.service, environment: signal.environment ?? "unknown", severity: signal.severity, status: "investigating" });
          await client.query(
            `update ingestion_signals s set incident_id = $1
             where s.incident_id is null and coalesce(s.metadata->>'laneOnly', '') <> 'true' and s.occurred_at between $2::timestamptz - interval '30 minutes' and $2::timestamptz + interval '5 minutes'
             and coalesce(s.environment,'unknown')=coalesce($6::text,'unknown')
             and ($7::text is null or s.metadata->>'branch' is null or s.metadata->>'branch' = $7)
             and (s.service = any($3::text[]) or ($4::text is not null and s.correlation_key = $4))
             and exists (select 1 from integrations x where x.id = s.integration_id and x.organization_id = $5)`,
            [incidentId, signal.timestamp, relatedServices, signal.correlationKey ?? null, integration.organizationId, signal.environment ?? "unknown", branchOf(signal) ?? null]
          );
          await client.query(
            `insert into incident_events (incident_id, timestamp, service, kind, title, detail, impact_score, provenance, metadata)
             select $1, s.occurred_at, s.service, s.kind, s.title, s.detail, s.impact_score, 'ingested',
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
            `insert into incident_events (incident_id, timestamp, service, kind, title, detail, impact_score, provenance, metadata)
             values ($1,$2,$3,$4,$5,$6,$7,'ingested',$8)`,
            [incidentId, signal.timestamp, signal.service, signal.kind, signal.title, signal.detail, signal.impactScore, {
              ...signal.metadata, sourceExternalId: signal.externalId, correlationKey: signal.correlationKey,
              traceId: signal.traceId, sourceUrl: signal.sourceUrl, environment: signal.environment, automated: true
            }]
          );
          // A clearly worse alert joining an open incident raises its severity; an automatic title follows it.
          const escalated = await client.query(
            `update incidents i set severity = $2,
               title = case when i.owner = 'Automation' and exists (select 1 from incident_events e where e.incident_id = i.id and e.title = i.title and e.provenance = 'ingested') then $3 else i.title end
             where i.id = $1 and i.status <> 'resolved' and $4 = 'alert'
               and (case i.severity when 'low' then 0 when 'medium' then 1 when 'high' then 2 else 3 end) < (case $2::text when 'low' then 0 when 'medium' then 1 when 'high' then 2 else 3 end)
             returning id, code, title, summary, service, environment, severity, status`,
            [incidentId, signal.severity, signal.title, signal.kind]
          );
          const raised = escalated.rows[0] as Row | undefined;
          if (raised) {
            const headline: IncidentHeadline = { id: String(raised.id), code: String(raised.code), title: String(raised.title), summary: String(raised.summary), service: String(raised.service), environment: raised.environment ? String(raised.environment) : undefined, severity: raised.severity as Severity, status: raised.status as IncidentHeadline["status"] };
            const alreadyOpened = opened.findIndex((item) => item.id === headline.id);
            if (alreadyOpened >= 0) opened[alreadyOpened] = headline;
            else escalatedIncidents.set(headline.id, headline);
            await client.query(
              `insert into incident_activities (organization_id, incident_id, actor, action, detail, timestamp) values ($1,$2,'Connector','escalated severity',$3,now())`,
              [integration.organizationId, headline.id, `Raised to ${signal.severity} by “${signal.title}”.`]
            );
          }
        }

        if (incidentId) {
          incidentIds.add(incidentId);
          const touched = await client.query(
            `with previous as (select status from incidents where id = $1)
             update incidents set updated_at = now(), evidence_revision=now(), status = case when $2 then 'monitoring' when $3 then 'investigating' else status end where id = $1
             returning id, code, title, summary, service, environment, severity, status, (select status from previous) as previous_status`,
            [incidentId, Boolean(outcome?.monitoring), Boolean(outcome?.reopen)]
          );
          const row = touched.rows[0] as Row | undefined;
          const current = row ? { id: String(row.id), code: String(row.code), title: String(row.title), summary: String(row.summary), service: String(row.service), environment: row.environment ? String(row.environment) : undefined, severity: row.severity as Severity, status: row.status as IncidentHeadline["status"] } : undefined;
          if (current && current.status === "monitoring" && row!.previous_status !== "monitoring" && !opened.some((item) => item.id === incidentId)) movedToMonitoring.push(current);
          if (current && outcome?.repage && !opened.some((item) => item.id === incidentId)) {
            reopened.set(current.id, { ...current, reason: outcome.repage });
            await client.query(
              `insert into incident_activities (organization_id, incident_id, actor, action, detail, timestamp) values ($1,$2,'Connector',$3,$4,now())`,
              [integration.organizationId, current.id, outcome.reopen ? "reopened incident" : "problem fired again", `${outcome.repage} “${signal.title}”.`]
            );
          }
        }
      }

      for (const id of await this.linkChanges(client, integration.organizationId, opened.map((item) => item.id), newChanges, services)) incidentIds.add(id);
      const incidentIdList = [...incidentIds];
      await client.query(
        `update ingestion_deliveries set signal_count = $2, incident_ids = $3::uuid[] where integration_id = $1 and external_id = $4`,
        [integration.id, acceptedSignals, incidentIdList, batch.externalId]
      );
      await client.query(
        `update integrations set last_delivery_at = now(), last_delivery_status = 'accepted',
         signal_count = signal_count + $2,counter_date=current_date,accepted_today=case when counter_date=current_date then accepted_today+$2 else $2 end,dropped_today=case when counter_date=current_date then dropped_today else 0 end, updated_at = now() where id = $1`,
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
      return { status: "accepted", acceptedSignals, acceptedChanges: newChanges.length, incidentIds: incidentIdList, opened, movedToMonitoring, escalated: [...escalatedIncidents.values()], reopened: [...reopened.values()] } satisfies IngestionResult;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const repository: Repository = config.databaseUrl ? new PostgresRepository(config.databaseUrl) : new MemoryRepository();
