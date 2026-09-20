import { Router } from "express";
import { z } from "zod";
import { answerQuestion, embedText } from "./ai.js";
import type { AuthenticatedRequest } from "./auth.js";
import { diagnoseIncident } from "./diagnosis.js";
import { repository } from "./repository.js";

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
