import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "./config.js";
import { repository } from "./repository.js";
import { ingestionQueue } from "./queue.js";
import { workspaceService } from "./workspace.js";
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
const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";
const isoTime = (value: unknown) => {
  if (value === undefined || value === null || value === "") return UNKNOWN_TIME;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? UNKNOWN_TIME : date.toISOString();
};
const nanoTime = (value: unknown) => {
  try {
    return new Date(Number(BigInt(String(value)) / 1_000_000n)).toISOString();
  } catch {
    return UNKNOWN_TIME;
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
  const repositoryId = textValue(repository.node_id, String(repository.id ?? ""));
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
      metadata: { provider: "github", eventType: "deployment", repositoryId, repository: repositoryName, deploymentId: deployment.id, deploymentEnvironment: environment, ref, branch: ref, sha: deployment.sha, creator: sender, sourceUrl: repositoryUrl }
    })];
  }

  if (eventName === "deployment_status") {
    const deployment = object(payload.deployment);
    const deploymentStatus = object(payload.deployment_status);
    const state = textValue(deploymentStatus.state, "unknown").toLowerCase();
    const failed = ["failure", "error"].includes(state);
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
      metadata: { provider: "github", eventType: "deployment_status", repositoryId, repository: repositoryName, deploymentId: deployment.id, deploymentEnvironment: environment, branch: textValue(deployment.ref) || undefined, state, sha: deployment.sha, creator: sender, sourceUrl: environmentUrl, logUrl: textValue(deploymentStatus.log_url, textValue(deploymentStatus.target_url)) || undefined, productionHealthMeasured: false }
    })];
  }

  if (eventName === "workflow_run") {
    const workflow = object(payload.workflow_run);
    // Queued and in-progress runs are not outcomes; only the completed run is evidence.
    if (textValue(workflow.status) && textValue(workflow.status) !== "completed") return [];
    const conclusion = textValue(workflow.conclusion, textValue(workflow.status, "unknown")).toLowerCase();
    const failed = ["failure", "timed_out", "action_required"].includes(conclusion);
    return [normalized({
      externalId: `${deliveryId}:workflow`, timestamp: isoTime(workflow.updated_at ?? workflow.created_at), service: repositoryName,
      kind: failed ? "alert" : "metric",
      title: `${textValue(workflow.name, "Deployment workflow")} ${conclusion}`,
      detail: `${sender}'s ${textValue(workflow.event, "workflow")} run on ${textValue(workflow.head_branch, "unknown branch")} concluded ${conclusion}.`,
      impactScore: failed ? 76 : 26, severity: failed ? "high" : "low",
      sourceUrl: textValue(workflow.html_url, repositoryUrl),
      correlationKey: `${repositoryName}:${textValue(workflow.head_sha, textValue(workflow.id))}`,
      metadata: { provider: "github", eventType: "workflow_run", repositoryId, repository: repositoryName, workflowId: workflow.workflow_id, workflow: workflow.name, workflowName: workflow.name, runId: workflow.id, logUrl: textValue(workflow.html_url) || undefined, runNumber: workflow.run_number, attempt: workflow.run_attempt ?? 1, runAttempt: workflow.run_attempt ?? 1, status: workflow.status, conclusion, sha: workflow.head_sha, branch: workflow.head_branch, sourceUrl: workflow.html_url, ciOnly: true, productionHealthMeasured: false }
    })];
  }

  if (eventName === "push") {
    const headCommit = object(payload.head_commit);
    const ref = textValue(payload.ref, "unknown ref");
    return [normalized({
      externalId: `${deliveryId}:push`, timestamp: isoTime(headCommit.timestamp), service: repositoryName, kind: "metric",
      title: `Code pushed to ${ref.replace("refs/heads/", "")}`,
      detail: textValue(headCommit.message).split("\n")[0]?.trim() || `${sender} pushed ${array(payload.commits).length} commit(s).`,
      impactScore: 18, sourceUrl: textValue(headCommit.url, repositoryUrl),
      correlationKey: `${repositoryName}:${textValue(payload.after, ref)}`,
      metadata: { provider: "github", eventType: "push", repositoryId, repository: repositoryName, ref, branch: ref.replace("refs/heads/", ""), sha: payload.after, beforeSha: payload.before, pusher: sender, sourceUrl: textValue(headCommit.url, repositoryUrl), productionHealthMeasured: false }
    })];
  }

  return [];
}

