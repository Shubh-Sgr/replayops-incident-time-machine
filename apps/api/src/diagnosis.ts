import type { DiagnosticHypothesis, HypothesisTest, Incident, IncidentDiagnosis, IncidentEvent, SignalDelta } from "./types.js";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, Math.round(value)));

const secondsBetween = (earlier: string, later: string) => Math.max(0, Math.round((Date.parse(later) - Date.parse(earlier)) / 1000));

const hasCorrelationContext = (event: IncidentEvent) => {
  return Object.entries(event.metadata ?? {}).some(([key, value]) => ["traceid", "spanid", "requestid"].includes(key.toLowerCase().replaceAll("_", "")) && typeof value === "string" && value.trim() !== "");
};

const hasTraceRelationship = (events: IncidentEvent[]) => {
  const spanIds = new Set(events.map((event) => String(event.metadata?.spanId ?? "")).filter(Boolean));
  return events.some((event) => Boolean(event.metadata?.traceId && event.metadata?.parentSpanId && spanIds.has(String(event.metadata.parentSpanId))));
};

function signalDeltas(events: IncidentEvent[], symptom: IncidentEvent): SignalDelta[] {
  const before = events.filter((event) => event.timestamp < symptom.timestamp);
  const failure = events.filter((event) => event.timestamp >= symptom.timestamp);
  const rows: SignalDelta[] = [];

  for (const dimension of ["service", "event kind"] as const) {
    const valueOf = (event: IncidentEvent) => dimension === "service" ? event.service : event.kind;
    const values = [...new Set(events.map(valueOf))].filter((value) => dimension === "service" || (value !== "action" && value !== "recovery"));
    for (const value of values) {
      const beforeImpact = Math.max(0, ...before.filter((event) => valueOf(event) === value).map((event) => event.impactScore));
      const matchingFailure = failure.filter((event) => valueOf(event) === value);
      const failureImpact = Math.max(0, ...matchingFailure.map((event) => event.impactScore));
      const change = failureImpact - beforeImpact;
      const score = clamp(change + matchingFailure.length * 5, 0, 100);
      if (failureImpact > 0) rows.push({ dimension, value, beforeImpact, failureImpact, change, score });
    }
  }

  return rows.sort((left, right) => right.score - left.score).slice(0, 6);
}

/** Last good → suspect commit range for a GitHub deploy, using the push that introduced the deployed SHA. */
export function githubChangeRange(event: IncidentEvent, events: IncidentEvent[]) {
  const meta = event.metadata ?? {};
  if (meta.provider !== "github") return null;
  const repository = typeof meta.repository === "string" ? meta.repository : undefined;
  const sha = typeof meta.sha === "string" ? meta.sha : undefined;
  if (!repository || !sha) return null;
  const push = events.find((candidate) => candidate.metadata?.eventType === "push" && candidate.metadata?.sha === sha);
  const before = typeof push?.metadata?.beforeSha === "string" && !/^0+$/.test(push.metadata.beforeSha) ? push.metadata.beforeSha : undefined;
  return { repository, sha, before, compareUrl: before ? `https://github.com/${repository}/compare/${before}...${sha}` : `https://github.com/${repository}/commit/${sha}` };
}

function testFor(event: IncidentEvent, symptom: IncidentEvent, events: IncidentEvent[] = []) {
  const range = githubChangeRange(event, events);
  if (range) {
    const environment = String(event.metadata?.deploymentEnvironment ?? event.metadata?.environment ?? "production");
    return {
      nextTest: `Review the change ${range.before ? `${range.before.slice(0, 7)}…${range.sha.slice(0, 7)}` : range.sha.slice(0, 7)} (${range.compareUrl}) and the failing ${symptom.metadata?.eventType === "workflow_run" ? "workflow" : "deployment"} logs for the first error; confirm the failure does not occur on the previous commit.`,
      safeAction: range.before ? `Redeploy the last good commit ${range.before.slice(0, 7)} to ${environment} and confirm the deployment succeeds.` : `Revert ${range.sha.slice(0, 7)} and redeploy to ${environment}; confirm the deployment succeeds.`
    };
  }
  if (event.kind === "deploy") {
    return {
      nextTest: `Split ${symptom.service} failures by release version and compare the error distribution immediately before and after “${event.title}”.`,
      safeAction: "Route a small canary cohort to the previous revision; stop if its error rate does not improve."
    };
  }
  if (event.kind === "dependency") {
    return {
      nextTest: `Compare slow and healthy ${symptom.service} requests by dependency latency, using matching trace or request IDs where available.`,
      safeAction: `Temporarily shed or bypass the affected ${event.service} dependency path for a bounded cohort.`
    };
  }
  return {
    nextTest: `Break down “${event.title}” by instance, zone, and release, then compare the failing cohort with a healthy cohort in the same window.`,
    safeAction: `Reduce pressure on ${event.service} with a bounded traffic or concurrency limit while preserving samples.`
  };
}

