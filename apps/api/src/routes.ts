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

const severity = z.enum(["critical", "high", "medium", "low"]);
const status = z.enum(["investigating", "identified", "monitoring", "resolved"]);
const eventKind = z.enum(["alert", "deploy", "dependency", "metric", "action", "recovery"]);
const decisionKind = z.enum(["hypothesis", "mitigation", "communication"]);
const decisionStatus = z.enum(["proposed", "approved", "rejected"]);

const incidentSchema = z.object({
  title: z.string().min(4).max(120),
  summary: z.string().min(12).max(800),
  service: z.string().min(2).max(80),
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
const serviceSchema = z.object({
  name: z.string().min(2).max(80), ownerTeam: z.string().min(2).max(80), tier: z.enum(["critical", "standard", "internal"]),
  repositoryUrl: z.string().url().nullable().optional(), runbookUrl: z.string().url().nullable().optional(), dependencies: z.array(z.string().min(2).max(80)).max(30)
});
const policySchema = z.object({ incidentThreshold: z.number().int().min(1).max(100), groupingWindowMinutes: z.number().int().min(5).max(1440), suppressLowSeverity: z.boolean(), maintenanceMode: z.boolean() });
const roleSchema = z.enum(["admin", "responder", "viewer"]);
const inviteSchema = z.object({ email: z.string().email(), role: roleSchema });
const mitigationSchema = z.object({ replayRunId: z.string().uuid(), title: z.string().min(4).max(120), action: z.string().min(12).max(1200), rollbackPlan: z.string().min(12).max(1200) });
const mitigationReviewSchema = z.object({ status: z.enum(["approved", "rejected"]) });
const hypothesisTestSchema = z.object({ hypothesisId: z.string().min(2).max(160), title: z.string().min(4).max(180), instruction: z.string().min(8).max(1600), assignee: z.string().min(2).max(160) });
const hypothesisOutcomeSchema = z.object({ status: z.enum(["planned", "running", "supported", "disproved", "inconclusive"]), result: z.string().max(2000) });
const recoverySchema = z.object({ metric: z.string().min(2).max(160), targetValue: z.number(), baselineValue: z.number(), observedValue: z.number().nullable().optional(), observationMinutes: z.number().int().min(1).max(10080), status: z.enum(["pending", "verified", "failed"]), reason: z.string().max(1600) });
const postmortemSchema = z.object({ summary: z.string().max(4000), rootCause: z.string().max(4000), impact: z.string().max(4000), recovery: z.string().max(4000), followUps: z.string().max(4000), status: z.enum(["draft", "published"]) });

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
  const incident = await repository.getIncident(userId(req), req.params.id);
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
  res.json(diagnoseIncident(incident));
});

apiRouter.post("/incidents", async (req, res) => {
  const parsed = parseOrReply(incidentSchema, req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const embedding = await embedText(`${parsed.data.title}\n${parsed.data.summary}\n${parsed.data.service}`);
  res.status(201).json(await repository.createIncident(userId(req), parsed.data, embedding));
});

apiRouter.patch("/incidents/:id", async (req, res) => {
  const parsed = parseOrReply(incidentSchema.partial(), req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (parsed.data.status === "resolved") await workspaceService.assertRecoveryVerified(userId(req), req.params.id);
  const embedding = parsed.data.title || parsed.data.summary || parsed.data.service
    ? await embedText(`${parsed.data.title ?? ""}\n${parsed.data.summary ?? ""}\n${parsed.data.service ?? ""}`)
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
  const embedding = await embedText(parsed.data.query);
  res.json(await repository.search(userId(req), parsed.data.query, embedding));
});

apiRouter.post("/assistant", async (req, res) => {
  const parsed = z.object({ question: z.string().min(4).max(1200), incidentId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ask a specific question about the available incident evidence." });
    return;
  }
  const embedding = await embedText(parsed.data.question);
  let evidence = await repository.search(userId(req), parsed.data.question, embedding);
  if (parsed.data.incidentId) {
    const selected = await repository.getIncident(userId(req), parsed.data.incidentId);
    if (selected && !evidence.some((item) => item.incident.id === selected.id)) {
      evidence = [{ incident: selected, score: 1, matchReason: "Currently selected incident" }, ...evidence];
    }
  }
  res.json(await answerQuestion(parsed.data.question, evidence));
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
