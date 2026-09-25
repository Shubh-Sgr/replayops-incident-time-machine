import { redactSensitiveText } from "./ai.js";
import type { Incident, IncidentEvent } from "./types.js";

const text = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const activeEvents = (incident: Incident) => incident.events.filter((event) => event.evidenceState !== "excluded");

export function buildInvestigationIntelligence(incident: Incident, history: Incident[]) {
  const events = activeEvents(incident);
  const traceEvents = events.filter((event) => event.metadata?.signal === "trace");
  const healthy = traceEvents.filter((event) => event.metadata?.cohortRole === "healthy");
  const failing = traceEvents.filter((event) => event.metadata?.cohortRole === "failing");
  const healthyRates = [...new Set(healthy.map((event) => number(event.metadata?.sampleRate)).filter((value): value is number => value !== undefined))];
  const routes = [...new Set(traceEvents.map((event) => text(event.metadata?.route)).filter((value): value is string => Boolean(value)))];
  const releases = [...new Set(traceEvents.map((event) => text(event.metadata?.release)).filter((value): value is string => Boolean(value)))];
  const regions = [...new Set(traceEvents.map((event) => text(event.metadata?.region)).filter((value): value is string => Boolean(value)))];
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const window = timestamps.length ? { start: new Date(Math.min(...timestamps)).toISOString(), end: new Date(Math.max(...timestamps)).toISOString() } : null;

  const changes = events.filter((event) => event.kind === "deploy" || /config|feature flag|schema|migration|infrastructure|terraform|release/i.test(`${event.title} ${event.detail}`)).map((event) => ({
    eventId: event.id,
    timestamp: event.timestamp,
    type: event.kind === "deploy" ? "code/deployment" : /flag/i.test(`${event.title} ${event.detail}`) ? "feature flag" : /schema|migration/i.test(`${event.title} ${event.detail}`) ? "schema" : /config/i.test(`${event.title} ${event.detail}`) ? "configuration" : "infrastructure",
    title: event.title,
    service: event.service,
    sourceUrl: text(event.metadata?.sourceUrl),
    version: text(event.metadata?.sha ?? event.metadata?.release ?? event.metadata?.ref),
    relation: "Occurred near the incident window; temporal proximity is not causal evidence.",
    evidenceFor: events.some((candidate) => candidate.timestamp >= event.timestamp && candidate.service === event.service && candidate.kind === "alert") ? "A same-service failure was observed after this change." : "No same-service failure follows this change in retained evidence.",
    evidenceAgainst: healthy.some((candidate) => candidate.timestamp >= event.timestamp && candidate.service === event.service) ? "Sampled healthy requests also exist after this change." : "No matched healthy control is retained after this change."
  }));

  const explicitFailed = events.map((event) => number(event.metadata?.failedRequests)).find((value) => value !== undefined);
  const explicitTotal = events.map((event) => number(event.metadata?.totalRequests)).find((value) => value !== undefined);
  const impact = explicitFailed !== undefined && explicitTotal !== undefined && explicitTotal > 0
    ? { measured:true, failedRequests:explicitFailed, totalRequests:explicitTotal, rate:explicitFailed / explicitTotal, source:"telemetry metadata", unknowns:[] as string[] }
    : { measured:false, failedRequests:failing.length || null, totalRequests:null, rate:null, source:"retained trace sample", unknowns:["The complete request denominator was not provided.", ...(healthyRates.includes(.05) ? ["Healthy traces are sampled at 5% while failing traces are retained at 100%; raw sample counts are not a population failure rate."] : [])] };

  const comparisons = history.filter((item) => item.id !== incident.id && item.service === incident.service).map((item) => {
    const currentKinds = new Set(events.map((event) => event.kind));
    const otherKinds = new Set(activeEvents(item).map((event) => event.kind));
    const similarities = [...currentKinds].filter((kind) => otherKinds.has(kind)).map((kind) => `Both contain ${kind} evidence`);
    const differences = [...new Set([...currentKinds, ...otherKinds])].filter((kind) => currentKinds.has(kind) !== otherKinds.has(kind)).map((kind) => `${kind} evidence appears in only one investigation`);
    if ((incident.environment ?? "unknown") !== (item.environment ?? "unknown")) differences.unshift(`Environment differs: ${incident.environment ?? "unknown"} vs ${item.environment ?? "unknown"}`);
    return { incidentId:item.id, code:item.code, title:item.title, status:item.status, similarities:similarities.slice(0,3), differences:differences.slice(0,3), applicability: differences.length ? "Use as a lead only; differing conditions may invalidate the prior mitigation." : "Conditions look similar, but validate against current evidence before reusing a fix.", updatedAt:item.updatedAt };
  }).filter((item) => item.similarities.length).slice(0,5);

  const querySuggestions = [
    { id:"failing-vs-healthy", label:"Compare failing and healthy requests", source:"OpenTelemetry", query:`service.name = \"${incident.service}\" AND deployment.environment = \"${incident.environment ?? "unknown"}\" AND time >= \"${window?.start ?? incident.startedAt}\"`, limitation: healthy.length ? `Healthy controls are sampled (${healthy.length} retained).` : "No healthy control sample is retained; enable bounded healthy-span sampling." },
    { id:"dependency-divergence", label:"Find first divergent dependency span", source:"Tracing backend", query:`trace service=${incident.service} environment=${incident.environment ?? "unknown"} from=${window?.start ?? incident.startedAt} to=${window?.end ?? incident.updatedAt}`, limitation:"The generated query is read-only and must be adapted to the connected provider syntax." }
  ];

  return {
    generatedAt:new Date().toISOString(),
    evidenceRevision:incident.evidenceRevision ?? incident.updatedAt,
    cohorts:{ healthy:{ sampleCount:healthy.length, medianDurationMs:median(healthy.map((event) => number(event.metadata?.durationMs)).filter((value): value is number => value !== undefined)) }, failing:{ sampleCount:failing.length, medianDurationMs:median(failing.map((event) => number(event.metadata?.durationMs)).filter((value): value is number => value !== undefined)) }, routes, releases, regions, window, limitations:[...(healthy.length ? [`Healthy cohort uses ${Math.round((healthyRates[0] ?? .05) * 100)}% deterministic sampling.`] : ["No matched healthy cohort is available."]), ...(failing.length ? [] : ["No failing OTLP request spans are retained."]), "Counts reflect retained evidence, not total traffic."] },
    changes,
    impact,
    comparisons,
    querySuggestions
  };
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value).text;
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/authorization|cookie|password|secret|token|body|payload/i.test(key)).map(([key, item]) => [key, redactValue(item)]));
  return value;
}

