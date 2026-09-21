import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "./config.js";
import { repository } from "./repository.js";
import type { EventKind, IngestionBatch, IntegrationProvider, NormalizedSignal, Severity } from "./types.js";

type JsonRecord = Record<string, unknown>;
type RawRequest = Request & { rawBody?: Buffer };

const object = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const textValue = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value.trim() : fallback;
const numberValue = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const boundedImpact = (value: unknown, fallback = 50) => Math.max(0, Math.min(100, Math.round(numberValue(value, fallback))));
const isoTime = (value: unknown) => {
  const date = value ? new Date(String(value)) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};
const nanoTime = (value: unknown) => {
  try {
    return new Date(Number(BigInt(String(value)) / 1_000_000n)).toISOString();
  } catch {
    return new Date().toISOString();
  }
};
const severityForImpact = (impact: number): Severity => impact >= 88 ? "critical" : impact >= 70 ? "high" : impact >= 45 ? "medium" : "low";
const severityValue = (value: unknown, fallback: Severity): Severity => {
  const candidate = textValue(value) as Severity;
  return ["critical", "high", "medium", "low"].includes(candidate) ? candidate : fallback;
};

const configuredSecret = () => {
  if (config.ingestionSigningSecret) return config.ingestionSigningSecret;
  if (process.env.NODE_ENV !== "production") return "replayops-local-connector-secret";
  throw new Error("Automated ingestion is unavailable until INGESTION_SIGNING_SECRET is configured.");
};

export function deriveIntegrationToken(integrationId: string) {
  return createHmac("sha256", configuredSecret()).update(`replayops:${integrationId}`).digest("hex");
}

