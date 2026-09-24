export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type EventKind = "alert" | "deploy" | "dependency" | "metric" | "action" | "recovery";
export type DecisionKind = "hypothesis" | "mitigation" | "communication";
export type DecisionStatus = "proposed" | "approved" | "rejected";
export type IntegrationProvider = "github" | "otel" | "generic";

export interface IncidentEvent {
  id: string;
  incidentId: string;
  timestamp: string;
  service: string;
  kind: EventKind;
  title: string;
  detail: string;
  impactScore: number;
  metadata?: Record<string, unknown>;
}

export interface Incident {
  id: string;
  code: string;
  title: string;
  summary: string;
  service: string;
  severity: Severity;
  status: IncidentStatus;
  owner: string;
  startedAt: string;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  events: IncidentEvent[];
}

export interface IncidentDecision {
  id: string;
  incidentId: string;
  actor: string;
  kind: DecisionKind;
  status: DecisionStatus;
  title: string;
  detail: string;
  timestamp: string;
}

export interface ReplayConfig {
  retryCeiling: number;
  concurrencyCap: number;
  timeoutMs: number;
}

export interface ReplayResult {
  id: string;
  incidentId: string;
  name: string;
  status: "queued" | "running" | "passed" | "failed";
  progress: number;
  createdAt: string;
  evidenceVersion: string;
  eventCount: number;
  config: ReplayConfig;
  projection: {
    baselinePeak: number;
    projectedPeak: number;
    avoidedHighImpactEvents: number;
    recoveryGainMinutes: number;
    confidence: number;
    state: "contained" | "degraded" | "critical";
    summary: string;
    signals: string[];
  };
}

export interface DiagnosisCandidate {
  eventId: string;
  title: string;
  service: string;
  kind: EventKind;
  leadTimeSeconds: number;
  score: number;
  reason: string;
}

export interface SignalDelta {
  dimension: "service" | "event kind";
  value: string;
  beforeImpact: number;
  failureImpact: number;
  change: number;
  score: number;
}

export interface DiagnosticHypothesis {
  id: string;
  rank: number;
  title: string;
  claim: string;
  confidence: number;
  supportingEvidence: string[];
  conflictingEvidence: string[];
  nextTest: string;
  safeAction: string;
}

export interface IncidentDiagnosis {
  incidentId: string;
  generatedAt: string;
  symptomEventId?: string;
  originService?: string;
  servicePath: string[];
  confidence: number;
  evidenceCompleteness: number;
  causalConfidence: number;
  scoreExplanation: string[];
  changeCandidates: DiagnosisCandidate[];
  signalDeltas: SignalDelta[];
  hypotheses: DiagnosticHypothesis[];
  evidenceGaps: string[];
}

export interface DashboardData {
  incidents: Incident[];
  activities: Array<{ id: string; incidentId?: string; actor: string; action: string; detail: string; timestamp: string }>;
  replayRuns: Array<{ id: string; incidentId: string; name: string; status: "queued" | "running" | "passed" | "failed"; progress: number; createdAt: string }>;
  serviceHealth: Array<{ service: string; availability: number; latencyMs: number; errorRate: number; state: "nominal" | "degraded" | "critical" }>;
  eventVolume: Array<{ time: string; requests: number; errors: number }>;
}

export interface SearchResult {
  incident: Incident;
  score: number;
  matchReason: string;
}

export interface AssistantResponse {
  answer: string;
  citations: Array<{ code: string; title: string; incidentId: string; eventIds: string[]; excerpt: string }>;
  confidence: number;
  mode: "deterministic" | "provider";
  providerModel?: string;
  providerError?: string;
  redactions: number;
  evidenceBoundary: string;
}

export interface IntegrationDelivery {
  id: string;
  integrationId: string;
  externalId: string;
  status: "accepted" | "duplicate" | "rejected" | "failed";
  signalCount: number;
  incidentIds: string[];
  error?: string | null;
  receivedAt: string;
}

export interface Integration {
  id: string;
  name: string;
  provider: IntegrationProvider;
  status: "active" | "paused";
  createdAt: string;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: IntegrationDelivery["status"] | null;
  signalCount: number;
  deliveries: IntegrationDelivery[];
  connector: {
    endpoint: string;
    token: string;
    githubSecret?: string;
    otlpHeaders?: string;
  };
}

export interface IngestionResult {
  status: "accepted" | "queued" | "duplicate";
  acceptedSignals: number;
  incidentIds: string[];
  queueId?: string;
}

export type WorkspaceRole = "admin" | "responder" | "viewer";
export interface WorkspaceContext { organizationId: string; organizationName: string; role: WorkspaceRole }
export interface ServiceDefinition { id: string; name: string; ownerTeam: string; tier: "critical" | "standard" | "internal"; repositoryUrl?: string | null; runbookUrl?: string | null; dependencies: string[]; createdAt: string; updatedAt: string }
export interface IncidentPolicy { incidentThreshold: number; groupingWindowMinutes: number; suppressLowSeverity: boolean; maintenanceMode: boolean; updatedAt: string }
export interface TeamMember { userId: string; email: string; displayName: string; role: WorkspaceRole; joinedAt: string }
export interface TeamInvitation { id: string; email: string; role: WorkspaceRole; status: "pending" | "accepted" | "revoked" | "expired"; emailDeliveryStatus: "sent" | "manual" | "failed"; emailedAt?: string | null; emailLastError?: string | null; expiresAt: string; createdAt: string; inviteToken?: string }
export interface AuditEntry { id: string; actor: string; action: string; targetType: string; targetId?: string | null; detail: Record<string, unknown>; createdAt: string }
export interface QueueJob { id: string; integrationId: string; externalId: string; status: "queued" | "processing" | "completed" | "retrying" | "dead_letter"; attempts: number; lastError?: string | null; nextAttemptAt: string; createdAt: string; updatedAt: string }
export interface MitigationRequest { id: string; incidentId: string; requestedBy: string; reviewedBy?: string | null; title: string; action: string; rollbackPlan: string; replayRunId: string; replayConfig: ReplayConfig; replayProjection: ReplayResult["projection"]; evidenceVersion: string; stale: boolean; status: "pending" | "approved" | "rejected" | "executed"; createdAt: string; reviewedAt?: string | null }
export type HypothesisTestStatus = "planned" | "running" | "supported" | "disproved" | "inconclusive";
export interface HypothesisTest { id: string; incidentId: string; hypothesisId: string; title: string; instruction: string; assignee: string; status: HypothesisTestStatus; result: string; createdAt: string; updatedAt: string; completedAt?: string | null }
export interface RecoveryVerification { id: string; incidentId: string; metric: string; targetValue: number; baselineValue: number; observedValue?: number | null; observationMinutes: number; status: "pending" | "verified" | "failed"; reason: string; createdAt: string; updatedAt: string }
export interface IncidentPostmortem { incidentId: string; summary: string; rootCause: string; impact: string; recovery: string; followUps: string; status: "draft" | "published"; updatedAt: string }
export interface ActionNotification { id: string; kind: "approval" | "ingestion" | "hypothesis"; title: string; detail: string; incidentId?: string; href: string; createdAt: string }
