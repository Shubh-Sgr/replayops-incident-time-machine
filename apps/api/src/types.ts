export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type EventKind = "alert" | "deploy" | "dependency" | "metric" | "action" | "recovery";
export type DecisionKind = "hypothesis" | "mitigation" | "communication";
export type DecisionStatus = "proposed" | "approved" | "rejected";

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
}

export interface ReplayResult extends ReplayRun {
  config: ReplayConfig;
  projection: ReplayProjection;
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
  changeCandidates: DiagnosisCandidate[];
  signalDeltas: SignalDelta[];
  hypotheses: DiagnosticHypothesis[];
  evidenceGaps: string[];
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
}