function normalizeOtelTraces(payload: JsonRecord, deliveryId: string, healthySampleRate = .05): NormalizedSignal[] {
  // Deterministic per trace, so every span of a sampled healthy trace is kept together.
  const sampleBuckets = 10_000;
  const sampleThreshold = Math.round(Math.min(1, Math.max(0, healthySampleRate)) * sampleBuckets);
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
        const traceId = textValue(span.traceId);
        const spanId = textValue(span.spanId, `${signals.length}`);
        const healthySample = !failed && !slow && Number.parseInt(createHash("sha256").update(traceId || spanId).digest("hex").slice(0, 8), 16) % sampleBuckets < sampleThreshold;
        if (!failed && !slow && !healthySample) continue;
        const impact = failed ? Math.min(96, 76 + Math.round(Math.min(20, durationMs / 500))) : Math.min(72, 48 + Math.round(durationMs / 500));
        signals.push(normalized({
          externalId: `${deliveryId}:span:${spanId}`, timestamp: nanoTime(span.startTimeUnixNano), service,
          kind: failed ? "alert" : "metric", title: `${failed ? "Failed" : slow ? "Slow" : "Healthy sampled"} span: ${textValue(span.name, "unnamed operation")}`,
          detail: `${durationMs}ms span${httpStatus ? ` returned HTTP ${httpStatus}` : ""}${object(span.status).message ? ` — ${String(object(span.status).message)}` : ""}.`,
          impactScore: healthySample ? 8 : impact, severity: healthySample ? "low" : undefined, traceId, correlationKey: traceId || `${service}:${spanId}`, environment,
          metadata: { provider: "opentelemetry", signal: "trace", traceCompleteness: "retained-span-only", traceId, spanId, parentSpanId: textValue(span.parentSpanId), spanKind: span.kind, operation: span.name, method: spanAttributes["http.request.method"] ?? spanAttributes["http.method"], durationMs, httpStatus, route: spanAttributes["http.route"] ?? spanAttributes["url.path"] ?? span.name, release: resourceAttributes["service.version"], region: resourceAttributes["cloud.region"], environment, scopeName: object(scopeSpanValue).scope ? object(object(scopeSpanValue).scope).name : undefined, cohortRole: healthySample ? "healthy" : failed ? "failing" : "slow", sampleRate: healthySample ? healthySampleRate : 1, attributes: spanAttributes }
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
        const metricType = metric.gauge ? "gauge" : metric.sum ? "sum" : metric.histogram ? "histogram" : metric.exponentialHistogram ? "exponential_histogram" : "unsupported";
        const data = object(metric.gauge ?? metric.sum ?? metric.histogram ?? metric.exponentialHistogram);
        for (const [index, pointValue] of array(data.dataPoints).entries()) {
          const point = object(pointValue);
          const rawValue = point.asDouble ?? point.asInt ?? point.sum ?? point.count;
          const parsedValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
          const numericValid = rawValue !== undefined && rawValue !== null && Number.isFinite(parsedValue);
          const value = numericValid ? parsedValue : null;
          const pointAttributes = attributes(point.attributes);
          const impact = 28;
          const timestamp = nanoTime(point.timeUnixNano ?? point.startTimeUnixNano);
          const intervalStart = nanoTime(point.startTimeUnixNano);
          const unit = textValue(metric.unit);
          const aggregationTemporality = data.aggregationTemporality ?? null;
          signals.push(normalized({
            externalId: `${deliveryId}:metric:${name}:${index}:${String(point.timeUnixNano ?? "now")}`, timestamp, service,
            kind: "metric", title: `${name} measurement received`,
            detail: numericValid ? `${name} reported ${value}${unit ? ` ${unit}` : ""}. No threshold conclusion was inferred.` : `${name} contained no valid numeric measurement.`,
            impactScore: impact, correlationKey: `${service}:${Math.floor(new Date(timestamp).getTime() / 300_000)}`, environment,
            metadata: { provider: "opentelemetry", signal: "metric", metric: name, metricType, value, numericValid, unit, aggregationTemporality, isMonotonic: data.isMonotonic ?? null, intervalStart, intervalEnd: timestamp, resourceDimensions: resourceAttributes, attributes: pointAttributes, recoveryEligibility: metricType === "gauge" || metricType === "sum" ? "requires-configured-evaluator" : "unsupported-aggregation" }
          }));
        }
      }
    }
  }
  return signals;
}

