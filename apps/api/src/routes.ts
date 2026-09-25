import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
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
  correctedFromId: z.string().uuid().nullable().optional(),
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
  if (req.method === "GET" || ["/assistant", "/search", "/team/invitations/accept"].includes(req.path)) { next(); return; }
  try {
    await workspaceService.assertRole(userId(req), ["admin", "responder"]);
    res.once("finish", () => {
      const target = req.params.id ?? req.params.incidentId;
      if (res.statusCode >= 200 && res.statusCode < 300) void workspaceService.audit(userId(req), actor(req), `${req.method} ${req.path}`, "api-route", target ? String(target) : undefined, {});
    });
    next();
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : "Your workspace role does not allow this action." });
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
  if (parsed.data.status === "resolved") await workspaceService.assertRecoveryVerified(userId(req), req.params.id);
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

apiRouter.delete("/incidents/:id", async (req, res) => {
  const deleted = await repository.deleteIncident(userId(req), req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
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
  const value=await httpReplayService.create(userId(req),incident.id,incident.evidenceRevision??incident.updatedAt,{...parsed.data,request:{...parsed.data.request,headers:parsed.data.request.headers??{}}});
  await workspaceService.audit(userId(req),actor(req),"created bounded HTTP replay","http-replay",value.id,{incidentId:incident.id,evidenceRevision:value.evidenceRevision});
  res.status(201).json(value);
});

apiRouter.post("/http-replays/:id/execute",async(req:AuthenticatedRequest,res)=>{
  const all=await repository.listIncidents(userId(req));let spec;
  for(const incident of all){const found=(await httpReplayService.list(userId(req),incident.id)).specs.find((item)=>item.id===String(req.params.id));if(found){spec=found;break;}}
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
  const parsed = z.object({ question: z.string().min(4).max(1200), incidentId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ask a specific question about the available incident evidence." });
    return;
  }
  const privacy=await workspaceService.getPrivacy(userId(req));
  const embedding = await embedText(parsed.data.question,privacy.externalAiEnabled);
  let evidence = await repository.search(userId(req), parsed.data.question, embedding);
  if (parsed.data.incidentId) {
    const selected = await repository.getIncident(userId(req), parsed.data.incidentId);
    if (selected && !evidence.some((item) => item.incident.id === selected.id)) {
      evidence = [{ incident: selected, score: 1, matchReason: "Currently selected incident" }, ...evidence];
    }
  }
  res.json(await answerQuestion(parsed.data.question, evidence,privacy.externalAiEnabled));
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

apiRouter.delete("/integrations/:id", async (req, res) => {
  const deleted = await repository.deleteIntegration(userId(req), req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Connector not found." });
    return;
  }
  res.status(204).send();
});

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
apiRouter.post("/incidents/:id/comments",async(req:AuthenticatedRequest,res)=>{const parsed=parseOrReply(z.object({body:z.string().min(2).max(2000),eventId:z.string().uuid().nullable().optional()}),req.body);if("error" in parsed){res.status(400).json(parsed);return;}res.status(201).json(await workspaceService.createComment(userId(req),actor(req),String(req.params.id),parsed.data));});