function hypothesisOutcome(hypothesisId: string, tests: HypothesisTest[]) {
  const relevant = tests
    .filter((test) => test.hypothesisId === hypothesisId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const supported = relevant.some((test) => test.status === "supported");
  const disproved = relevant.some((test) => test.status === "disproved");
  const inconclusive = relevant.some((test) => test.status === "inconclusive");
  const state: DiagnosticHypothesis["state"] = supported && disproved
    ? "contested"
    : disproved
      ? "disproved"
      : supported
        ? "supported"
        : inconclusive
          ? "inconclusive"
          : "untested";
  const latest = relevant.at(-1);
  const outcomeSummary = state === "contested"
    ? "Tests disagree. Treat this explanation as contested until the conflicting cohorts or conditions are reconciled."
    : state === "disproved"
      ? `Observed evidence did not distinguish or support this explanation${latest?.result ? `: ${latest.result}` : "."}`
      : state === "supported"
        ? `A bounded test supports this explanation${latest?.result ? `: ${latest.result}` : "."} Support is limited to the tested conditions.`
        : state === "inconclusive"
          ? `The latest test was inconclusive${latest?.result ? `: ${latest.result}` : "."}`
          : "No completed test has changed this explanation yet.";
  return { state, outcomeSummary, testCount: relevant.length };
}

export function diagnoseIncident(incident: Incident, tests: HypothesisTest[] = []): IncidentDiagnosis {
  const events = [...incident.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  if (!events.length) {
    return {
      incidentId: incident.id,
      generatedAt: new Date().toISOString(),
      servicePath: [],
      confidence: 12,
      evidenceCompleteness: 0,
      causalConfidence: 12,
      scoreExplanation: ["No timestamped evidence is available."],
      changeCandidates: [],
      signalDeltas: [],
      hypotheses: [],
      evidenceGaps: ["No timestamped evidence is attached, so causal ordering cannot be evaluated."],
      evidenceStatus: "insufficient",
      currentExplanation: "No explanation is defensible until timestamped evidence is attached.",
      nextAction: { label: "Add the first evidence", reason: "A timestamped observation is required before ReplayOps can rank explanations.", href: "?area=evidence&action=add" }
    };
  }

  const symptom = events.find((event) => event.kind === "alert" && event.impactScore >= 65)
    ?? events.find((event) => event.impactScore >= 65)
    ?? events.reduce((highest, event) => event.impactScore > highest.impactScore ? event : highest, events[0]!);
  const eligibleCandidates = events.filter((event) => event.timestamp <= symptom.timestamp && event.kind !== "alert" && event.kind !== "action" && event.kind !== "recovery");
  const sourceCandidates = eligibleCandidates.length ? eligibleCandidates : [events[0]!];
  const changeCandidates = sourceCandidates.map((event) => {
    const leadTimeSeconds = secondsBetween(event.timestamp, symptom.timestamp);
    const kindWeight = event.kind === "dependency" ? 30 : event.kind === "deploy" ? 27 : 15;
    const proximity = Math.max(0, 28 - leadTimeSeconds / 30);
    const progression = Math.max(0, symptom.impactScore - event.impactScore) * 0.22;
    const score = clamp(34 + kindWeight + proximity + progression, 28, 96);
    return {
      eventId: event.id,
      title: event.title,
      service: event.service,
      kind: event.kind,
      leadTimeSeconds,
      score,
      reason: leadTimeSeconds === 0
        ? `This ${event.kind} is the first high-impact symptom in the recorded sequence.`
        : `This ${event.kind} preceded the first high-impact symptom by ${Math.max(1, Math.round(leadTimeSeconds / 60))} minute${leadTimeSeconds >= 90 ? "s" : ""}.`
    };
  }).sort((left, right) => right.score - left.score).slice(0, 4);

  const topCandidate = sourceCandidates.find((event) => event.id === changeCandidates[0]?.eventId) ?? sourceCandidates[0]!;
  const correlated = events.some(hasCorrelationContext);
  const linkedTracePath = hasTraceRelationship(events);
  const servicePath = [...new Set(events.map((event) => event.service))];
  const hasRecovery = events.some((event) => event.kind === "recovery");
  const hasChange = events.some((event) => event.kind === "deploy" || event.kind === "dependency");
  const hasHealthyCohort = events.some((event) => /healthy|control|baseline|successful/i.test(`${event.title} ${event.detail}`));
  const evidenceCompleteness = clamp(Math.min(30, events.length * 5) + Math.min(15, servicePath.length * 5) + (hasRecovery ? 15 : 0) + (hasChange ? 15 : 0) + (correlated ? 15 : 0) + (hasHealthyCohort ? 10 : 0), 0, 100);
  const causalConfidence = clamp(24 + (hasChange ? 14 : 0) + (correlated ? 22 : 0) + (hasHealthyCohort ? 18 : 0) + (hasRecovery ? 10 : 0) + Math.min(12, events.length * 2), 12, 94);
  const confidence = causalConfidence;
  const scoreExplanation = [
    `${events.length} ordered evidence event${events.length === 1 ? "" : "s"} across ${servicePath.length} service${servicePath.length === 1 ? "" : "s"}.`,
    correlated ? "Trace or request correlation is present." : "No trace-backed request relationship is present.",
    hasHealthyCohort ? "A healthy or control cohort is recorded." : "No healthy-versus-failing cohort comparison is recorded.",
    hasRecovery ? "A recovery observation closes the evidence window." : "No recovery observation closes the evidence window."
  ];
  const primaryTest = testFor(topCandidate, symptom, events);
  const evidenceSpan = secondsBetween(topCandidate.timestamp, symptom.timestamp);
  const peak = events.reduce((highest, event) => event.impactScore > highest.impactScore ? event : highest, events[0]!);
  const amplificationEvent = events.find((event) => /retr|queue|concurr|storm|fan.?out|saturat/i.test(`${event.title} ${event.detail}`));

  const hypotheses: DiagnosticHypothesis[] = [{
    id: `origin-${topCandidate.id}`,
    rank: 1,
    title: `Inspect the strongest recorded precursor in ${topCandidate.service}`,
    claim: `“${topCandidate.title}” occurred before the first high-impact symptom in ${symptom.service}; the current evidence does not by itself establish cause.`,
    confidence: Math.min(confidence, clamp(changeCandidates[0]?.score ?? confidence, 20, 94)),
    supportingEvidence: [
      `${topCandidate.title} was recorded ${evidenceSpan ? `${Math.max(1, Math.round(evidenceSpan / 60))}m before` : "at"} the first high-impact symptom.`,
      `A high-severity observation was later recorded in ${peak.service}.`
    ],
    conflictingEvidence: correlated
      ? ["Correlation IDs exist, but the relevant request path still needs to be inspected before assigning cause."]
      : ["No trace or request ID links this precursor to the affected requests; temporal order alone is not proof."],
    ...primaryTest,
    ...hypothesisOutcome(`origin-${topCandidate.id}`, tests)
  }];

  if (amplificationEvent && servicePath.length > 1 && linkedTracePath) {
    hypotheses.push({
      id: `amplification-${amplificationEvent.id}`,
      rank: 2,
      title: "A feedback loop amplified a smaller upstream fault",
      claim: `The recorded ${amplificationEvent.kind} “${amplificationEvent.title}” may explain why impact spread across ${servicePath.length} services.`,
      confidence: clamp(confidence - 9, 22, 86),
      supportingEvidence: [`Retained parent/child spans link ${servicePath.join(" → ")}.`, amplificationEvent.detail],
      conflictingEvidence: ["The current evidence does not include a healthy control cohort with the same upstream condition."],
      nextTest: "Compare request volume and retry count for affected versus successful requests, then verify whether amplification begins after the upstream latency shift.",
      safeAction: "Apply a bounded retry or concurrency ceiling and watch whether downstream pressure falls without increasing failed requests.",
      ...hypothesisOutcome(`amplification-${amplificationEvent.id}`, tests)
    });
  }

  if (servicePath.length > 1 && linkedTracePath) {
    hypotheses.push({
      id: `downstream-${symptom.id}`,
      rank: hypotheses.length + 1,
      title: `${symptom.service} may be the first visible victim, not the origin`,
      claim: `The first high-impact alert occurred in ${symptom.service}, but earlier evidence exists in ${topCandidate.service}.`,
      confidence: clamp(confidence - 18, 18, 72),
      supportingEvidence: [`Retained parent/child spans cross ${servicePath.length} services.`, `The peak appeared in ${peak.service}, not necessarily where the failing request began.`],
      conflictingEvidence: ["Service-level timestamps can be skewed, and missing telemetry may reorder the apparent path."],
      nextTest: `Inspect one slow exemplar trace from ${symptom.service} and one healthy trace, then compare their first divergent span.`,
      safeAction: "Preserve exemplars and logs before changing the downstream service; avoid treating the loudest alert as root cause.",
      ...hypothesisOutcome(`downstream-${symptom.id}`, tests)
    });
  }

  const evidenceGaps: string[] = [];
  if (!correlated && servicePath.length > 1) evidenceGaps.push("No trace, span, or request ID is attached; cross-service causality cannot be verified.");
  if (!events.some((event) => event.kind === "deploy")) evidenceGaps.push("No deployment or configuration change is recorded in the incident window.");
  if (!hasRecovery) evidenceGaps.push("No recovery event is recorded, so mitigation effectiveness cannot be measured against the same signals.");
  if (events.filter((event) => event.timestamp < symptom.timestamp).length < 2) evidenceGaps.push("The pre-symptom baseline is thin; add healthy-window measurements for comparison.");
  if (events.length < 5) evidenceGaps.push("Fewer than five evidence points are available; hypothesis confidence is intentionally capped.");

  // Once a test has run, repeating the same test adds nothing. Point the responder at the next distinct step.
  for (const hypothesis of hypotheses) {
    if (hypothesis.state === "supported") hypothesis.nextTest = `Confirm by intervention: ${hypothesis.safeAction} Verify that the ${symptom.service} symptom falls and returns if the change is reverted.`;
    else if (hypothesis.state === "inconclusive") hypothesis.nextTest = `The previous test did not discriminate. Break down “${symptom.title}” by instance, zone, and release, and compare the failing cohort with a healthy cohort in the same window.`;
    else if (hypothesis.state === "contested") hypothesis.nextTest = "Re-run the conflicting tests on the same cohort, window, and release so their results can be compared directly.";
  }

  const stateOrder: Record<DiagnosticHypothesis["state"], number> = { supported: 0, untested: 1, inconclusive: 2, contested: 3, disproved: 4 };
  const orderedHypotheses = hypotheses
    .sort((left, right) => stateOrder[left.state] - stateOrder[right.state] || left.rank - right.rank)
    .map((hypothesis, index) => ({ ...hypothesis, rank: index + 1 }));
  const leading = orderedHypotheses.find((hypothesis) => hypothesis.state !== "disproved");
  const contested = orderedHypotheses.find((hypothesis) => hypothesis.state === "contested");
  const activeTest = tests.find((test) => ["planned", "running"].includes(test.status));
  const evidenceStatus: IncidentDiagnosis["evidenceStatus"] = evidenceCompleteness < 35 ? "insufficient" : evidenceCompleteness < 75 ? "partial" : "substantial";
  const nextAction = incident.status === "monitoring"
    ? { label: "Verify recovery, then resolve", reason: "The incident is in Monitoring. Confirm the recovery check passes in Fix & verify, then resolve it.", href: "?area=validate" }
    : incident.status === "resolved"
      ? { label: "Write the learning record", reason: "The incident is resolved. Capture what was learned and any follow-ups in Activity & handoff.", href: "?area=handoff" }
    : activeTest
    ? { label: activeTest.status === "running" ? "Record the test outcome" : "Start the assigned test", reason: activeTest.title, href: `?area=investigate&test=${activeTest.id}` }
    : contested
      ? { label: "Resolve contradictory test results", reason: contested.outcomeSummary, href: `?area=investigate&hypothesis=${encodeURIComponent(contested.id)}` }
    : leading?.state === "supported"
      ? { label: "Validate a bounded fix", reason: leading.nextTest, href: "?area=validate" }
    : leading
      ? { label: leading.testCount ? "Run a different test" : "Run the next test", reason: leading.nextTest, href: `?area=investigate&hypothesis=${encodeURIComponent(leading.id)}` }
      : { label: "Add missing evidence", reason: evidenceGaps[0] ?? "Every current explanation has been disproved.", href: "?area=evidence&gap=missing" };

  return {
    incidentId: incident.id,
    generatedAt: new Date().toISOString(),
    symptomEventId: symptom.id,
    originService: topCandidate.service,
    servicePath,
    confidence,
    evidenceCompleteness,
    causalConfidence,
    scoreExplanation,
    changeCandidates,
    signalDeltas: signalDeltas(events, symptom),
    hypotheses: orderedHypotheses,
    evidenceGaps,
    evidenceStatus,
    currentExplanation: leading
      ? `${leading.claim} ${leading.state === "supported" ? "A bounded test supports it under the recorded conditions." : leading.state === "contested" ? "The recorded tests conflict." : "It remains an explanation to test, not a proven root cause."}`
      : "Every recorded explanation has been disproved. Gather new evidence before selecting another cause.",
    nextAction
  };
}