export function buildEvidenceBundle(incident: Incident) {
  const events = activeEvents(incident).map((event: IncidentEvent) => ({
    id:event.id, timestamp:event.timestamp, service:event.service, kind:event.kind,
    title:redactSensitiveText(event.title).text, detail:redactSensitiveText(event.detail).text,
    provenance:event.provenance ?? "unknown", traceId:redactSensitiveText(String(event.metadata?.traceId ?? "")).text,
    sourceUrl:text(event.metadata?.sourceUrl), metadata:redactValue(event.metadata)
  }));
  return {
    schemaVersion:"replayops.evidence-bundle/v1", incidentId:incident.id, code:incident.code,
    evidenceRevision:incident.evidenceRevision ?? incident.updatedAt, generatedAt:new Date().toISOString(),
    expiresAt:new Date(Date.now() + 24 * 60 * 60_000).toISOString(), access:"workspace-member",
    service:incident.service, environment:incident.environment ?? "unknown", events,
    omissions:["Request and response bodies are omitted by default.", "Authorization, cookies, passwords, secrets, tokens, and payload-like metadata keys are removed.", "External dependency state is not included unless represented by a cited event."],
    replayability:{ status:"not-guaranteed", reason:"A bundle is evidence for investigation. It becomes replayable only after an explicit HTTP capture and dependency contract are added." }
  };
}