export type ChangeType = "deploy" | "feature_flag" | "config" | "migration" | "infra" | "rollback";
const changeTypes: ChangeType[] = ["deploy", "feature_flag", "config", "migration", "infra", "rollback"];
const changeAliases: Record<string, ChangeType> = { flag: "feature_flag", "feature-flag": "feature_flag", featureflag: "feature_flag", configuration: "config", "config-change": "config", schema: "migration", infrastructure: "infra", terraform: "infra", release: "deploy", deployment: "deploy", revert: "rollback" };
const changeTypeOf = (value: string): ChangeType | undefined => {
  const key = value.trim().toLowerCase().replace(/\s+/g, "_");
  return changeTypes.includes(key as ChangeType) ? key as ChangeType : changeAliases[key];
};

/**
 * Change events — deploys from any CD tool, feature-flag flips, config edits, migrations — are the most
 * common incident cause, so they are first-class suspects even when they don't come from GitHub.
 */
function changeTitle(changeType: ChangeType, service: string, input: JsonRecord) {
  const version = textValue(input.version ?? input.release);
  const key = textValue(input.flag ?? input.flagKey ?? input.key ?? input.setting);
  const to = input.newValue ?? input.to ?? input.value;
  if (changeType === "feature_flag") return `Feature flag ${key || "changed"}${to !== undefined ? ` set to ${String(to)}` : ""} on ${service}`;
  if (changeType === "config") return `Config ${key || "change"}${to !== undefined ? ` set to ${String(to)}` : ""} on ${service}`;
  if (changeType === "migration") return `Database migration ${version || key || "applied"} on ${service}`;
  if (changeType === "infra") return `Infrastructure change${key ? ` to ${key}` : ""} for ${service}`;
  if (changeType === "rollback") return `Rolled back ${service}${version ? ` to ${version}` : ""}`;
  return `Deployed ${service}${version ? ` ${version}` : ""}`;
}

