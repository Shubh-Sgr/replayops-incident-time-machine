import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { semanticAuditForRequest } from "./auditEvents.js";
import { z } from "zod";
import { answerQuestion, embedText } from "./ai.js";
import type { AuthenticatedRequest } from "./auth.js";
import { diagnoseIncident } from "./diagnosis.js";
import { config } from "./config.js";
import { deriveIntegrationToken } from "./ingestion.js";
import { repository } from "./repository.js";
import type { IngestionBatch, Integration } from "./types.js";
import { ingestionQueue } from "./queue.js";
import { workspaceService } from "./workspace.js";
import { buildEvidenceBundle, buildInvestigationIntelligence } from "./intelligence.js";
import { httpReplayService } from "./httpReplay.js";
import { caseworkService } from "./casework.js";
import { HttpError } from "./errors.js";
import { alertEventTypes, alertService } from "./alerts.js";
import { groupIncidentErrors } from "./exceptions.js";
import { alertEmailConfigured } from "./mailer.js";
import { apiTokenService, tokenMayWrite } from "./apiTokens.js";

const severity = z.enum(["critical", "high", "medium", "low"]);
const status = z.enum(["investigating", "identified", "monitoring", "resolved"]);
const eventKind = z.enum(["alert", "deploy", "dependency", "metric", "action", "recovery"]);
const decisionKind = z.enum(["hypothesis", "mitigation", "communication"]);
const decisionStatus = z.enum(["proposed", "approved", "rejected"]);

const incidentSchema = z.object({
  title: z.string().min(4).max(120),
  summary: z.string().min(12).max(800),
  service: z.string().min(2).max(80),
  environment: z.string().min(2).max(80).optional(),
  customerImpact: z.string().min(4).max(800).optional(),
  severity,
  status,
  owner: z.string().min(2).max(80),
  startedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable().optional()
});

