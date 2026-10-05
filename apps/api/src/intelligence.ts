import { redactSensitiveText } from "./ai.js";
import { githubChangeRange } from "./diagnosis.js";
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
  // Slow spans are the failing cohort of a latency incident; they are compared against healthy controls too.
  const failing = traceEvents.filter((event) => event.metadata?.cohortRole === "failing" || event.metadata?.cohortRole === "slow");
  const failingScope = failing[0];
  const comparisonDimensions = ["service", "route", "method", "region"] as const;
  const sameDimension = (candidate: IncidentEvent, dimension: typeof comparisonDimensions[number]) => {
    const expected = dimension === "service" ? failingScope?.service : text(failingScope?.metadata?.[dimension]);
    const actual = dimension === "service" ? candidate.service : text(candidate.metadata?.[dimension]);
    return Boolean(expected && actual && expected === actual);
  };
  const healthyCandidates = traceEvents.filter((event) => event.metadata?.cohortRole === "healthy");
  const healthy = failingScope ? healthyCandidates.filter((event) => comparisonDimensions.every((dimension) => sameDimension(event, dimension))) : [];
  const excludedHealthy = healthyCandidates.length - healthy.length;
  const healthyRates = [...new Set(healthy.map((event) => number(event.metadata?.sampleRate)).filter((value): value is number => value !== undefined))];
  const routes = [...new Set(traceEvents.map((event) => text(event.metadata?.route)).filter((value): value is string => Boolean(value)))];
  const releases = [...new Set(traceEvents.map((event) => text(event.metadata?.release)).filter((value): value is string => Boolean(value)))];
  const regions = [...new Set(traceEvents.map((event) => text(event.metadata?.region)).filter((value): value is string => Boolean(value)))];
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const window = timestamps.length ? { start: new Date(Math.min(...timestamps)).toISOString(), end: new Date(Math.max(...timestamps)).toISOString() } : null;

  const changes = events.filter((event) => event.kind === "deploy" || event.metadata?.eventType === "push" || /config|feature flag|schema|migration|infrastructure|terraform|release/i.test(`${event.title} ${event.detail}`)).map((event) => ({
    eventId: event.id,
    timestamp: event.timestamp,
    type: event.kind === "deploy" || event.metadata?.eventType === "push" ? "code/deployment" : /flag/i.test(`${event.title} ${event.detail}`) ? "feature flag" : /schema|migration/i.test(`${event.title} ${event.detail}`) ? "schema" : /config/i.test(`${event.title} ${event.detail}`) ? "configuration" : "infrastructure",
    title: event.title,
    service: event.service,
    sourceUrl: text(event.metadata?.sourceUrl),
    version: text(event.metadata?.sha ?? event.metadata?.release ?? event.metadata?.ref),
    relation: "Occurred near the incident window; temporal proximity is not causal evidence.",
    evidenceFor: events.some((candidate) => candidate.timestamp >= event.timestamp && candidate.service === event.service && candidate.kind === "alert") ? "A same-service failure was observed after this change." : "No same-service failure follows this change in retained evidence.",
    evidenceAgainst: healthy.some((candidate) => candidate.timestamp >= event.timestamp && candidate.service === event.service) ? "Sampled healthy requests also exist after this change." : "No matched healthy control is retained after this change."
  }));

  const impactEvent = events.find((event) => {
    const failed = number(event.metadata?.failedRequests);
    const total = number(event.metadata?.totalRequests);
    return failed !== undefined && total !== undefined && total > 0 && Boolean(event.metadata?.measurementSeriesId && event.metadata?.measurementScope && event.metadata?.intervalStart && event.metadata?.intervalEnd);
  });
  const explicitFailed = number(impactEvent?.metadata?.failedRequests);
  const explicitTotal = number(impactEvent?.metadata?.totalRequests);
  const impact = explicitFailed !== undefined && explicitTotal !== undefined && explicitTotal > 0
    ? { measured:true, failedRequests:explicitFailed, totalRequests:explicitTotal, rate:explicitFailed / explicitTotal, source:`paired telemetry series ${String(impactEvent?.metadata?.measurementSeriesId)}`, unknowns:[] as string[] }
    : { measured:false, failedRequests:failing.length || null, totalRequests:null, rate:null, source:"retained trace sample", unknowns:["The complete request denominator was not provided.", ...(healthyRates.some((rate) => rate < 1) ? [`Healthy traces are sampled at ${Math.round(Math.min(...healthyRates) * 1000) / 10}% while failing traces are retained at 100%; raw sample counts are not a population failure rate.`] : [])] };

  const comparisons = history.filter((item) => item.id !== incident.id && item.service === incident.service).map((item) => {
    const currentKinds = new Set(events.map((event) => event.kind));
    const otherKinds = new Set(item.eventKinds ?? activeEvents(item).map((event) => event.kind));
    const similarities = [...currentKinds].filter((kind) => otherKinds.has(kind)).map((kind) => `Both contain ${kind} evidence`);
    const differences = [...new Set([...currentKinds, ...otherKinds])].filter((kind) => currentKinds.has(kind) !== otherKinds.has(kind)).map((kind) => `${kind} evidence appears in only one investigation`);
    if ((incident.environment ?? "unknown") !== (item.environment ?? "unknown")) differences.unshift(`Environment differs: ${incident.environment ?? "unknown"} vs ${item.environment ?? "unknown"}`);
    return { incidentId:item.id, code:item.code, title:item.title, status:item.status, similarities:similarities.slice(0,3), differences:differences.slice(0,3), applicability: differences.length ? "Use as a lead only; differing conditions may invalidate the prior mitigation." : "Conditions look similar, but validate against current evidence before reusing a fix.", updatedAt:item.updatedAt };
  }).filter((item) => item.similarities.length).slice(0,5);

  const knownEnvironment = incident.environment && incident.environment !== "unknown" ? incident.environment : undefined;
  const affectedServices = [...new Set([incident.service, ...events.map((event) => event.service)])];
  const from = window?.start ?? incident.startedAt;
  const to = window?.end ?? incident.resolvedAt ?? new Date().toISOString();
  const environmentClause = knownEnvironment ? ` AND deployment.environment = "${knownEnvironment}"` : "";
  const serviceClause = affectedServices.length > 1 ? `service.name IN (${affectedServices.map((service) => `"${service}"`).join(", ")})` : `service.name = "${incident.service}"`;
  // Failing exemplars first: those are the traces a responder should open.
  const traceIds = [...new Set([...failing, ...events].map((event) => text(event.metadata?.traceId)).filter((value): value is string => Boolean(value)))];
  const environmentLimitation = knownEnvironment ? "" : " The environment is unknown, so results may mix environments; set it with Edit facts.";
  const githubOnly = events.length > 0 && events.every((event) => event.metadata?.provider === "github");
  const githubRanges = [...new Map(events.filter((event) => ["push", "deployment"].includes(String(event.metadata?.eventType))).map((event) => githubChangeRange(event, events)).filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.compareUrl, item])).values()];
  const githubFailures = events.filter((event) => event.metadata?.provider === "github" && event.kind === "alert" && text(event.metadata?.logUrl ?? event.metadata?.sourceUrl));
  const githubSuggestions = [
    ...githubRanges.slice(0, 2).map((range, index) => ({ id:`github-diff-${index}`, label:"Diff of the deployed change", source:"GitHub", query:range.compareUrl, limitation: range.before ? "Everything between the last good commit and the deployed one." : "No earlier push is retained, so only the deployed commit is linked." })),
    ...githubFailures.slice(0, 2).map((event, index) => ({ id:`github-run-${index}`, label:`Logs for “${event.title}”`, source:"GitHub", query:text(event.metadata?.logUrl ?? event.metadata?.sourceUrl)!, limitation: text(event.metadata?.logUrl) ? "Open the failing run and find the first error line." : "GitHub sent no log URL for this event; this is the deployment page." }))
  ];
  const querySuggestions = githubOnly ? githubSuggestions : [
    ...githubSuggestions,
    { id:"failing-vs-healthy", label:"Compare failing and healthy requests", source:"OpenTelemetry", query:`service.name = "${incident.service}"${environmentClause} AND time >= "${from}" AND time <= "${to}" GROUP BY status_code, route, region`, limitation: (healthy.length ? `Healthy controls are sampled (${healthy.length} retained).` : "No healthy control sample is retained; enable bounded healthy-span sampling.") + environmentLimitation },
    { id:"dependency-divergence", label:"Find first divergent dependency span", source:"Tracing backend", query:`trace service=${incident.service}${knownEnvironment ? ` environment=${knownEnvironment}` : ""} from=${from} to=${to} sort=duration desc`, limitation:"The generated query is read-only and must be adapted to the connected provider syntax." + environmentLimitation },
    { id:"error-logs", label:"Error logs across affected services", source:"Logs", query:`${serviceClause}${environmentClause} AND severity >= ERROR AND time >= "${from}" AND time <= "${to}"`, limitation:`Covers every service in this investigation (${affectedServices.length}). Compare the first error per service with the timeline order.` },
    ...(traceIds.length ? [{ id:"exemplar-traces", label:"Open failing exemplar traces", source:"Tracing backend", query:traceIds.slice(0, 5).map((id) => `trace_id = "${id}"`).join(" OR "), limitation:`${traceIds.length} trace ID${traceIds.length === 1 ? " is" : "s are"} retained in evidence; the first five are listed.` }] : []),
    { id:"recent-changes", label:"Changes shortly before the first symptom", source:"Deploy / audit log", query:`service IN (${affectedServices.map((service) => `"${service}"`).join(", ")}) AND type IN (deploy, config, feature_flag, migration) AND time >= "${new Date(Date.parse(from) - 60 * 60_000).toISOString()}" AND time <= "${from}"`, limitation: changes.length ? `${changes.length} change${changes.length === 1 ? " is" : "s are"} already retained; this query looks for ones not yet ingested.` : "No change is retained; this checks the hour before the first observation for unrecorded changes." }
  ];

  return {
    generatedAt:new Date().toISOString(),
    evidenceRevision:incident.evidenceRevision ?? incident.updatedAt,
    cohorts:{ healthy:{ sampleCount:healthy.length, medianDurationMs:median(healthy.map((event) => number(event.metadata?.durationMs)).filter((value): value is number => value !== undefined)) }, failing:{ sampleCount:failing.length, medianDurationMs:median(failing.map((event) => number(event.metadata?.durationMs)).filter((value): value is number => value !== undefined)) }, routes, releases, regions, window, comparisonDimensions: failingScope ? Object.fromEntries(comparisonDimensions.map((dimension) => [dimension, dimension === "service" ? failingScope.service : text(failingScope.metadata?.[dimension]) ?? "missing"])) : {}, excludedHealthySamples:excludedHealthy, limitations:[...(healthy.length ? [`Healthy cohort uses ${Math.round((healthyRates[0] ?? .05) * 100)}% deterministic sampling.`] : ["No matched healthy cohort is available for the same service, route, method, and region."]), ...(excludedHealthy ? [`${excludedHealthy} healthy sample${excludedHealthy === 1 ? " was" : "s were"} excluded because comparison dimensions differed or were missing.`] : []), ...(failing.length ? [] : ["No failing or slow OTLP request spans are retained."]), "Counts reflect retained evidence, not total traffic."] },
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
