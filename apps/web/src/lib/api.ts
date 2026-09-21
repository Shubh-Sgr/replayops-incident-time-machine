import { supabase } from "./supabase";
import type { AssistantResponse, AuditEntry, DashboardData, Incident, IncidentDecision, IncidentDiagnosis, IncidentEvent, IncidentPolicy, IngestionResult, Integration, IntegrationProvider, MitigationRequest, QueueJob, ReplayConfig, ReplayResult, SearchResult, ServiceDefinition, TeamInvitation, TeamMember, WorkspaceContext, WorkspaceRole } from "../types";

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8787/api").replace(/\/$/, "");

async function accessToken() {
  if (localStorage.getItem("replayops-demo-session")) return "demo-session";
  return (await supabase?.auth.getSession())?.data.session?.access_token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "The service returned an unreadable error." }));
    throw new Error(payload.error ?? "The request could not be completed.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  dashboard: () => request<DashboardData>("/dashboard"),
  incidents: () => request<Incident[]>("/incidents"),
  incident: (id: string) => request<Incident>(`/incidents/${id}`),
  diagnosis: (id: string) => request<IncidentDiagnosis>(`/incidents/${id}/diagnosis`),
  createIncident: (incident: Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events">) => request<Incident>("/incidents", { method: "POST", body: JSON.stringify(incident) }),
  updateIncident: (id: string, incident: Partial<Incident>) => request<Incident>(`/incidents/${id}`, { method: "PATCH", body: JSON.stringify(incident) }),
  deleteIncident: (id: string) => request<void>(`/incidents/${id}`, { method: "DELETE" }),
  createEvent: (incidentId: string, event: Omit<IncidentEvent, "id" | "incidentId">) => request<IncidentEvent>(`/incidents/${incidentId}/events`, { method: "POST", body: JSON.stringify(event) }),
  updateEvent: (incidentId: string, eventId: string, event: Partial<IncidentEvent>) => request<IncidentEvent>(`/incidents/${incidentId}/events/${eventId}`, { method: "PATCH", body: JSON.stringify(event) }),
  deleteEvent: (incidentId: string, eventId: string) => request<void>(`/incidents/${incidentId}/events/${eventId}`, { method: "DELETE" }),
  decisions: (incidentId: string) => request<IncidentDecision[]>(`/incidents/${incidentId}/decisions`),
  createDecision: (incidentId: string, decision: Pick<IncidentDecision, "kind" | "status" | "title" | "detail">) => request<IncidentDecision>(`/incidents/${incidentId}/decisions`, { method: "POST", body: JSON.stringify(decision) }),
  runReplay: (incidentId: string, config: ReplayConfig) => request<ReplayResult>(`/incidents/${incidentId}/replays`, { method: "POST", body: JSON.stringify(config) }),
  search: (query: string) => request<SearchResult[]>("/search", { method: "POST", body: JSON.stringify({ query }) }),
  ask: (question: string, incidentId?: string) => request<AssistantResponse>("/assistant", { method: "POST", body: JSON.stringify({ question, incidentId }) }),
  integrations: () => request<Integration[]>("/integrations"),
  createIntegration: (input: { name: string; provider: IntegrationProvider }) => request<Integration>("/integrations", { method: "POST", body: JSON.stringify(input) }),
  deleteIntegration: (id: string) => request<void>(`/integrations/${id}`, { method: "DELETE" }),
  testIntegration: (id: string) => request<IngestionResult>(`/integrations/${id}/test`, { method: "POST" }),
  workspace: () => request<WorkspaceContext>("/workspace"),
  services: () => request<ServiceDefinition[]>("/services"),
  saveService: (input: Pick<ServiceDefinition, "name" | "ownerTeam" | "tier" | "repositoryUrl" | "runbookUrl" | "dependencies">) => request<ServiceDefinition>("/services", { method: "POST", body: JSON.stringify(input) }),
  incidentPolicy: () => request<IncidentPolicy>("/incident-policy"),
  updateIncidentPolicy: (input: Omit<IncidentPolicy, "updatedAt">) => request<IncidentPolicy>("/incident-policy", { method: "PATCH", body: JSON.stringify(input) }),
  teamMembers: () => request<TeamMember[]>("/team/members"),
  updateMemberRole: (id: string, role: WorkspaceRole) => request<TeamMember>(`/team/members/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  invitations: () => request<TeamInvitation[]>("/team/invitations"),
  createInvitation: (email: string, role: WorkspaceRole) => request<TeamInvitation>("/team/invitations", { method: "POST", body: JSON.stringify({ email, role }) }),
  acceptInvitation: (token: string) => request<{ organizationName: string; role: WorkspaceRole }>("/team/invitations/accept", { method: "POST", body: JSON.stringify({ token }) }),
  audit: () => request<AuditEntry[]>("/audit"),
  queue: () => request<QueueJob[]>("/ingestion-queue"),
  retryQueueJob: (id: string) => request<QueueJob>(`/ingestion-queue/${id}/retry`, { method: "POST" }),
  mitigations: (incidentId: string) => request<MitigationRequest[]>(`/incidents/${incidentId}/mitigations`),
  requestMitigation: (incidentId: string, input: Pick<MitigationRequest, "title" | "action" | "rollbackPlan">) => request<MitigationRequest>(`/incidents/${incidentId}/mitigations`, { method: "POST", body: JSON.stringify(input) }),
  reviewMitigation: (id: string, status: "approved" | "rejected") => request<MitigationRequest>(`/mitigations/${id}`, { method: "PATCH", body: JSON.stringify({ status }) })
};