const eventSchema = z.object({
  timestamp: z.string().datetime(),
  service: z.string().min(2).max(80),
  kind: eventKind,
  title: z.string().min(3).max(140),
  detail: z.string().min(8).max(1200),
  impactScore: z.number().min(0).max(100),
  evidenceState: z.enum(["active", "excluded", "corrected"]).optional(),
  provenance: z.enum(["ingested", "manual", "derived"]).optional(),
  correctionReason: z.string().min(4).max(800).nullable().optional(),
  correctedFromId: z.string().min(1).max(160).nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

const decisionSchema = z.object({
  kind: decisionKind,
  status: decisionStatus,
  title: z.string().min(4).max(120),
  detail: z.string().min(8).max(800)
});

const replaySchema = z.object({
  retryCeiling: z.number().int().min(1).max(4),
  concurrencyCap: z.number().int().min(5).max(50),
  timeoutMs: z.number().int().min(500).max(5000)
});
const integrationSchema = z.object({
  name: z.string().min(3).max(80),
  provider: z.enum(["github", "otel", "generic"])
});
const integrationConfigSchema=z.object({expectedCadenceMinutes:z.number().int().min(1).max(43200),retentionDays:z.number().int().min(1).max(90),dailyQuota:z.number().int().min(100).max(1000000),healthySampleRate:z.number().min(.001).max(.25)});
const serviceSchema = z.object({
  name: z.string().min(2).max(80), ownerTeam: z.string().min(2).max(80), tier: z.enum(["critical", "standard", "internal"]),
  repositoryUrl: z.string().url().nullable().optional(), runbookUrl: z.string().url().nullable().optional(), dependencies: z.array(z.string().min(2).max(80)).max(30)
});
const policySchema = z.object({ incidentThreshold: z.number().int().min(1).max(100), groupingWindowMinutes: z.number().int().min(5).max(1440), suppressLowSeverity: z.boolean(), maintenanceMode: z.boolean() });
const roleSchema = z.enum(["admin", "responder", "viewer"]);
const inviteSchema = z.object({ email: z.string().email(), role: roleSchema });
const mitigationSchema = z.object({ replayRunId: z.string().uuid(), title: z.string().min(4).max(120), action: z.string().min(12).max(1200), rollbackPlan: z.string().min(12).max(1200),currentValue:z.string().min(2).max(500),proposedValue:z.string().min(2).max(500),blastRadius:z.string().min(4).max(800),changeOwner:z.string().min(2).max(160),observationMinutes:z.number().int().min(5).max(1440) });
const mitigationReviewSchema = z.object({ status: z.enum(["approved", "rejected"]) });
const hypothesisTestSchema = z.object({ hypothesisId: z.string().min(2).max(160), title: z.string().min(4).max(180), instruction: z.string().min(8).max(1600), assignee: z.string().min(2).max(160) });
const hypothesisOutcomeSchema = z.object({
  status: z.enum(["planned", "running", "supported", "disproved", "inconclusive"]),
  result: z.string().max(2000)
}).superRefine((value, context) => {
  if (["supported", "disproved", "inconclusive"].includes(value.status) && value.result.trim().length < 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["result"], message: "Record the observation or evidence behind a completed test outcome." });
  }
});
const recoverySchema = z.object({
  metric: z.string().min(2).max(160), unit: z.string().min(1).max(40), comparison: z.enum(["lte", "gte"]),
  targetValue: z.number(), baselineValue: z.number(), observedValue: z.number(), observationMinutes: z.number().int().min(1).max(10080),
  source: z.string().min(2).max(240), query: z.string().min(2).max(2000),
  windowStartedAt: z.string().datetime(), windowEndedAt: z.string().datetime(), observedAt: z.string().datetime(),
  reason: z.string().min(8).max(1600)
}).refine((value) => Date.parse(value.windowEndedAt) > Date.parse(value.windowStartedAt), { path: ["windowEndedAt"], message: "Observation window must end after it starts." });
const postmortemSchema = z.object({ summary: z.string().max(4000), rootCause: z.string().max(4000), impact: z.string().max(4000), recovery: z.string().max(4000), followUps: z.string().max(4000), status: z.enum(["draft", "published"]) });
const httpReplaySchema = z.object({
  name:z.string().min(4).max(160), applicationVersion:z.string().min(1).max(160),
  request:z.object({ method:z.enum(["GET","POST","PUT","PATCH","DELETE"]), path:z.string().startsWith("/").max(1200), headers:z.record(z.string()).default({}), body:z.string().max(64000).optional() }),
  assertions:z.object({ status:z.number().int().min(100).max(599), bodyIncludes:z.string().max(1000).optional() }),
  dependencies:z.array(z.object({ name:z.string().min(1).max(160), mode:z.enum(["mocked","disabled"]), fixture:z.string().max(16000) })).max(30)
});
// Evidence IDs are checked for membership in the incident rather than format: demo events use readable IDs.
const evidenceId=z.string().min(1).max(160);
const unknownEvidence=(incident:{events:Array<{id:string}>},ids:Array<string|null|undefined>)=>ids.filter((id):id is string=>Boolean(id)&&!incident.events.some((event)=>event.id===id));
const checkSchema=z.object({templateId:z.string().min(2).max(80),title:z.string().min(4).max(180),question:z.string().min(8).max(1000),method:z.string().min(8).max(2000),expectedSignal:z.string().min(8).max(1200),conditions:z.string().min(4).max(1200),assignee:z.string().min(2).max(160),evidenceIds:z.array(evidenceId).max(100).default([])});
const checkResultSchema=z.object({status:z.enum(["planned","running","supported","disproved","inconclusive"]),result:z.string().max(4000),evidenceIds:z.array(evidenceId).max(100).default([])}).superRefine((value,context)=>{if(["supported","disproved","inconclusive"].includes(value.status)&&value.result.trim().length<8)context.addIssue({code:z.ZodIssueCode.custom,path:["result"],message:"Record the observed result and conditions."});});
const proposalSchema=z.object({title:z.string().min(4).max(180),change:z.string().min(12).max(4000),rollbackPlan:z.string().min(12).max(4000),target:z.record(z.unknown())});
const validationSchema=z.object({proposalId:z.string().uuid(),kind:z.enum(["ci","manual","isolated_http"]),status:z.enum(["passed","failed","unsupported"]),summary:z.string().min(8).max(4000),provenance:z.record(z.unknown())});
const proposalReviewSchema=z.object({status:z.enum(["approved","rejected"]),reason:z.string().min(8).max(2000)});
const criterionSchema=z.object({kind:z.enum(["runtime","delivery"]),name:z.string().min(3).max(180),source:z.string().min(2).max(240),query:z.string().max(4000),unit:z.string().min(1).max(40),comparison:z.enum(["lte","gte"]),targetValue:z.number(),minConsecutiveWindows:z.number().int().min(1).max(20),maxAgeMinutes:z.number().int().min(1).max(10080),observationMinutes:z.number().int().min(1).max(10080),deliveryIdentity:z.record(z.unknown()).nullable()});
const measurementSchema=z.object({criterionId:z.string().uuid(),value:z.number().nullable(),unit:z.string().min(1).max(40),source:z.string().min(2).max(240),query:z.string().max(4000),windowStartedAt:z.string().datetime(),windowEndedAt:z.string().datetime(),observedAt:z.string().datetime(),state:z.enum(["valid","missing","invalid"]),note:z.string().max(2000).default("")}).refine((value)=>Date.parse(value.windowEndedAt)>Date.parse(value.windowStartedAt),{path:["windowEndedAt"],message:"Measurement window must end after it starts."});
const lifecycleSchema=z.object({action:z.enum(["start_monitoring","resolve","reopen"]),reason:z.string().min(8).max(2000),expectedEvidenceRevision:z.string().datetime()});

const parseOrReply = <T>(schema: z.ZodSchema<T>, value: unknown) => {
  const result = schema.safeParse(value);
  if (!result.success) {
    return { error: result.error.flatten() } as const;
  }
  return { data: result.data } as const;
};

export const apiRouter = Router();
const userId = (req: AuthenticatedRequest) => {
  if (!req.user) throw new Error("Authenticated request context is missing.");
  return req.user.id;
};
const actor = (req: AuthenticatedRequest) => req.user?.email ?? req.user?.id ?? "Unknown operator";

apiRouter.use(async (req: AuthenticatedRequest, res, next) => {
  const token = req.user?.token;
  if (token && req.method !== "GET" && (token.role === "viewer" || !tokenMayWrite(req.method, req.path))) {
    res.status(403).json({ error: token.role === "viewer" ? "This API token is read-only." : "API tokens can update incidents, evidence, checks, and comments only. Use the app for this action." });
    return;
  }
  if (req.method === "GET" || ["/assistant", "/search", "/team/invitations/accept", "/workspaces", "/workspaces/active"].includes(req.path)) { next(); return; }
  try {
    await workspaceService.assertRole(userId(req), ["admin", "responder"]);
    res.once("finish", () => {
      const event = semanticAuditForRequest(req.method, req.path, req.body);
      if (event && res.statusCode >= 200 && res.statusCode < 300) void workspaceService.audit(userId(req), actor(req), event.action, event.targetType, event.targetId, event.detail);
    });
    next();
  } catch (error) {
    res.status(error instanceof HttpError ? error.status : 403).json({ error: error instanceof Error ? error.message : "Your workspace role does not allow this action." });
  }
});

