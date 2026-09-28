import { supabase } from "./supabase";
import { encodeDemoSessionToken } from "./demoSession";
import { ApiError, describeApiError } from "./apiErrors";
import type { ActionNotification, AssistantResponse, AuditEntry, CaseworkSnapshot, ChangeProposal, DashboardData, EvidenceBundle, HttpReplayExecution, HttpReplaySpec, HypothesisTest, HypothesisTestStatus, Incident, IncidentComment, IncidentDecision, IncidentDiagnosis, IncidentEvent, IncidentPolicy, IncidentPostmortem, IngestionResult, Integration, IntegrationProvider, InvestigationCheck, InvestigationCheckStatus, InvestigationIntelligence, MitigationRequest, PrivacySettings, ProposalReview, QueueJob, RecoveryCriterion, RecoveryVerification, ReplayConfig, ReplayResult, SearchResult, ServiceDefinition, TeamInvitation, TeamMember, TypedMeasurement, ValidationArtifact, WorkspaceContext, WorkspaceRole } from "../types";

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8787/api").replace(/\/$/, "");

async function accessToken() {
  if (localStorage.getItem("replayops-demo-session")) {
    try {
      const identity = JSON.parse(localStorage.getItem("replayops-local-session") ?? "null") as { id?: unknown; email?: unknown } | null;
      if (identity && typeof identity.id === "string" && typeof identity.email === "string") return encodeDemoSessionToken({ id: identity.id, email: identity.email });
    } catch {
      // Older demo sessions did not preserve an identity. The API maps this fallback to the operator persona.
    }
    return "demo-session";
  }
  return (await supabase?.auth.getSession())?.data.session?.access_token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers
      }
    });
  } catch {
    throw new Error(`Cannot reach the ReplayOps API at ${API_URL}. Check that the API server is running and VITE_API_URL is correct.`);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "The service returned an unreadable error." }));
    throw new ApiError(describeApiError(payload), response.status, response.headers.get("x-request-id") ?? payload?.requestId ?? null);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  dashboard: () => request<DashboardData>("/dashboard"),
  incidents: () => request<Incident[]>("/incidents"),
  incident: (id: string) => request<Incident>(`/incidents/${id}`),
  diagnosis: (id: string) => request<IncidentDiagnosis>(`/incidents/${id}/diagnosis`),
  intelligence: (id: string) => request<InvestigationIntelligence>(`/incidents/${id}/intelligence`),
  casework:(id:string)=>request<CaseworkSnapshot>(`/incidents/${id}/casework`),
  acknowledgeEvidence:(id:string)=>request<{evidenceRevision:string;reviewedAt:string}>(`/incidents/${id}/evidence-review`,{method:"POST"}),
  createCheck:(id:string,input:Omit<InvestigationCheck,"id"|"incidentId"|"result"|"status"|"evidenceRevision"|"conclusionState"|"createdAt"|"updatedAt">)=>request<InvestigationCheck>(`/incidents/${id}/checks`,{method:"POST",body:JSON.stringify(input)}),
  updateCheck:(incidentId:string,checkId:string,input:{status:InvestigationCheckStatus;result:string;evidenceIds:string[]})=>request<InvestigationCheck>(`/incidents/${incidentId}/checks/${checkId}`,{method:"PATCH",body:JSON.stringify(input)}),
  createProposal:(id:string,input:{title:string;change:string;rollbackPlan:string;target:Record<string,unknown>})=>request<ChangeProposal>(`/incidents/${id}/proposals`,{method:"POST",body:JSON.stringify(input)}),
  addValidation:(id:string,input:{proposalId:string;kind:ValidationArtifact["kind"];status:ValidationArtifact["status"];summary:string;provenance:Record<string,unknown>})=>request<ValidationArtifact>(`/incidents/${id}/validations`,{method:"POST",body:JSON.stringify(input)}),
  requestProposalReview:(incidentId:string,proposalId:string)=>request<ProposalReview>(`/incidents/${incidentId}/proposals/${proposalId}/review-request`,{method:"POST"}),
  reviewProposal:(incidentId:string,reviewId:string,input:{status:"approved"|"rejected";reason:string})=>request<ProposalReview>(`/incidents/${incidentId}/proposal-reviews/${reviewId}`,{method:"PATCH",body:JSON.stringify(input)}),
  createRecoveryCriterion:(id:string,input:Omit<RecoveryCriterion,"id"|"incidentId"|"version"|"createdAt">)=>request<RecoveryCriterion>(`/incidents/${id}/recovery-criteria`,{method:"POST",body:JSON.stringify(input)}),
  addMeasurement:(id:string,input:Omit<TypedMeasurement,"id"|"incidentId"|"createdAt">)=>request<TypedMeasurement>(`/incidents/${id}/measurements`,{method:"POST",body:JSON.stringify(input)}),
  transitionIncident:(id:string,input:{action:"start_monitoring"|"resolve"|"reopen";reason:string;expectedEvidenceRevision:string})=>request<Incident>(`/incidents/${id}/lifecycle`,{method:"POST",body:JSON.stringify(input)}),
  evidenceBundle: (id: string) => request<EvidenceBundle>(`/incidents/${id}/evidence-bundle`, { method: "POST" }),
  createIncident: (incident: Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events">) => request<Incident>("/incidents", { method: "POST", body: JSON.stringify(incident) }),
  updateIncident: (id: string, incident: Partial<Incident>) => request<Incident>(`/incidents/${id}`, { method: "PATCH", body: JSON.stringify(incident) }),
  deleteIncident: (id: string) => request<void>(`/incidents/${id}`, { method: "DELETE" }),
  createEvent: (incidentId: string, event: Omit<IncidentEvent, "id" | "incidentId">) => request<IncidentEvent>(`/incidents/${incidentId}/events`, { method: "POST", body: JSON.stringify(event) }),
  incidentEvents:(incidentId:string,cursor?:string,limit=100)=>request<{items:IncidentEvent[];nextCursor:string|null;total:number;evidenceRevision:string}>(`/incidents/${incidentId}/events?limit=${limit}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`),
  updateEvent: (incidentId: string, eventId: string, event: Partial<IncidentEvent>) => request<IncidentEvent>(`/incidents/${incidentId}/events/${eventId}`, { method: "PATCH", body: JSON.stringify(event) }),
  deleteEvent: (incidentId: string, eventId: string) => request<void>(`/incidents/${incidentId}/events/${eventId}`, { method: "DELETE" }),
  moveEvent: (incidentId: string, eventId: string, targetIncidentId: string) => request<IncidentEvent>(`/incidents/${incidentId}/events/${eventId}/move`, { method: "POST", body: JSON.stringify({ targetIncidentId }) }),
  decisions: (incidentId: string) => request<IncidentDecision[]>(`/incidents/${incidentId}/decisions`),
  createDecision: (incidentId: string, decision: Pick<IncidentDecision, "kind" | "status" | "title" | "detail">) => request<IncidentDecision>(`/incidents/${incidentId}/decisions`, { method: "POST", body: JSON.stringify(decision) }),
  runReplay: (incidentId: string, config: ReplayConfig) => request<ReplayResult>(`/incidents/${incidentId}/replays`, { method: "POST", body: JSON.stringify(config) }),
  replays: (incidentId: string) => request<ReplayResult[]>(`/incidents/${incidentId}/replays`),
  httpReplays: (incidentId: string) => request<{ specs: HttpReplaySpec[]; executions: HttpReplayExecution[] }>(`/incidents/${incidentId}/http-replays`),
  createHttpReplay: (incidentId: string, input: Pick<HttpReplaySpec,"name"|"applicationVersion"|"request"|"assertions"|"dependencies">) => request<HttpReplaySpec>(`/incidents/${incidentId}/http-replays`, { method:"POST", body:JSON.stringify(input) }),
  executeHttpReplay: (id: string) => request<HttpReplayExecution>(`/http-replays/${id}/execute`, { method:"POST" }),
  search: (query: string) => request<SearchResult[]>("/search", { method: "POST", body: JSON.stringify({ query }) }),
  ask: (question: string, incidentId?: string, scope?: "incident" | "workspace") => request<AssistantResponse>("/assistant", { method: "POST", body: JSON.stringify({ question, incidentId, scope }) }),
  integrations: () => request<Integration[]>("/integrations"),
  createIntegration: (input: { name: string; provider: IntegrationProvider }) => request<Integration>("/integrations", { method: "POST", body: JSON.stringify(input) }),
  updateIntegrationConfig: (id:string,input:Pick<Integration,"expectedCadenceMinutes"|"retentionDays"|"dailyQuota"|"healthySampleRate">)=>request<Integration>(`/integrations/${id}/config`,{method:"PATCH",body:JSON.stringify(input)}),
  deleteIntegration: (id: string) => request<void>(`/integrations/${id}`, { method: "DELETE" }),
  testIntegration: (id: string) => request<IngestionResult>(`/integrations/${id}/test`, { method: "POST" }),
  workspace: () => request<WorkspaceContext>("/workspace"),
  privacySettings:()=>request<PrivacySettings>("/privacy-settings"),
  updatePrivacySettings:(input:Omit<PrivacySettings,"updatedAt">)=>request<PrivacySettings>("/privacy-settings",{method:"PATCH",body:JSON.stringify(input)}),
  recordProductOutcome:(event:string,detail:Record<string,string|number|boolean|null>={})=>request<{recorded:boolean}>("/product-outcomes",{method:"POST",body:JSON.stringify({event,detail})}),
  productOutcomes:()=>request<AuditEntry[]>("/product-outcomes"),
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
  notifications: () => request<ActionNotification[]>("/notifications"),
  updateNotification: (id:string,input:{read?:boolean;resolved?:boolean})=>request<{notificationId:string;read:boolean;resolved:boolean}>(`/notifications/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify(input)}),
  queue: () => request<QueueJob[]>("/ingestion-queue"),
  retryQueueJob: (id: string) => request<QueueJob>(`/ingestion-queue/${id}/retry`, { method: "POST" }),
  mitigations: (incidentId: string) => request<MitigationRequest[]>(`/incidents/${incidentId}/mitigations`),
  requestMitigation: (incidentId: string, input: Pick<MitigationRequest, "replayRunId" | "title" | "action" | "rollbackPlan"|"currentValue"|"proposedValue"|"blastRadius"|"changeOwner"|"observationMinutes">) => request<MitigationRequest>(`/incidents/${incidentId}/mitigations`, { method: "POST", body: JSON.stringify(input) }),
  reviewMitigation: (id: string, status: "approved" | "rejected") => request<MitigationRequest>(`/mitigations/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  hypothesisTests: (incidentId: string) => request<HypothesisTest[]>(`/incidents/${incidentId}/hypothesis-tests`),
  createHypothesisTest: (incidentId: string, input: Pick<HypothesisTest, "hypothesisId" | "title" | "instruction" | "assignee">) => request<HypothesisTest>(`/incidents/${incidentId}/hypothesis-tests`, { method: "POST", body: JSON.stringify(input) }),
  updateHypothesisTest: (id: string, status: HypothesisTestStatus, result: string) => request<HypothesisTest>(`/hypothesis-tests/${id}`, { method: "PATCH", body: JSON.stringify({ status, result }) }),
  recoveries: (incidentId: string) => request<RecoveryVerification[]>(`/incidents/${incidentId}/recovery`),
  saveRecovery: (incidentId: string, input: Omit<RecoveryVerification, "id" | "incidentId" | "createdAt" | "updatedAt" | "status" | "freshnessMinutes">) => request<RecoveryVerification>(`/incidents/${incidentId}/recovery`, { method: "POST", body: JSON.stringify(input) }),
  postmortem: (incidentId: string) => request<IncidentPostmortem | null>(`/incidents/${incidentId}/postmortem`),
  savePostmortem: (incidentId: string, input: Omit<IncidentPostmortem, "incidentId" | "updatedAt">) => request<IncidentPostmortem>(`/incidents/${incidentId}/postmortem`, { method: "PUT", body: JSON.stringify(input) })
  , comments:(incidentId:string)=>request<IncidentComment[]>(`/incidents/${incidentId}/comments`)
  , createComment:(incidentId:string,input:{body:string;eventId?:string|null})=>request<IncidentComment>(`/incidents/${incidentId}/comments`,{method:"POST",body:JSON.stringify(input)})
};