const constantTimeMatch = (actual: string, expected: string) => {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function verifyGitHubSignature(rawBody: Buffer, integrationId: string, signature: string) {
  const expected = `sha256=${createHmac("sha256", deriveIntegrationToken(integrationId)).update(rawBody).digest("hex")}`;
  return constantTimeMatch(signature, expected);
}

function attributes(value: unknown) {
  const result: JsonRecord = {};
  for (const entryValue of array(value)) {
    const entry = object(entryValue);
    const key = textValue(entry.key);
    const wrapped = object(entry.value);
    if (!key) continue;
    const selected = wrapped.stringValue ?? wrapped.intValue ?? wrapped.doubleValue ?? wrapped.boolValue ?? wrapped.arrayValue ?? wrapped.kvlistValue;
    result[key] = selected;
  }
  return result;
}

function normalized(input: Partial<NormalizedSignal> & Pick<NormalizedSignal, "externalId" | "service" | "title" | "detail">): NormalizedSignal {
  const impactScore = boundedImpact(input.impactScore, 50);
  return {
    externalId: input.externalId,
    timestamp: isoTime(input.timestamp),
    service: input.service || "unknown-service",
    kind: input.kind ?? "metric",
    title: input.title,
    detail: input.detail,
    impactScore,
    severity: input.severity ?? severityForImpact(impactScore),
    ...(input.correlationKey ? { correlationKey: input.correlationKey } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    metadata: input.metadata ?? {}
  };
}

function normalizeGitHub(payload: JsonRecord, eventName: string, deliveryId: string): NormalizedSignal[] {
  const repository = object(payload.repository);
  const repositoryName = textValue(repository.full_name, textValue(repository.name, "github-repository"));
  const repositoryUrl = textValue(repository.html_url);
  const sender = textValue(object(payload.sender).login, "GitHub");

  if (eventName === "deployment") {
    const deployment = object(payload.deployment);
    const environment = textValue(deployment.environment, "production");
    const ref = textValue(deployment.ref, "unknown ref");
    return [normalized({
      externalId: `${deliveryId}:deployment`, timestamp: isoTime(deployment.created_at), service: repositoryName, kind: "deploy",
      title: `Deployment created for ${environment}`,
      detail: `${sender} deployed ${ref} to ${environment}. This change is buffered as precursor evidence until an incident matches it.`,
      impactScore: 24, sourceUrl: repositoryUrl, environment,
      correlationKey: textValue(deployment.task, `${repositoryName}:${environment}`),
      metadata: { provider: "github", ref, sha: deployment.sha, creator: sender }
    })];
  }

  if (eventName === "deployment_status") {
    const deployment = object(payload.deployment);
    const deploymentStatus = object(payload.deployment_status);
    const state = textValue(deploymentStatus.state, "unknown").toLowerCase();
    const failed = ["failure", "error", "inactive"].includes(state);
    const successful = state === "success";
    const environment = textValue(deployment.environment, textValue(deploymentStatus.environment, "production"));
    const environmentUrl = textValue(deploymentStatus.environment_url, textValue(deploymentStatus.target_url, repositoryUrl));
    return [normalized({
      externalId: `${deliveryId}:deployment-status`, timestamp: isoTime(deploymentStatus.created_at), service: repositoryName,
      kind: failed ? "alert" : successful ? "deploy" : "metric",
      title: `Deployment ${state} in ${environment}`,
      detail: textValue(deploymentStatus.description, `${repositoryName} deployment reported ${state}.`),
      impactScore: failed ? 78 : successful ? 28 : 44,
      severity: failed ? "high" : "low", sourceUrl: environmentUrl, environment,
      correlationKey: `${repositoryName}:${environment}`,
      metadata: { provider: "github", state, sha: deployment.sha, creator: sender }
    })];
  }

  if (eventName === "workflow_run") {
    const workflow = object(payload.workflow_run);
    const conclusion = textValue(workflow.conclusion, textValue(workflow.status, "unknown")).toLowerCase();
    const failed = ["failure", "timed_out", "cancelled", "action_required"].includes(conclusion);
    return [normalized({
      externalId: `${deliveryId}:workflow`, timestamp: isoTime(workflow.updated_at ?? workflow.created_at), service: repositoryName,
      kind: failed ? "alert" : "deploy",
      title: `${textValue(workflow.name, "Deployment workflow")} ${conclusion}`,
      detail: `${sender}'s ${textValue(workflow.event, "workflow")} run on ${textValue(workflow.head_branch, "unknown branch")} concluded ${conclusion}.`,
      impactScore: failed ? 76 : 26, severity: failed ? "high" : "low",
      sourceUrl: textValue(workflow.html_url, repositoryUrl),
      correlationKey: `${repositoryName}:${textValue(workflow.head_sha, textValue(workflow.id))}`,
      metadata: { provider: "github", conclusion, sha: workflow.head_sha, runNumber: workflow.run_number }
    })];
  }

  if (eventName === "push") {
    const headCommit = object(payload.head_commit);
    const ref = textValue(payload.ref, "unknown ref");
    return [normalized({
      externalId: `${deliveryId}:push`, timestamp: isoTime(headCommit.timestamp), service: repositoryName, kind: "deploy",
      title: `Code pushed to ${ref.replace("refs/heads/", "")}`,
      detail: textValue(headCommit.message, `${sender} pushed ${array(payload.commits).length} commit(s).`),
      impactScore: 18, sourceUrl: textValue(headCommit.url, repositoryUrl),
      correlationKey: `${repositoryName}:${textValue(payload.after, ref)}`,
      metadata: { provider: "github", ref, sha: payload.after, pusher: sender }
    })];
  }

  return [];
}

function normalizeOtelTraces(payload: JsonRecord, deliveryId: string): NormalizedSignal[] {
  const signals: NormalizedSignal[] = [];
  for (const resourceSpanValue of array(payload.resourceSpans)) {
    const resourceSpan = object(resourceSpanValue);
    const resourceAttributes = attributes(object(resourceSpan.resource).attributes);
    const service = textValue(resourceAttributes["service.name"], "unknown-service");
    const environment = textValue(resourceAttributes["deployment.environment.name"] ?? resourceAttributes["deployment.environment"]);
    for (const scopeSpanValue of array(resourceSpan.scopeSpans)) {
      for (const spanValue of array(object(scopeSpanValue).spans)) {
        const span = object(spanValue);
        const spanAttributes = attributes(span.attributes);
        const statusCode = numberValue(object(span.status).code);
        const httpStatus = numberValue(spanAttributes["http.response.status_code"] ?? spanAttributes["http.status_code"]);
        const start = BigInt(String(span.startTimeUnixNano ?? "0"));
        const end = BigInt(String(span.endTimeUnixNano ?? span.startTimeUnixNano ?? "0"));
        const durationMs = Number((end - start) / 1_000_000n);
        const failed = statusCode === 2 || httpStatus >= 500;
        const slow = durationMs >= 2_000;
        if (!failed && !slow) continue;
        const traceId = textValue(span.traceId);
        const spanId = textValue(span.spanId, `${signals.length}`);
        const impact = failed ? Math.min(96, 76 + Math.round(Math.min(20, durationMs / 500))) : Math.min(72, 48 + Math.round(durationMs / 500));
        signals.push(normalized({
          externalId: `${deliveryId}:span:${spanId}`, timestamp: nanoTime(span.startTimeUnixNano), service,
          kind: failed ? "alert" : "metric", title: `${failed ? "Failed" : "Slow"} span: ${textValue(span.name, "unnamed operation")}`,
          detail: `${durationMs}ms span${httpStatus ? ` returned HTTP ${httpStatus}` : ""}${object(span.status).message ? ` — ${String(object(span.status).message)}` : ""}.`,
          impactScore: impact, traceId, correlationKey: traceId || `${service}:${spanId}`, environment,
          metadata: { provider: "opentelemetry", signal: "trace", spanId, durationMs, httpStatus, attributes: spanAttributes }
        }));
      }
    }
  }
  return signals;
}

function normalizeOtelLogs(payload: JsonRecord, deliveryId: string): NormalizedSignal[] {
  const signals: NormalizedSignal[] = [];
  for (const resourceLogValue of array(payload.resourceLogs)) {
    const resourceLog = object(resourceLogValue);
    const resourceAttributes = attributes(object(resourceLog.resource).attributes);
    const service = textValue(resourceAttributes["service.name"], "unknown-service");
    const environment = textValue(resourceAttributes["deployment.environment.name"] ?? resourceAttributes["deployment.environment"]);
    for (const scopeLogValue of array(resourceLog.scopeLogs)) {
      for (const logValue of array(object(scopeLogValue).logRecords)) {
        const log = object(logValue);
        const severityNumber = numberValue(log.severityNumber);
        if (severityNumber < 13) continue;
        const logAttributes = attributes(log.attributes);
        const traceId = textValue(log.traceId);
        const body = object(log.body);
        const message = textValue(body.stringValue, textValue(log.severityText, "Operational log signal"));
        const failed = severityNumber >= 17;
        const external = textValue(log.spanId, createHash("sha256").update(`${message}:${String(log.timeUnixNano)}`).digest("hex").slice(0, 16));
        signals.push(normalized({
          externalId: `${deliveryId}:log:${external}`, timestamp: nanoTime(log.timeUnixNano ?? log.observedTimeUnixNano), service,
          kind: failed ? "alert" : "metric", title: `${textValue(log.severityText, failed ? "Error" : "Warning")} log from ${service}`,
          detail: message.slice(0, 1200), impactScore: failed ? 78 : 54, traceId,
          correlationKey: traceId || `${service}:${Math.floor(new Date(nanoTime(log.timeUnixNano)).getTime() / 300_000)}`,
          environment, metadata: { provider: "opentelemetry", signal: "log", severityNumber, attributes: logAttributes }
        }));
      }
    }
  }
  return signals;
}

function normalizeOtelMetrics(payload: JsonRecord, deliveryId: string): NormalizedSignal[] {
  const signals: NormalizedSignal[] = [];
  for (const resourceMetricValue of array(payload.resourceMetrics)) {
    const resourceMetric = object(resourceMetricValue);
    const resourceAttributes = attributes(object(resourceMetric.resource).attributes);
    const service = textValue(resourceAttributes["service.name"], "unknown-service");
    const environment = textValue(resourceAttributes["deployment.environment.name"] ?? resourceAttributes["deployment.environment"]);
    for (const scopeMetricValue of array(resourceMetric.scopeMetrics)) {
      for (const metricValue of array(object(scopeMetricValue).metrics)) {
        const metric = object(metricValue);
        const name = textValue(metric.name, "unnamed.metric");
        const metricName = name.toLowerCase();
        if (!/(error|failure|latency|duration|timeout|retry|saturation)/.test(metricName)) continue;
        const data = object(metric.gauge ?? metric.sum ?? metric.histogram ?? metric.exponentialHistogram);
        for (const [index, pointValue] of array(data.dataPoints).entries()) {
          const point = object(pointValue);
          const value = numberValue(point.asDouble ?? point.asInt ?? point.sum ?? point.count);
          const pointAttributes = attributes(point.attributes);
          const impact = /(error|failure|timeout)/.test(metricName) ? 68 : /(latency|duration|saturation)/.test(metricName) ? 58 : 48;
          const timestamp = nanoTime(point.timeUnixNano ?? point.startTimeUnixNano);
          signals.push(normalized({
            externalId: `${deliveryId}:metric:${name}:${index}:${String(point.timeUnixNano ?? "now")}`, timestamp, service,
            kind: impact >= 65 ? "alert" : "metric", title: `${name} crossed the ingestion filter`,
            detail: `${name} reported ${value}${textValue(metric.unit) ? ` ${textValue(metric.unit)}` : ""}.`,
            impactScore: impact, correlationKey: `${service}:${Math.floor(new Date(timestamp).getTime() / 300_000)}`, environment,
            metadata: { provider: "opentelemetry", signal: "metric", metric: name, value, unit: metric.unit, attributes: pointAttributes }
          }));
        }
      }
    }
  }
  return signals;
}

function normalizeGenericEvent(inputValue: unknown, index: number, deliveryId: string): NormalizedSignal | null {
  const input = object(inputValue);
  const service = textValue(input.service, textValue(object(input.labels).service, textValue(input.source, "external-service")));
  const title = textValue(input.title, textValue(input.name, textValue(input.message, "External operational signal")));
  const detail = textValue(input.detail, textValue(input.description, textValue(input.message, title)));
  const kindCandidate = textValue(input.kind, "metric") as EventKind;
  const kind: EventKind = ["alert", "deploy", "dependency", "metric", "action", "recovery"].includes(kindCandidate) ? kindCandidate : "metric";
  const impactScore = boundedImpact(input.impactScore ?? input.impact_score, kind === "alert" ? 75 : kind === "recovery" ? 22 : 48);
  const externalId = textValue(input.eventId ?? input.event_id ?? input.id, `${deliveryId}:event:${index}`);
  if (!title || !detail) return null;
  return normalized({
    externalId, timestamp: isoTime(input.timestamp ?? input.occurredAt ?? input.startsAt), service, kind, title, detail,
    impactScore, severity: severityValue(input.severity, severityForImpact(impactScore)),
    correlationKey: textValue(input.correlationKey ?? input.incidentKey ?? input.groupKey),
    traceId: textValue(input.traceId ?? input.trace_id), sourceUrl: textValue(input.sourceUrl ?? input.url ?? input.generatorURL),
    environment: textValue(input.environment), metadata: { provider: "generic", ...object(input.metadata), labels: input.labels, tags: input.tags }
  });
}

function normalizeGeneric(payload: JsonRecord, deliveryId: string): NormalizedSignal[] {
  if (Array.isArray(payload.alerts)) {
    return payload.alerts.flatMap((alert, index) => {
      const item = object(alert);
      const labels = object(item.labels);
      const annotations = object(item.annotations);
      const status = textValue(payload.status, textValue(item.status, "firing"));
      return [normalized({
        externalId: textValue(item.fingerprint, `${deliveryId}:alert:${index}`), timestamp: isoTime(item.startsAt ?? item.endsAt),
        service: textValue(labels.service, textValue(labels.alertname, "grafana-alert")), kind: status === "resolved" ? "recovery" : "alert",
        title: textValue(annotations.summary, textValue(labels.alertname, "Grafana alert")),
        detail: textValue(annotations.description, textValue(payload.title, `Alert status: ${status}`)),
        impactScore: status === "resolved" ? 20 : 78, correlationKey: textValue(item.fingerprint),
        sourceUrl: textValue(item.generatorURL, textValue(payload.externalURL)), metadata: { provider: "grafana", labels }
      })];
    });
  }
  const source = Array.isArray(payload.events) ? payload.events : [payload];
  return source.map((event, index) => normalizeGenericEvent(event, index, deliveryId)).filter((event): event is NormalizedSignal => Boolean(event));
}

export function normalizePayload(provider: IntegrationProvider, payload: JsonRecord, deliveryId: string, eventName = "") {
  if (provider === "github") return normalizeGitHub(payload, eventName, deliveryId);
  if (provider === "otel") {
    if (payload.resourceSpans) return normalizeOtelTraces(payload, deliveryId);
    if (payload.resourceLogs) return normalizeOtelLogs(payload, deliveryId);
    if (payload.resourceMetrics) return normalizeOtelMetrics(payload, deliveryId);
    return [];
  }
  return normalizeGeneric(payload, deliveryId);
}

function requestToken(req: Request) {
  const authorization = req.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return req.get("x-replayops-token") ?? "";
}

async function receive(req: RawRequest, res: Response) {
  const integrationId = textValue(req.params.integrationId);
  const integration = await repository.getIntegrationTarget(integrationId);
  if (!integration || integration.status !== "active") {
    res.status(404).json({ error: "Active connector not found." });
    return;
  }

  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (integration.provider === "github") {
    const signature = req.get("x-hub-signature-256") ?? "";
    if (!signature || !verifyGitHubSignature(rawBody, integration.id, signature)) {
      res.status(401).json({ error: "GitHub signature verification failed." });
      return;
    }
  } else if (!constantTimeMatch(requestToken(req), deriveIntegrationToken(integration.id))) {
    res.status(401).json({ error: "Connector token is missing or invalid." });
    return;
  }

  if (req.is("application/x-protobuf")) {
    res.status(415).json({ error: "Use OTLP HTTP/JSON for the free ReplayOps receiver." });
    return;
  }

  const payload = object(req.body);
  const externalId = req.get("x-github-delivery") ?? req.get("x-request-id") ?? createHash("sha256").update(rawBody).digest("hex").slice(0, 32) ?? randomUUID();
  const eventName = req.get("x-github-event") ?? textValue(req.params.signal);
  const batch: IngestionBatch = { externalId, signals: normalizePayload(integration.provider, payload, externalId, eventName) };
  const result = await repository.ingest(integration, batch);
  res.status(result.status === "duplicate" ? 200 : 202).json(result);
}

export const ingestionRouter = Router();
ingestionRouter.post("/:integrationId", receive);
ingestionRouter.post("/:integrationId/v1/:signal", receive);