const integrationView = (req: Request, integration: Integration) => {
  const origin = config.publicApiUrl ?? `${req.protocol}://${req.get("host")}`;
  const endpoint = `${origin}/ingest/${integration.id}`;
  const token = deriveIntegrationToken(integration.id);
  return {
    ...integration,
    connector: {
      endpoint,
      token,
      githubSecret: integration.provider === "github" ? token : undefined,
      otlpHeaders: integration.provider === "otel" ? `x-replayops-token=${token}` : undefined
    }
  };
};

apiRouter.get("/dashboard", async (req, res) => {
  res.json(await repository.dashboard(userId(req)));
});

apiRouter.get("/incidents", async (req, res) => {
  res.json(await repository.listIncidents(userId(req)));
});

apiRouter.get("/incidents/:id", async (req, res) => {
  const incident = await repository.getIncident(userId(req), String(req.params.id));
  if (!incident) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.json(incident);
});

apiRouter.get("/incidents/:id/diagnosis", async (req, res) => {
  const incident = await repository.getIncident(userId(req), req.params.id);
  if (!incident) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  const tests = await workspaceService.listHypothesisTests(userId(req), req.params.id);
  res.json(diagnoseIncident(incident, tests));
});

apiRouter.get("/incidents/:id/intelligence", async (req, res) => {
  const incident = await repository.getIncident(userId(req), req.params.id);
  if (!incident) { res.status(404).json({ error: "Incident not found." }); return; }
  res.json(buildInvestigationIntelligence(incident, await repository.listIncidents(userId(req))));
});

apiRouter.get("/incidents/:id/errors", async (req, res) => {
  const incident = await repository.getIncident(userId(req), String(req.params.id));
  if (!incident) { res.status(404).json({ error: "Incident not found." }); return; }
  const fingerprints = [...new Set(incident.events.map((event) => (event.metadata?.exception as { fingerprint?: string } | undefined)?.fingerprint).filter((value): value is string => Boolean(value)))];
  res.json(groupIncidentErrors(incident, await repository.exceptionFirstSeen(userId(req), fingerprints)));
});
apiRouter.get("/incidents/:id/casework", async (req, res) => {
  const incident=await repository.getIncident(userId(req),String(req.params.id));
  if(!incident){res.status(404).json({error:"Incident not found."});return;}
  res.json({...await caseworkService.snapshot(userId(req),incident),suggestedChecks:caseworkService.suggestions(incident)});
});

apiRouter.post("/incidents/:id/evidence-review",async(req,res)=>{
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  res.json(await caseworkService.acknowledge(userId(req),incident));
});

