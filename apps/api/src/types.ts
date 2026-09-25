export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type EventKind = "alert" | "deploy" | "dependency" | "metric" | "action" | "recovery";
export type DecisionKind = "hypothesis" | "mitigation" | "communication";
export type DecisionStatus = "proposed" | "approved" | "rejected";
export type IntegrationProvider = "github" | "otel" | "generic";
export type IntegrationStatus = "active" | "paused";

export interface IncidentEvent {
  id: string;
  incidentId: string;
  timestamp: string;
  service: string;
  kind: EventKind;
  title: string;
  detail: string;
  impactScore: number;
  evidenceState?: "active" | "excluded" | "corrected";
  provenance?: "ingested" | "manual" | "derived";
  correctionReason?: string | null;
  correctedFromId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Incident {
  id: string;
  code: string;
  title: string;
  summary: string;
  service: string;
  environment?: string;
  customerImpact?: string;
  severity: Severity;
  status: IncidentStatus;
  owner: string;
  startedAt: string;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceRevision?: string;
  events: IncidentEvent[];
}

export interface Activity {
  id: string;
  incidentId?: string;
  actor: string;
  action: string;
  detail: string;
  timestamp: string;
}

export interface ReplayRun {
  id: string;
  incidentId: string;
  name: string;
  status: "queued" | "running" | "passed" | "failed";
  progress: number;
  createdAt: string;
  config?: ReplayConfig;
  projection?: ReplayProjection;
  evidenceVersion?: string;
  eventCount?: number;
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

export interface ReplayProjection {
  baselinePeak: number;
  projectedPeak: number;
  avoidedHighImpactEvents: number;
  recoveryGainMinutes: number;
  confidence: number;
  state: "contained" | "degraded" | "critical";
  summary: string;
  signals: string[];
  kind?: "scenario_estimate";
  target?: string;
  assumptions?: string[];
  unsupportedReasons?: string[];
}

export interface ReplayResult extends ReplayRun {
  config: ReplayConfig;
  projection: ReplayProjection;
  evidenceVersion: string;
  eventCount: number;
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
  state: "untested" | "supported" | "disproved" | "inconclusive" | "contested";
  outcomeSummary: string;
  testCount: number;
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
  evidenceStatus: "insufficient" | "partial" | "substantial";
  currentExplanation: string;
  nextAction: { label: string; reason: string; href: string };
}

export interface DashboardData {
  incidents: Incident[];
  activities: Activity[];
  replayRuns: ReplayRun[];
  serviceHealth: Array<{ service: string; availability: number; latencyMs: number; errorRate: number; state: "nominal" | "degraded" | "critical" }>;
  eventVolume: Array<{ time: string; requests: number; errors: number }>;
}

export interface SearchResult {
  incident: Incident;
  score: number;
  matchReason: string;
  matchedEventId?: string;
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
  status: IntegrationStatus;
  createdAt: string;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: IntegrationDelivery["status"] | null;
  signalCount: number;
  expectedCadenceMinutes: number;
  retentionDays: number;
  dailyQuota: number;
  healthySampleRate: number;
  acceptedToday: number;
  droppedToday: number;
  deliveries: IntegrationDelivery[];
}

export interface IntegrationTarget {
  id: string;
  organizationId: string;
  name: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
}

export interface NormalizedSignal {
  externalId: string;
  timestamp: string;
  service: string;
  kind: EventKind;
  title: string;
  detail: string;
  impactScore: number;
  severity: Severity;
  correlationKey?: string;
  traceId?: string;
  sourceUrl?: string;
  environment?: string;
  metadata: Record<string, unknown>;
}

export interface IngestionBatch {
  externalId: string;
  signals: NormalizedSignal[];
}

export interface IngestionResult {
  status: "accepted" | "queued" | "duplicate" | "rejected";
  acceptedSignals: number;
  incidentIds: string[];
  queueId?: string;
  reason?: string;
}

export type WorkspaceRole = "admin" | "responder" | "viewer";

export interface WorkspaceContext {
  organizationId: string;
  organizationName: string;
  role: WorkspaceRole;
}
export interface PrivacySettings { externalAiEnabled: boolean; captureRequestBodies: boolean; productAnalyticsEnabled: boolean; updatedAt: string }

export interface ServiceDefinition {
  id: string;
  name: string;
  ownerTeam: string;
  tier: "critical" | "standard" | "internal";
  repositoryUrl?: string | null;
  runbookUrl?: string | null;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IncidentPolicy {
  incidentThreshold: number;
  groupingWindowMinutes: number;
  suppressLowSeverity: boolean;
  maintenanceMode: boolean;
  updatedAt: string;
}

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  emailDeliveryStatus: "sent" | "manual" | "failed";
  emailedAt?: string | null;
  emailLastError?: string | null;
  expiresAt: string;
  createdAt: string;
  inviteToken?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface QueueJob {
  id: string;
  integrationId: string;
  externalId: string;
  status: "queued" | "processing" | "completed" | "retrying" | "dead_letter";
  attempts: number;
  lastError?: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MitigationRequest {
  id: string;
  incidentId: string;
  requestedBy: string;
  reviewedBy?: string | null;
  title: string;
  action: string;
  rollbackPlan: string;
  currentValue: string;
  proposedValue: string;
  blastRadius: string;
  changeOwner: string;
  observationMinutes: number;
  replayRunId: string;
  replayConfig: ReplayConfig;
  replayProjection: ReplayProjection;
  evidenceVersion: string;
  stale: boolean;
  status: "pending" | "approved" | "rejected" | "executed";
  createdAt: string;
  reviewedAt?: string | null;
}
export interface MitigationPolicy { independentApprovalRequired: true; approverRole: "admin"; minimumObservationMinutes: number; requireRollback: true; updatedAt: string }

export type HypothesisTestStatus = "planned" | "running" | "supported" | "disproved" | "inconclusive";
export interface HypothesisTest {
  id: string;
  incidentId: string;
  hypothesisId: string;
  title: string;
  instruction: string;
  assignee: string;
  status: HypothesisTestStatus;
  result: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface RecoveryVerification {
  id: string;
  incidentId: string;
  metric: string;
  targetValue: number;
  baselineValue: number;
  observedValue?: number | null;
  unit?: string;
  comparison?: "lte" | "gte";
  source?: string;
  query?: string;
  windowStartedAt?: string;
  windowEndedAt?: string;
  observedAt?: string;
  freshnessMinutes?: number;
  observationMinutes: number;
  status: "pending" | "verified" | "failed";
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export interface HttpReplaySpec {
  id: string; incidentId: string; name: string; evidenceRevision: string; applicationVersion: string;
  request: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; headers: Record<string,string>; body?: string };
  assertions: { status: number; bodyIncludes?: string };
  dependencies: Array<{ name: string; mode: "mocked" | "disabled"; fixture: string }>;
  networkPolicy: "deny_except_loopback_target"; createdAt: string;
}
export interface HttpReplayExecution {
  id: string; specId: string; incidentId: string; evidenceRevision: string;
  status: "passed" | "failed" | "unsupported"; assertionResults: Array<{ assertion: string; passed: boolean; observed: string }>;
  responseStatus?: number; responseBody?: string; durationMs?: number; nondeterministic: boolean; limitation?: string; createdAt: string;
}

export interface IncidentPostmortem {
  incidentId: string;
  summary: string;
  rootCause: string;
  impact: string;
  recovery: string;
  followUps: string;
  status: "draft" | "published";
  updatedAt: string;
}
export interface IncidentComment { id:string; incidentId:string; actor:string; body:string; eventId?:string|null; createdAt:string }

export interface ActionNotification {
  id: string;
  kind: "approval" | "ingestion" | "hypothesis";
  title: string;
  detail: string;
  incidentId?: string;
  href: string;
  createdAt: string;
  read: boolean;
  resolved: boolean;
  urgency: "normal" | "urgent";
  reason: string;
  owner?: string;
}