function normalizeGenericEvent(inputValue: unknown, index: number, deliveryId: string): NormalizedSignal | null {
  const input = object(inputValue);
  const service = textValue(input.service, textValue(object(input.labels).service, textValue(input.source, "external-service")));
  const rawKind = textValue(input.kind).toLowerCase();
  // `kind: "change" | "deploy" | "feature_flag" | …` or an explicit `changeType` marks a change; an alert that merely mentions a changeType stays an alert.
  const changeType = changeTypeOf(textValue(input.changeType ?? input.change_type)) ?? (rawKind === "change" ? "deploy" : changeTypeOf(rawKind));
  const isChange = Boolean(changeType) && (!rawKind || rawKind === "change" || Boolean(changeTypeOf(rawKind)));
  const title = textValue(input.title, textValue(input.name, textValue(input.message, isChange ? changeTitle(changeType!, service, input) : "External operational signal")));
  const detail = textValue(input.detail, textValue(input.description, textValue(input.message, title)));
  const kindCandidate = (isChange ? "deploy" : rawKind || "metric") as EventKind;
  const kind: EventKind = ["alert", "deploy", "dependency", "metric", "action", "recovery"].includes(kindCandidate) ? kindCandidate : "metric";
  const impactScore = boundedImpact(input.impactScore ?? input.impact_score, kind === "alert" ? 75 : kind === "recovery" ? 22 : isChange ? 40 : 48);
  const externalId = textValue(input.eventId ?? input.event_id ?? input.id, `${deliveryId}:event:${index}`);
  if (!title || !detail) return null;
  const change = isChange ? {
    changeType, version: textValue(input.version ?? input.release) || undefined, previousVersion: textValue(input.previousVersion ?? input.previous_version) || undefined,
    sha: textValue(input.sha ?? input.commit) || undefined, author: textValue(input.author ?? input.actor ?? input.user) || undefined,
    flagKey: textValue(input.flag ?? input.flagKey ?? input.key ?? input.setting) || undefined,
    previousValue: input.previousValue ?? input.from, newValue: input.newValue ?? input.to ?? input.value,
    branch: textValue(input.branch) || undefined
  } : {};
  return normalized({
    externalId, timestamp: isoTime(input.timestamp ?? input.occurredAt ?? input.startsAt), service, kind, title, detail,
    impactScore, severity: severityValue(input.severity, severityForImpact(impactScore)),
    correlationKey: textValue(input.correlationKey ?? input.incidentKey ?? input.groupKey),
    traceId: textValue(input.traceId ?? input.trace_id), sourceUrl: textValue(input.sourceUrl ?? input.url ?? input.generatorURL),
    environment: textValue(input.environment), metadata: { provider: "generic", ...object(input.metadata), ...change, labels: input.labels, tags: input.tags }
  });
}

// Request and response bodies often hold customer data; drop them unless the workspace opted in.
const BODY_KEY = (key: string) => /(^|[._-])(body|payload)$/i.test(key) || /(request|response)[._-]?body/i.test(key);
function withoutBodies(value: unknown, depth = 0): { value: unknown; dropped: number } {
  if (depth > 6 || !value || typeof value !== "object") return { value, dropped: 0 };
  if (Array.isArray(value)) {
    let dropped = 0;
    const items = value.map((item) => { const next = withoutBodies(item, depth + 1); dropped += next.dropped; return next.value; });
    return { value: items, dropped };
  }
  let dropped = 0;
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (BODY_KEY(key)) { dropped += 1; continue; }
    const next = withoutBodies(item, depth + 1);
    dropped += next.dropped;
    result[key] = next.value;
  }
  return { value: result, dropped };
}
export function stripCapturedBodies(signals: NormalizedSignal[]) {
  return signals.map((signal) => {
    const { value, dropped } = withoutBodies(signal.metadata);
    return dropped ? { ...signal, metadata: { ...(value as JsonRecord), bodiesDropped: dropped } } : signal;
  });
}

/** Fixed-window limiter for the public receiver, so a leaked URL or noisy exporter can't flood the database. */
const rateWindows = new Map<string, { start: number; count: number }>();
export function allowIngestRequest(key: string, limit: number, now = Date.now(), windowMs = 60_000) {
  const current = rateWindows.get(key);
  if (!current || now - current.start >= windowMs) {
    if (rateWindows.size > 20_000) for (const [entry, window] of rateWindows) if (now - window.start >= windowMs) rateWindows.delete(entry);
    rateWindows.set(key, { start: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  current.count += 1;
  return current.count <= limit ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.start + windowMs - now) / 1000)) };
}
const perConnectorLimit = () => Number(process.env.INGEST_RATE_LIMIT_PER_MINUTE ?? 300);
const perAddressLimit = () => Number(process.env.INGEST_RATE_LIMIT_PER_IP_PER_MINUTE ?? 600);