apiRouter.post("/incidents/:id/checks",async(req:AuthenticatedRequest,res)=>{
  const parsed=parseOrReply(checkSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  const missingEvidence=unknownEvidence(incident,parsed.data.evidenceIds??[]);if(missingEvidence.length){res.status(400).json({error:`Evidence does not belong to this incident: ${missingEvidence.join(", ")}`});return;}
  res.status(201).json(await caseworkService.createCheck(userId(req),incident,actor(req),{...parsed.data,evidenceIds:parsed.data.evidenceIds??[]}));
});

apiRouter.patch("/incidents/:id/checks/:checkId",async(req,res)=>{
  const parsed=parseOrReply(checkResultSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  const missingEvidence=unknownEvidence(incident,parsed.data.evidenceIds??[]);if(missingEvidence.length){res.status(400).json({error:`Evidence does not belong to this incident: ${missingEvidence.join(", ")}`});return;}
  res.json(await caseworkService.updateCheck(userId(req),String(req.params.checkId),{...parsed.data,evidenceIds:parsed.data.evidenceIds??[]},incident));
});

apiRouter.post("/incidents/:id/proposals",async(req:AuthenticatedRequest,res)=>{
  const parsed=parseOrReply(proposalSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  res.status(201).json(await caseworkService.createProposal(userId(req),incident,actor(req),parsed.data));
});

apiRouter.post("/incidents/:id/validations",async(req:AuthenticatedRequest,res)=>{
  const parsed=parseOrReply(validationSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  const snapshot=await caseworkService.snapshot(userId(req),incident);const proposal=snapshot.proposals.find((item)=>item.id===parsed.data.proposalId);if(!proposal){res.status(404).json({error:"Proposal version not found."});return;}
  let input=parsed.data;
  if(input.kind==="ci"){
    const required=["repository","workflow","sha","runId","attempt"];
    if(required.some((key)=>input.provenance[key]===undefined)){res.status(400).json({error:"CI validation requires repository, workflow, SHA, run ID, and attempt."});return;}
    const source=incident.events.find((event)=>required.every((key)=>String(event.metadata?.[key]??event.metadata?.[key==="runId"?"runId":key]??"")===String(input.provenance[key])));
    if(!source){res.status(400).json({error:"No ingested GitHub workflow event matches that exact CI identity."});return;}
    const conclusion=String(source.metadata?.conclusion??"").toLowerCase();
    input={...input,status:conclusion==="success"?"passed":["failure","timed_out","action_required"].includes(conclusion)?"failed":"unsupported",provenance:{...input.provenance,sourceEventId:source.id,sourceUrl:source.metadata?.sourceUrl??null,productionHealthMeasured:false}};
  }
  res.status(201).json(await caseworkService.addValidation(userId(req),incident,proposal,actor(req),input));
});

apiRouter.post("/incidents/:id/proposals/:proposalId/review-request",async(req:AuthenticatedRequest,res)=>{
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  const snapshot=await caseworkService.snapshot(userId(req),incident);const proposal=snapshot.proposals.find((item)=>item.id===String(req.params.proposalId));if(!proposal){res.status(404).json({error:"Proposal version not found."});return;}
  try{res.status(201).json(await caseworkService.requestReview(userId(req),incident,proposal,actor(req)));}catch(error){res.status(error instanceof HttpError?error.status:409).json({error:error instanceof Error?error.message:"Review request failed."});}
});

apiRouter.patch("/incidents/:id/proposal-reviews/:reviewId",async(req:AuthenticatedRequest,res)=>{
  const parsed=parseOrReply(proposalReviewSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  try{const context=await workspaceService.context(userId(req));res.json(await caseworkService.reviewProposal(userId(req),incident,String(req.params.reviewId),actor(req),context.role,parsed.data));}catch(error){res.status(error instanceof HttpError?error.status:409).json({error:error instanceof Error?error.message:"Proposal review failed."});}
});

apiRouter.post("/incidents/:id/recovery-criteria",async(req,res)=>{
  const parsed=parseOrReply(criterionSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  if(parsed.data.kind==="delivery"&&!parsed.data.deliveryIdentity){res.status(400).json({error:"Delivery recovery requires exact repository, workflow, ref, SHA, and attempt identity."});return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  res.status(201).json(await caseworkService.createCriterion(userId(req),incident,parsed.data));
});

apiRouter.post("/incidents/:id/measurements",async(req,res)=>{
  const parsed=parseOrReply(measurementSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  const snapshot=await caseworkService.snapshot(userId(req),incident);const criterion=snapshot.criteria.find((item)=>item.id===parsed.data.criterionId);if(!criterion||criterion.kind!=="runtime"){res.status(400).json({error:"Measurement must reference a runtime recovery criterion in this incident."});return;}
  res.status(201).json(await caseworkService.addMeasurement(userId(req),incident,{...parsed.data,note:parsed.data.note??""}));
});

apiRouter.post("/incidents/:id/lifecycle",async(req:AuthenticatedRequest,res)=>{
  const parsed=parseOrReply(lifecycleSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  try{const context=await workspaceService.context(userId(req));const before=await repository.getIncident(userId(req),String(req.params.id));
    const result=await caseworkService.transition(userId(req),String(req.params.id),actor(req),context.role,parsed.data);res.json(result);
    const incident=await repository.getIncident(userId(req),String(req.params.id));
    const type=parsed.data.action==="start_monitoring"?"monitoring":parsed.data.action==="resolve"?"resolved":"reopened";
    // Alert on real status changes only: a repeated click or retried request must not page twice.
    if(incident&&before&&incident.status!==before.status)void alertService.dispatch(context.organizationId,{type,incident,detail:parsed.data.reason,actor:actor(req)});}
  catch(error){res.status(error instanceof HttpError?error.status:409).json({error:error instanceof Error?error.message:"Lifecycle transition failed."});}
});

apiRouter.post("/incidents/:id/evidence-bundle", async (req: AuthenticatedRequest, res) => {
  const incident = await repository.getIncident(userId(req), String(req.params.id));
  if (!incident) { res.status(404).json({ error: "Incident not found." }); return; }
  const bundle = buildEvidenceBundle(incident);
  await workspaceService.audit(userId(req), actor(req), "exported redacted evidence bundle", "incident", incident.id, { evidenceRevision: bundle.evidenceRevision, expiresAt: bundle.expiresAt });
  res.status(201).json(bundle);
});

apiRouter.post("/incidents", async (req, res) => {
  const parsed = parseOrReply(incidentSchema, req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const privacy=await workspaceService.getPrivacy(userId(req));
  const embedding = await embedText(`${parsed.data.title}\n${parsed.data.summary}\n${parsed.data.service}`,privacy.externalAiEnabled);
  res.status(201).json(await repository.createIncident(userId(req), parsed.data, embedding));
});

apiRouter.patch("/incidents/:id", async (req, res) => {
  const parsed = parseOrReply(incidentSchema.partial(), req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (parsed.data.status === "resolved") { res.status(409).json({ error:"Resolve through the monitored recovery workflow so the latest evidence is re-evaluated and audited atomically." }); return; }
  const privacy=await workspaceService.getPrivacy(userId(req));
  const embedding = parsed.data.title || parsed.data.summary || parsed.data.service
    ? await embedText(`${parsed.data.title ?? ""}\n${parsed.data.summary ?? ""}\n${parsed.data.service ?? ""}`,privacy.externalAiEnabled)
    : undefined;
  const incident = await repository.updateIncident(userId(req), req.params.id, parsed.data, embedding);
  if (!incident) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.json(incident);
});

// Deleting an incident destroys its evidence permanently, so only administrators can do it and the
// audit entry keeps enough to know what was removed.
apiRouter.delete("/incidents/:id", async (req: AuthenticatedRequest, res) => {
  await workspaceService.assertRole(userId(req), ["admin"]);
  const incident = await repository.getIncident(userId(req), String(req.params.id));
  const deleted = incident ? await repository.deleteIncident(userId(req), incident.id) : false;
  if (!incident || !deleted) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  await workspaceService.audit(userId(req), actor(req), "deleted investigation", "incident", incident.id, { code: incident.code, title: incident.title, service: incident.service, status: incident.status, eventCount: incident.events.length });
  res.status(204).send();
});

apiRouter.get("/incidents/:id/decisions", async (req, res) => {
  const incident = await repository.getIncident(userId(req), req.params.id);
  if (!incident) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.json(await repository.listDecisions(userId(req), req.params.id));
});

apiRouter.post("/incidents/:id/decisions", async (req, res) => {
  const parsed = parseOrReply(decisionSchema, req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const decision = await repository.createDecision(userId(req), req.params.id, parsed.data);
  if (!decision) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.status(201).json(decision);
});

apiRouter.post("/incidents/:id/replays", async (req, res) => {
  const parsed = parseOrReply(replaySchema, req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const result = await repository.runReplay(userId(req), req.params.id, parsed.data);
  if (!result) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.status(201).json(result);
});

apiRouter.get("/incidents/:id/replays", async (req, res) => {
  const incident = await repository.getIncident(userId(req), req.params.id);
  if (!incident) { res.status(404).json({ error: "Incident not found." }); return; }
  res.json(await repository.listReplays(userId(req), req.params.id));
});

apiRouter.get("/incidents/:id/http-replays", async (req, res) => {
  const incidentId=String(req.params.id);
  if(!await repository.getIncident(userId(req),incidentId)){res.status(404).json({error:"Incident not found."});return;}
  res.json(await httpReplayService.list(userId(req),incidentId));
});

apiRouter.post("/incidents/:id/http-replays", async (req:AuthenticatedRequest,res)=>{
  const parsed=parseOrReply(httpReplaySchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}
  const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}
  if(parsed.data.request.body&&!(await workspaceService.getPrivacy(userId(req))).captureRequestBodies){res.status(400).json({error:"Request body capture is off for this workspace. Remove the body, or ask an admin to enable “Capture request bodies” in Workspace → Privacy & AI."});return;}
  const value=await httpReplayService.create(userId(req),incident.id,incident.evidenceRevision??incident.updatedAt,{...parsed.data,request:{...parsed.data.request,headers:parsed.data.request.headers??{}}});
  await workspaceService.audit(userId(req),actor(req),"created bounded HTTP replay","http-replay",value.id,{incidentId:incident.id,evidenceRevision:value.evidenceRevision});
  res.status(201).json(value);
});

apiRouter.post("/http-replays/:id/execute",async(req:AuthenticatedRequest,res)=>{
  const spec=await httpReplayService.findSpec(userId(req),String(req.params.id));
  if(!spec){res.status(404).json({error:"Replay specification not found."});return;}
  const incident=await repository.getIncident(userId(req),spec.incidentId);if(!incident){res.status(404).json({error:"Incident not found."});return;}
  if((incident.evidenceRevision??incident.updatedAt)!==spec.evidenceRevision){res.status(409).json({error:"Evidence changed after this replay was captured. Create a new immutable replay specification."});return;}
  const execution=await httpReplayService.execute(userId(req),spec);await workspaceService.audit(userId(req),actor(req),"executed bounded HTTP replay","http-replay-execution",execution.id,{specId:spec.id,status:execution.status,nondeterministic:execution.nondeterministic});res.status(201).json(execution);
});

apiRouter.post("/incidents/:id/events", async (req, res) => {
  const parsed = parseOrReply(eventSchema, req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (parsed.data.correctedFromId && !(await repository.getIncident(userId(req), req.params.id))?.events.some((item) => item.id === parsed.data.correctedFromId)) {
    res.status(400).json({ error: "The corrected event does not belong to this incident." });
    return;
  }
  const event = await repository.createEvent(userId(req), req.params.id, parsed.data);
  if (!event) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.status(201).json(event);
});

apiRouter.get("/incidents/:id/events",async(req,res)=>{const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}const limit=Math.min(250,Math.max(20,Number(req.query.limit??100)));const cursor=typeof req.query.cursor==="string"?req.query.cursor:"";const start=cursor?Math.max(0,incident.events.findIndex((item)=>item.id===cursor)+1):0;const items=incident.events.slice(start,start+limit);res.json({items,nextCursor:start+items.length<incident.events.length?items.at(-1)?.id:null,total:incident.events.length,evidenceRevision:incident.evidenceRevision??incident.updatedAt});});

apiRouter.patch("/incidents/:incidentId/events/:eventId", async (req, res) => {
  const parsed = parseOrReply(eventSchema.partial(), req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (parsed.data.correctedFromId && !(await repository.getIncident(userId(req), req.params.incidentId))?.events.some((item) => item.id === parsed.data.correctedFromId)) {
    res.status(400).json({ error: "The corrected event does not belong to this incident." });
    return;
  }
  const event = await repository.updateEvent(userId(req), req.params.incidentId, req.params.eventId, parsed.data);
  if (!event) {
    res.status(404).json({ error: "Timeline event not found." });
    return;
  }
  res.json(event);
});

apiRouter.delete("/incidents/:incidentId/events/:eventId", async (req, res) => {
  const deleted = await repository.deleteEvent(userId(req), req.params.incidentId, req.params.eventId);
  if (!deleted) {
    res.status(404).json({ error: "Timeline event not found." });
    return;
  }
  res.status(204).send();
});

apiRouter.post("/incidents/:incidentId/events/:eventId/move", async (req, res) => {
  const parsed = parseOrReply(z.object({ targetIncidentId: z.string().min(1) }), req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  const event = await repository.moveEvent(userId(req), req.params.incidentId, req.params.eventId, parsed.data.targetIncidentId);
  if (!event) { res.status(404).json({ error: "The source event or target incident was not found in this workspace." }); return; }
  await workspaceService.audit(userId(req), actor(req), "moved grouped evidence", "incident-event", event.id, { fromIncidentId: req.params.incidentId, toIncidentId: parsed.data.targetIncidentId });
  res.json(event);
});

apiRouter.post("/search", async (req, res) => {
  const parsed = z.object({ query: z.string().min(2).max(500) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter at least two characters to search incident evidence." });
    return;
  }
  const exactish = /^(?:rop-|auto-|[0-9a-f]{8}-|[\w.-]{12,})/i.test(parsed.data.query.trim());
  const privacy=await workspaceService.getPrivacy(userId(req));
  const embedding = exactish ? undefined : await embedText(parsed.data.query,privacy.externalAiEnabled);
  res.json(await repository.search(userId(req), parsed.data.query, embedding));
});

apiRouter.post("/assistant", async (req, res) => {
  const parsed = z.object({ question: z.string().min(4).max(1200), incidentId: z.string().optional(), scope: z.enum(["incident", "workspace"]).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ask a specific question about the available incident evidence." });
    return;
  }
  const privacy=await workspaceService.getPrivacy(userId(req));
  const selected = parsed.data.incidentId ? await repository.getIncident(userId(req), parsed.data.incidentId) : undefined;
  if (parsed.data.incidentId && !selected) { res.status(404).json({ error: "Incident not found." }); return; }
  const context = selected ? { incident: selected, diagnosis: diagnoseIncident(selected, await workspaceService.listHypothesisTests(userId(req), selected.id)) } : undefined;
  const selectedResult = selected ? [{ incident: selected, score: 1, matchReason: "Currently selected incident" }] : [];
  // Incident-scoped questions only see that incident's evidence, so answers cannot cite unrelated investigations.
  if (selected && parsed.data.scope === "incident") {
    res.json(await answerQuestion(parsed.data.question, selectedResult, privacy.externalAiEnabled, context));
    return;
  }
  const embedding = await embedText(parsed.data.question,privacy.externalAiEnabled);
  const matches = await repository.search(userId(req), parsed.data.question, embedding);
  res.json(await answerQuestion(parsed.data.question, [...selectedResult, ...matches.filter((item) => item.incident.id !== selected?.id)], privacy.externalAiEnabled, context));
});

apiRouter.get("/integrations", async (req, res) => {
  const integrations = await repository.listIntegrations(userId(req));
  res.json(integrations.map((integration) => integrationView(req, integration)));
});

apiRouter.post("/integrations", async (req, res) => {
  const parsed = parseOrReply(integrationSchema, req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const integration = await repository.createIntegration(userId(req), parsed.data);
  res.status(201).json(integrationView(req, integration));
});

apiRouter.patch("/integrations/:id/config",async(req,res)=>{const parsed=parseOrReply(integrationConfigSchema,req.body);if("error" in parsed){res.status(400).json(parsed);return;}const value=await repository.updateIntegrationConfig(userId(req),String(req.params.id),parsed.data);if(!value){res.status(404).json({error:"Connector not found."});return;}res.json(integrationView(req,value));});

apiRouter.delete("/integrations/:id", async (req: AuthenticatedRequest, res) => {
  await workspaceService.assertRole(userId(req), ["admin"]);
  const existing = (await repository.listIntegrations(userId(req))).find((item) => item.id === String(req.params.id));
  const deleted = existing ? await repository.deleteIntegration(userId(req), existing.id) : false;
  if (!existing || !deleted) {
    res.status(404).json({ error: "Connector not found." });
    return;
  }
  await workspaceService.audit(userId(req), actor(req), "removed evidence source", "integration", existing.id, { name: existing.name, provider: existing.provider, signalCount: existing.signalCount });
  res.status(204).send();
});

const alertChannelSchema = z.object({
  name: z.string().min(2).max(80), kind: z.enum(["email", "ntfy", "slack", "discord", "webhook"]), url: z.string().min(3).max(2000),
  events: z.array(z.enum(alertEventTypes as [string, ...string[]])).min(1).max(4).default(alertEventTypes), minSeverity: severity.default("low"), enabled: z.boolean().optional()
});
const alertChannelUpdateSchema = alertChannelSchema.pick({ events: true, minSeverity: true, enabled: true }).partial();
apiRouter.get("/alert-channels/options", (_req, res) => { res.json({ emailConfigured: alertEmailConfigured() }); });
apiRouter.get("/alert-channels", async (req, res) => res.json(await alertService.list(userId(req))));
apiRouter.post("/alert-channels", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(alertChannelSchema, req.body); if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.status(201).json(await alertService.create(userId(req), actor(req), parsed.data as Parameters<typeof alertService.create>[2]));
});
apiRouter.patch("/alert-channels/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(alertChannelUpdateSchema, req.body); if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.json(await alertService.update(userId(req), actor(req), String(req.params.id), parsed.data as Parameters<typeof alertService.update>[3]));
});
apiRouter.delete("/alert-channels/:id", async (req: AuthenticatedRequest, res) => { await alertService.remove(userId(req), actor(req), String(req.params.id)); res.status(204).send(); });
apiRouter.post("/alert-channels/:id/test", async (req: AuthenticatedRequest, res) => res.json(await alertService.test(userId(req), actor(req), String(req.params.id))));

apiRouter.post("/integrations/:id/test", async (req, res) => {
  const owned = (await repository.listIntegrations(userId(req))).find((integration) => integration.id === req.params.id);
  if (!owned) {
    res.status(404).json({ error: "Connector not found." });
    return;
  }
  const target = await repository.getIntegrationTarget(owned.id);
  if (!target) {
    res.status(404).json({ error: "Connector not found." });
    return;
  }
  const deliveryId = `test-${randomUUID()}`;
  const batch: IngestionBatch = {
    externalId: deliveryId,
    signals: [{
      externalId: `${deliveryId}:signal`, timestamp: new Date().toISOString(), service: "checkout-probe",
      kind: "alert", title: "Synthetic checkout probe crossed the error threshold",
      detail: "ReplayOps generated this labeled test signal to verify authentication, normalization, incident creation, and evidence attachment.",
      impactScore: 82, severity: "high", correlationKey: deliveryId,
      sourceUrl: `${config.publicApiUrl ?? `${req.protocol}://${req.get("host")}`}/health`,
      environment: "integration-test", metadata: { synthetic: true, provider: owned.provider }
    }]
  };
  const queued = await ingestionQueue.enqueue(target, batch);
  const result = await ingestionQueue.process(queued.job.id);
  res.status(202).json(result);
});

apiRouter.get("/api-tokens", async (req, res) => res.json(await apiTokenService.list(userId(req))));
apiRouter.post("/api-tokens", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(z.object({ name: z.string().trim().min(2).max(80), role: z.enum(["viewer", "responder"]), expiresInDays: z.number().int().min(1).max(365).nullable() }), req.body); if ("error" in parsed) { res.status(400).json(parsed); return; }
  if (req.user?.token) { res.status(403).json({ error: "API tokens cannot create other tokens." }); return; }
  res.status(201).json(await apiTokenService.create(userId(req), actor(req), parsed.data));
});
apiRouter.delete("/api-tokens/:id", async (req: AuthenticatedRequest, res) => { await apiTokenService.revoke(userId(req), actor(req), String(req.params.id)); res.status(204).send(); });
apiRouter.get("/workspaces", async (req, res) => res.json(await workspaceService.listWorkspaces(userId(req))));
apiRouter.post("/workspaces/active", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(z.object({ organizationId: z.string().min(1).max(80) }), req.body); if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.json(await workspaceService.switchWorkspace(userId(req), parsed.data.organizationId));
});
apiRouter.post("/workspaces", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(z.object({ name: z.string().trim().min(2).max(80) }), req.body); if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.status(201).json(await workspaceService.createWorkspace(userId(req), actor(req), parsed.data.name));
});
apiRouter.get("/workspace", async (req, res) => {
  res.json(await workspaceService.context(userId(req)));
});
apiRouter.get("/privacy-settings",async(req,res)=>res.json(await workspaceService.getPrivacy(userId(req))));
apiRouter.patch("/privacy-settings",async(req:AuthenticatedRequest,res)=>{const parsed=parseOrReply(z.object({externalAiEnabled:z.boolean(),captureRequestBodies:z.boolean(),productAnalyticsEnabled:z.boolean()}),req.body);if("error" in parsed){res.status(400).json(parsed);return;}res.json(await workspaceService.updatePrivacy(userId(req),actor(req),parsed.data));});
apiRouter.post("/product-outcomes",async(req:AuthenticatedRequest,res)=>{const parsed=parseOrReply(z.object({event:z.enum(["evidence_opened","test_started","test_completed","draft_recovered","grouping_corrected","replay_executed","recovery_verified","historical_fix_reused"]),detail:z.record(z.union([z.string(),z.number(),z.boolean(),z.null()])).default({})}),req.body);if("error" in parsed){res.status(400).json(parsed);return;}res.status(201).json(await workspaceService.recordProductOutcome(userId(req),actor(req),parsed.data.event,parsed.data.detail??{}));});
apiRouter.get("/product-outcomes",async(req,res)=>res.json(await workspaceService.listProductOutcomes(userId(req))));

apiRouter.get("/services", async (req, res) => {
  res.json(await workspaceService.listServices(userId(req)));
});

apiRouter.post("/services", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(serviceSchema, req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.status(201).json(await workspaceService.upsertService(userId(req), actor(req), parsed.data));
});

apiRouter.get("/incident-policy/preview", async (req, res) => {
  const threshold = Math.min(100, Math.max(1, Math.round(Number(req.query.threshold ?? 65)) || 65));
  res.json(await repository.impactPreview(userId(req), threshold));
});
apiRouter.get("/incident-policy", async (req, res) => {
  res.json(await workspaceService.getPolicy(userId(req)));
});

apiRouter.patch("/incident-policy", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(policySchema, req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.json(await workspaceService.updatePolicy(userId(req), actor(req), parsed.data));
});

apiRouter.get("/team/members", async (req, res) => {
  res.json(await workspaceService.listMembers(userId(req)));
});

apiRouter.patch("/team/members/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(z.object({ role: roleSchema }), req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.json(await workspaceService.updateMemberRole(userId(req), actor(req), String(req.params.id), parsed.data.role));
});

apiRouter.get("/team/invitations", async (req, res) => {
  res.json(await workspaceService.listInvitations(userId(req)));
});

apiRouter.post("/team/invitations", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(inviteSchema, req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.status(201).json(await workspaceService.createInvitation(userId(req), actor(req), parsed.data.email, parsed.data.role));
});

apiRouter.post("/team/invitations/accept", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(z.object({ token: z.string().min(32).max(128) }), req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  if (!req.user?.email) { res.status(400).json({ error: "Your authenticated account does not have an email address." }); return; }
  res.json(await workspaceService.acceptInvitation(userId(req), req.user.email, parsed.data.token));
});

apiRouter.get("/audit", async (req, res) => {
  res.json(await workspaceService.listAudit(userId(req)));
});

apiRouter.get("/notifications", async (req: AuthenticatedRequest, res) => res.json(await workspaceService.listNotifications(userId(req), actor(req))));
apiRouter.patch("/notifications/:id",async(req,res)=>{const parsed=parseOrReply(z.object({read:z.boolean().optional(),resolved:z.boolean().optional()}),req.body);if("error" in parsed){res.status(400).json(parsed);return;}res.json(await workspaceService.updateNotificationState(userId(req),String(req.params.id),parsed.data));});

apiRouter.get("/ingestion-queue", async (req, res) => {
  res.json(await ingestionQueue.list(userId(req)));
});

apiRouter.post("/ingestion-queue/:id/retry", async (req, res) => {
  const job = await ingestionQueue.retry(userId(req), String(req.params.id));
  void ingestionQueue.process(job.id).catch(() => undefined);
  res.status(202).json(job);
});

apiRouter.get("/incidents/:id/mitigations", async (req, res) => {
  if (!await repository.getIncident(userId(req), String(req.params.id))) { res.status(404).json({ error: "Incident not found." }); return; }
  res.json(await workspaceService.listMitigations(userId(req), String(req.params.id)));
});

apiRouter.post("/incidents/:id/mitigations", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(mitigationSchema, req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  const replay = (await repository.listReplays(userId(req), String(req.params.id))).find((item) => item.id === parsed.data.replayRunId);
  if (!replay) { res.status(400).json({ error: "Run and save a replay before requesting production approval." }); return; }
  const { replayRunId: _replayRunId, ...request } = parsed.data;
  res.status(201).json(await workspaceService.requestMitigation(userId(req), actor(req), String(req.params.id), { ...request, replay }));
});

apiRouter.patch("/mitigations/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = parseOrReply(mitigationReviewSchema, req.body);
  if ("error" in parsed) { res.status(400).json(parsed); return; }
  res.json(await workspaceService.reviewMitigation(userId(req), actor(req), String(req.params.id), parsed.data.status));
});

apiRouter.get("/incidents/:id/hypothesis-tests", async (req, res) => res.json(await workspaceService.listHypothesisTests(userId(req), String(req.params.id))));
apiRouter.post("/incidents/:id/hypothesis-tests", async (req: AuthenticatedRequest, res) => { const parsed = parseOrReply(hypothesisTestSchema, req.body); if ("error" in parsed) { res.status(400).json(parsed); return; } res.status(201).json(await workspaceService.createHypothesisTest(userId(req), actor(req), String(req.params.id), parsed.data)); });
apiRouter.patch("/hypothesis-tests/:id", async (req: AuthenticatedRequest, res) => { const parsed = parseOrReply(hypothesisOutcomeSchema, req.body); if ("error" in parsed) { res.status(400).json(parsed); return; } res.json(await workspaceService.updateHypothesisTest(userId(req), actor(req), String(req.params.id), parsed.data)); });

apiRouter.get("/incidents/:id/recovery", async (req, res) => res.json(await workspaceService.listRecoveries(userId(req), String(req.params.id))));
apiRouter.post("/incidents/:id/recovery", async (req: AuthenticatedRequest, res) => { const parsed = parseOrReply(recoverySchema, req.body); if ("error" in parsed) { res.status(400).json(parsed); return; } res.status(201).json(await workspaceService.saveRecovery(userId(req), actor(req), String(req.params.id), parsed.data)); });

apiRouter.get("/incidents/:id/postmortem", async (req, res) => res.json(await workspaceService.getPostmortem(userId(req), String(req.params.id))));
apiRouter.put("/incidents/:id/postmortem", async (req: AuthenticatedRequest, res) => { const parsed = parseOrReply(postmortemSchema, req.body); if ("error" in parsed) { res.status(400).json(parsed); return; } res.json(await workspaceService.savePostmortem(userId(req), actor(req), String(req.params.id), parsed.data)); });
apiRouter.get("/incidents/:id/comments",async(req,res)=>res.json(await workspaceService.listComments(userId(req),String(req.params.id))));
apiRouter.post("/incidents/:id/comments",async(req:AuthenticatedRequest,res)=>{const parsed=parseOrReply(z.object({body:z.string().min(2).max(2000),eventId:evidenceId.nullable().optional()}),req.body);if("error" in parsed){res.status(400).json(parsed);return;}if(parsed.data.eventId){const incident=await repository.getIncident(userId(req),String(req.params.id));if(!incident){res.status(404).json({error:"Incident not found."});return;}if(unknownEvidence(incident,[parsed.data.eventId]).length){res.status(400).json({error:"The referenced event does not belong to this incident."});return;}}res.status(201).json(await workspaceService.createComment(userId(req),actor(req),String(req.params.id),parsed.data));});
