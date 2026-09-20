export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type EventKind = "alert" | "deploy" | "dependency" | "metric" | "action" | "recovery";

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
  citations: Array<{ code: string; title: string; incidentId: string }>;
  confidence: number;
  mode: "deterministic" | "provider";
}