function normalizeGeneric(payload: JsonRecord, deliveryId: string): NormalizedSignal[] {
  if (Array.isArray(payload.alerts)) {
    return payload.alerts.flatMap((alert, index) => {
      const item = object(alert);
      const labels = object(item.labels);
      const annotations = object(item.annotations);
      const status = textValue(item.status, textValue(payload.status, "firing")).toLowerCase();
      const fingerprint = textValue(item.fingerprint, `alert:${index}`);
      const startsAt = isoTime(item.startsAt);
      const endsAt = isoTime(item.endsAt);
      const observedAt = status === "resolved" && endsAt !== UNKNOWN_TIME ? endsAt : startsAt;
      const environment = textValue(labels.environment, textValue(labels.env, textValue(labels.deployment_environment, "Unknown")));
      return [normalized({
        externalId: `${deliveryId}:grafana:${fingerprint}:${status}:${observedAt}`, timestamp: observedAt,
        service: textValue(labels.service, textValue(labels.alertname, "grafana-alert")), kind: status === "resolved" ? "recovery" : "alert",
        title: textValue(annotations.summary, textValue(labels.alertname, "Grafana alert")),
        detail: textValue(annotations.description, textValue(payload.title, `Alert status: ${status}`)),
        impactScore: status === "resolved" ? 20 : 78, correlationKey: fingerprint,
        sourceUrl: textValue(item.generatorURL, textValue(payload.externalURL)), environment,
        metadata: { provider: "grafana", signal: "alert-lifecycle", alertIdentity: fingerprint, occurrenceIdentity: `${fingerprint}:${status}:${observedAt}`, status, startsAt, endsAt, timestampValid: observedAt !== UNKNOWN_TIME, environment, labels, values: item.values ?? payload.values ?? null, ruleUrl: item.generatorURL ?? null, ruleReference: labels.alertname ?? null, stateReason: annotations.stateReason ?? annotations.reason ?? item.valueString ?? null, measurementProvenance: "grafana-webhook" }
      })];
    });
  }
  const source = Array.isArray(payload.events) ? payload.events : [payload];
  return source.map((event, index) => normalizeGenericEvent(event, index, deliveryId)).filter((event): event is NormalizedSignal => Boolean(event));
}

export function normalizePayload(provider: IntegrationProvider, payload: JsonRecord, deliveryId: string, eventName = "", healthySampleRate = .05) {
  if (provider === "github") return normalizeGitHub(payload, eventName, deliveryId);
  if (provider === "otel") {
    if (payload.resourceSpans) return normalizeOtelTraces(payload, deliveryId, healthySampleRate);
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
  for (const [key, limit] of [[`ip:${req.ip ?? "unknown"}`, perAddressLimit()], [`connector:${integrationId}`, perConnectorLimit()]] as const) {
    const verdict = allowIngestRequest(key, limit);
    if (!verdict.allowed) {
      res.setHeader("retry-after", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: `Too many deliveries; retry in ${verdict.retryAfterSeconds}s. Batch events or raise INGEST_RATE_LIMIT_PER_MINUTE.` });
      return;
    }
  }
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
  const privacy = await workspaceService.privacyForOrganization(integration.organizationId);
  const signals = normalizePayload(integration.provider, payload, externalId, eventName, integration.healthySampleRate);
  const batch: IngestionBatch = { externalId, signals: privacy.captureRequestBodies ? signals : stripCapturedBodies(signals) };
  const queued = await ingestionQueue.enqueue(integration, batch);
  if (queued.duplicate && queued.job.status === "completed") {
    res.status(200).json({ status: "duplicate", acceptedSignals: 0, incidentIds: [], queueId: queued.job.id });
    return;
  }
  try {
    const result = await ingestionQueue.process(queued.job.id);
    res.status(result.status === "duplicate" ? 200 : 202).json(result);
  } catch {
    res.status(202).json({ status: "queued", acceptedSignals: 0, incidentIds: [], queueId: queued.job.id });
  }
}

export const ingestionRouter = Router();
ingestionRouter.post("/:integrationId", receive);
ingestionRouter.post("/:integrationId/v1/:signal", receive);
