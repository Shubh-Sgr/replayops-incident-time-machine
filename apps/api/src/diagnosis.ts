import { evaluateAutomaticRecovery } from "./deliveryRecovery.js";
import { frameIsFile, stackFiles } from "./exceptions.js";
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
  const pushedBefore = typeof push?.metadata?.beforeSha === "string" && !/^0+$/.test(push.metadata.beforeSha) ? push.metadata.beforeSha : undefined;
  // A deploy from the change log knows the previously deployed SHA, which may be many pushes back.
  const before = typeof meta.previousSha === "string" ? meta.previousSha : pushedBefore;
  return { repository, sha, before, compareUrl: before ? `https://github.com/${repository}/compare/${before}...${sha}` : `https://github.com/${repository}/commit/${sha}` };
}

function testFor(event: IncidentEvent, symptom: IncidentEvent, events: IncidentEvent[] = []) {
  const range = githubChangeRange(event, events);
  if (range) {
    const workflowFailure = symptom.metadata?.eventType === "workflow_run";
    const sha = range.sha.slice(0, 7);
    const branch = typeof event.metadata?.branch === "string" ? event.metadata.branch : undefined;
    const environment = String(symptom.metadata?.deploymentEnvironment ?? event.metadata?.deploymentEnvironment ?? "production");
    return {
      nextTest: `Review the change ${range.before ? `${range.before.slice(0, 7)}…${sha}` : sha} (${range.compareUrl}) and the failing ${workflowFailure ? "workflow" : "deployment"} logs for the first error; confirm the failure does not occur on the previous commit.`,
      safeAction: workflowFailure
        ? `Push a fix or revert ${sha}${branch ? ` on ${branch}` : ""}; the next successful “${String(symptom.metadata?.workflow ?? symptom.metadata?.workflowName ?? "workflow")}” run confirms recovery automatically.`
        : range.before ? `Redeploy the last good commit ${range.before.slice(0, 7)} to ${environment} (or push a fix); the next successful deployment confirms recovery automatically.` : `Revert ${sha} and redeploy to ${environment}; the next successful deployment confirms recovery automatically.`
    };
  }
  const change = event.metadata ?? {};
  const changeType = typeof change.changeType === "string" ? change.changeType : undefined;
  const key = typeof change.flagKey === "string" ? change.flagKey : undefined;
  const previous = change.previousValue !== undefined && change.previousValue !== null ? String(change.previousValue) : undefined;
  if (event.kind === "deploy" && changeType === "feature_flag") {
    return {
      nextTest: `Compare ${symptom.service} errors for requests with ${key ? `flag “${key}”` : "the flag"} on versus off since “${event.title}”.`,
      safeAction: `Set ${key ? `“${key}”` : "the flag"} back to ${previous ?? "its previous value"}; no deploy is needed, so watch the error rate for a few minutes.`
    };
  }
  if (event.kind === "deploy" && changeType === "config") {
    return {
      nextTest: `Check whether ${symptom.service} failures started right after ${key ? `“${key}”` : "the config"} changed${previous ? ` from ${previous}` : ""}, and whether only instances that reloaded config are failing.`,
      safeAction: `Restore ${key ? `“${key}”` : "the setting"} to ${previous ?? "its previous value"} on one instance first, then everywhere if errors drop.`
    };
  }
  if (event.kind === "deploy" && changeType === "migration") {
    return {
      nextTest: `Look for lock waits, slow queries, or missing columns in ${symptom.service} errors since “${event.title}”.`,
      safeAction: "Pause any still-running migration and roll forward with a compatible fix; avoid an automatic schema rollback without a backup."
    };
  }
  if (event.kind === "deploy" && typeof change.version === "string" && change.provider === "generic") {
    const before = typeof change.previousVersion === "string" ? change.previousVersion : undefined;
    return {
      nextTest: `Split ${symptom.service} errors by version: is ${change.version} failing while ${before ?? "the previous version"} is healthy?`,
      safeAction: `Roll ${symptom.service} back to ${before ?? "the previous version"} (or shift a small canary to it) and watch the error rate.`
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

/** Workspace facts the incident alone does not contain: where and when each error has been seen before. */
export interface DiagnosisContext { exceptionHistory?: Map<string, Array<{ environment: string; firstSeen: string; releases: string[] }>> }

const humanLead = (seconds: number) => seconds < 5_400 ? `${Math.max(1, Math.round(seconds / 60))} minute${seconds >= 90 ? "s" : ""}` : seconds < 172_800 ? `${Math.round(seconds / 3_600)} hours` : `${Math.round(seconds / 86_400)} days`;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
/** The release a failing event came from: generic `release`/`version`, OpenTelemetry `service.version`. */
const releaseOf = (event: IncidentEvent) => event.kind === "deploy" ? undefined : text(event.metadata?.release) ?? text(event.metadata?.version) ?? text((event.metadata?.attributes as Record<string, unknown> | undefined)?.["service.version"]);

export function diagnoseIncident(incident: Incident, tests: HypothesisTest[] = [], context: DiagnosisContext = {}): IncidentDiagnosis {
  // Evidence a responder excluded (for example a change ruled out as unrelated) no longer counts.
  const events = incident.events.filter((event) => event.evidenceState !== "excluded").sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  // What responders did, and signs of recovery, are never a cause; with nothing else recorded there is nothing to rank.
  const causeEvidence = events.filter((event) => event.kind !== "action" && event.kind !== "recovery");
  if (!causeEvidence.length) {
    return {
      incidentId: incident.id,
      generatedAt: new Date().toISOString(),
      servicePath: [],
      confidence: 12,
      evidenceCompleteness: 0,
      causalConfidence: 12,
      scoreExplanation: [events.length ? "Only responder actions or recovery signals are recorded." : "No timestamped evidence is available."],
      changeCandidates: [],
      signalDeltas: [],
      hypotheses: [],
      evidenceGaps: [events.length ? "No error, alert, or change is attached, so there is nothing to explain yet." : "No timestamped evidence is attached, so there is nothing to explain yet."],
      evidenceStatus: "insufficient",
      currentExplanation: "Not enough to go on yet. Add what you're seeing to the timeline.",
      nextAction: { label: "Add what you're seeing", reason: "Add an error, alert, or anything you noticed to the timeline. Connected sources add this by themselves.", href: "?area=evidence&action=add" }
    };
  }

  const symptom = events.find((event) => event.kind === "alert" && event.impactScore >= 65)
    ?? events.find((event) => event.impactScore >= 65)
    ?? events.reduce((highest, event) => event.impactScore > highest.impactScore ? event : highest, events[0]!);
  // Error occurrences are symptoms, never candidate causes.
  const eligibleCandidates = events.filter((event) => event.timestamp <= symptom.timestamp && event.kind !== "alert" && event.kind !== "action" && event.kind !== "recovery" && !event.metadata?.exception);
  const sourceCandidates = eligibleCandidates.length ? eligibleCandidates : [causeEvidence[0]!];
  // An exception type that first appears right after a change (and before any later change) points at it.
  // "First appears" means first in this environment's history, so a chronic error never blames a release.
  const environment = incident.environment && incident.environment !== "unknown" ? incident.environment : undefined;
  const firstExceptions = new Map<string, { timestamp: string; type: string; fingerprint: string }>();
  for (const event of events) {
    const exception = event.metadata?.exception as { fingerprint?: string; type?: string } | undefined;
    if (exception?.fingerprint && !firstExceptions.has(exception.fingerprint)) {
      const known = context.exceptionHistory?.get(exception.fingerprint)?.find((item) => item.environment === (environment ?? "unknown"))?.firstSeen;
      firstExceptions.set(exception.fingerprint, { timestamp: known && known < event.timestamp ? known : event.timestamp, type: exception.type ?? "Error", fingerprint: exception.fingerprint });
    }
  }
  /** The same error in another (pre-production) environment on this release, before the release reached here. */
  const earlyWarningFor = (version: string | undefined, changedAt: string) => version ? [...firstExceptions.values()].flatMap((item) => (context.exceptionHistory?.get(item.fingerprint) ?? [])
    .filter((sighting) => sighting.environment !== (environment ?? "unknown") && sighting.environment !== "unknown" && sighting.firstSeen < changedAt && sighting.releases.includes(version))
    .map((sighting) => ({ type: item.type, environment: sighting.environment }))) : [];
  // Where the failures happen in the code: the application frame each error was thrown in. Callers deeper in the
  // stack are on most request paths, so a change to them says little.
  const failingFrames = events.flatMap((event) => stackFiles((event.metadata?.exception as { stack?: string } | undefined)?.stack).filter((frame) => frame.top));
  /** A release named by version, or by the git SHA apps often report as their release. */
  const sameRelease = (release: string, version: string | undefined, sha: string | undefined) => release === version || Boolean(sha && release.length >= 7 && (sha.startsWith(release) || release.startsWith(sha)));
  const failingReleases = [...new Set(events.filter((event) => event.timestamp >= symptom.timestamp && (event.kind === "alert" || event.metadata?.exception)).map(releaseOf).filter((value): value is string => Boolean(value)))];
  const isCodeChange = (change: IncidentEvent) => !text(change.metadata?.changeType) || ["deploy", "rollback"].includes(String(change.metadata?.changeType));
  const firstAnywhere = (item: { timestamp: string; fingerprint: string }) => [item.timestamp, ...(context.exceptionHistory?.get(item.fingerprint) ?? []).map((sighting) => sighting.firstSeen)].sort()[0]!;
  const laterChanges = (change: IncidentEvent, code: boolean) => events.filter((event) => event.kind === "deploy" && event.timestamp > change.timestamp && (!code || isCodeChange(event))).map((event) => event.timestamp);
  /**
   * Which errors a change could have introduced. Code (a deploy) is judged against this environment's history, since
   * staging sightings of the same release are expected before promotion; a runtime change (flag, config, infra) is
   * judged against every environment, because an error seen anywhere before it started without it.
   */
  const errorEvidence = (change: IncidentEvent) => {
    if (change.kind !== "deploy") return { introduced: [], preexisting: [], cleanUntil: undefined };
    const code = isCodeChange(change);
    const errors = [...firstExceptions.values()];
    const since = (item: (typeof errors)[number]) => code ? item.timestamp : firstAnywhere(item);
    // A release that ran cleanly for a while, then a runtime change (config, flag, infra), and the errors right
    // after it: they began with that change. Not when the stack runs through the release's own code, or the
    // same error already showed up on this release in staging.
    const cleanUntil = code && !suspectFor(change) && !earlyWarningFor(text(change.metadata?.version), change.timestamp).length
      ? events.find((event) => {
        if (event.kind !== "deploy" || isCodeChange(event) || event.timestamp <= change.timestamp) return false;
        // …while this release was still the one running…
        if (laterChanges(change, true).some((time) => time <= event.timestamp)) return false;
        const onset = errors.map(since).filter((time) => time >= event.timestamp).sort()[0];
        if (!onset) return false;
        // …and it ran cleanly far longer than the errors took to follow the runtime change.
        const clean = secondsBetween(change.timestamp, event.timestamp);
        return clean >= 300 && clean >= 3 * secondsBetween(event.timestamp, onset);
      })
      : undefined;
    const later = [...laterChanges(change, code), ...(cleanUntil ? [cleanUntil.timestamp] : [])];
    return {
      introduced: errors.filter((item) => since(item) >= change.timestamp && !later.some((time) => time <= item.timestamp && since(item) >= time)),
      preexisting: errors.filter((item) => since(item) < change.timestamp),
      cleanUntil
    };
  };
  /** Suspect files: the failing stack runs through code this change modified. */
  const suspectFor = (event: IncidentEvent) => {
    const meta = event.metadata ?? {};
    const changedFiles = event.kind === "deploy" && isCodeChange(event) && Array.isArray(meta.files) ? (meta.files as unknown[]).filter((file): file is string => typeof file === "string") : [];
    const frame = changedFiles.length ? failingFrames.find((item) => changedFiles.some((file) => frameIsFile(item.file, file))) : undefined;
    if (!frame) return undefined;
    const file = changedFiles.find((item) => frameIsFile(frame.file, item))!;
    const commit = (Array.isArray(meta.commits) ? meta.commits as Array<{ sha?: string; message?: string; files?: string[] }> : []).find((item) => item.files?.includes(file));
    return { frame, file, commit };
  };
  const suspectChange = sourceCandidates.map((event) => ({ event, suspect: suspectFor(event) })).find((item) => item.suspect);
  const changeCandidates = sourceCandidates.map((event) => {
    const meta = event.metadata ?? {};
    const leadTimeSeconds = secondsBetween(event.timestamp, symptom.timestamp);
    const kindWeight = event.kind === "dependency" ? 30 : event.kind === "deploy" ? 27 : 15;
    // Changes stay suspicious for hours, not minutes (a flag flipped 30 minutes ago still matters), and the
    // release that was running keeps a floor however old it is. Observations keep the short, minute-scale window.
    const proximity = event.kind === "deploy" ? 28 * Math.exp(-leadTimeSeconds / 7_200) + (meta.liveRelease === true ? 6 : 0) : Math.max(0, 28 - leadTimeSeconds / 30);
    const progression = Math.max(0, symptom.impactScore - event.impactScore) * 0.22;
    const { introduced: newErrors, preexisting, cleanUntil } = errorEvidence(event);
    const notes: string[] = [];
    let adjustment = Math.min(12, newErrors.length * 6);
    if (newErrors.length) notes.push(`${newErrors.length} error type${newErrors.length === 1 ? "" : "s"} (${[...new Set(newErrors.map((item) => item.type))].slice(0, 3).join(", ")}) first appeared after it.`);
    else if (preexisting.length) {
      adjustment -= isCodeChange(event) ? 6 : 14;
      const elsewhere = !isCodeChange(event) && preexisting.some((item) => firstAnywhere(item) < item.timestamp);
      notes.push(elsewhere ? `${preexisting[0]!.type} was already seen ${((place) => place ? `in ${place}` : "elsewhere")((context.exceptionHistory?.get(preexisting[0]!.fingerprint) ?? []).find((sighting) => sighting.firstSeen < event.timestamp)?.environment)} before this change, so it didn't start with it.` : "Its errors were already happening before it.");
    }
    if (cleanUntil) { adjustment -= 12; notes.push(`It ran for ${humanLead(secondsBetween(event.timestamp, cleanUntil.timestamp))} without these errors, until “${cleanUntil.title}”.`); }
    const version = text(meta.version);
    const sha = text(meta.sha);
    const releaseLabel = version ?? sha?.slice(0, 7);
    const suspect = suspectFor(event);
    if (suspect) {
      const { frame, file, commit } = suspect;
      adjustment += 18;
      notes.push(`The failing stack frame ${file}${frame.line ? `:${frame.line}` : ""} is in a file it changed${commit?.sha ? ` (${commit.sha.slice(0, 7)} “${commit.message ?? ""}”)` : ""}.`);
    } else if (suspectChange && event.kind === "deploy") {
      // A flag can expose a bug, but the failing code was written elsewhere: that is where the fix goes.
      adjustment -= 12;
      notes.push(`The failing code (${suspectChange.suspect!.file.split("/").pop()}) was changed by “${suspectChange.event.title}”, not by this change.`);
    }
    const earlyWarnings = event.kind === "deploy" ? earlyWarningFor(version, event.timestamp) : [];
    if (earlyWarnings.length) { adjustment += 15; notes.push(`The same ${earlyWarnings[0]!.type} appeared in ${earlyWarnings[0]!.environment} on ${version} before it reached ${environment ?? "this environment"}.`); }
    // A release that already ran cleanly gains nothing from the failures carrying its version: it was the only one running.
    if (event.kind === "deploy" && isCodeChange(event) && releaseLabel && failingReleases.length && !cleanUntil) {
      // Matching versions is weak evidence when only one version is running; mixed versions are strong evidence against.
      if (failingReleases.every((release) => sameRelease(release, version, sha))) { adjustment += 5; notes.push(`Every failing event reports version ${releaseLabel}.`); }
      else { adjustment -= 12; notes.push(`Failures also come from ${failingReleases.filter((release) => !sameRelease(release, version, sha)).slice(0, 2).join(", ")}, not only ${releaseLabel}.`); }
    }
    if (meta.touchesService === false) { adjustment -= 22; notes.push(`None of its changed files are in ${incident.service}'s code: likely unrelated.`); }
    else if (meta.touchesService === true) { adjustment += 6; notes.push(`It changed ${incident.service}'s code.`); }
    if (meta.liveRelease === true) notes.unshift("It was the release running when the incident started.");
    const score = clamp(24 + kindWeight + proximity + progression + adjustment, 10, 96);
    const newErrorNote = notes.length ? ` ${notes.join(" ")}` : "";
    return {
      eventId: event.id,
      title: event.title,
      service: event.service,
      kind: event.kind,
      leadTimeSeconds,
      score,
      reason: leadTimeSeconds === 0
        ? `This ${event.kind} is the first high-impact symptom in the recorded sequence.`
        : `This ${event.kind === "deploy" ? "change" : event.kind} preceded the first high-impact symptom by ${humanLead(leadTimeSeconds)}.${newErrorNote}`
    };
  }).sort((left, right) => right.score - left.score).slice(0, 4);

  const topCandidate = sourceCandidates.find((event) => event.id === changeCandidates[0]?.eventId) ?? sourceCandidates[0]!;
  const correlated = events.some(hasCorrelationContext);
  const linkedTracePath = hasTraceRelationship(events);
  const servicePath = [...new Set(events.map((event) => event.service))];
  const hasRecovery = events.some((event) => event.kind === "recovery");
  const hasChange = events.some((event) => event.kind === "deploy" || event.kind === "dependency");
  // A real comparison cohort: sampled healthy traces, an explicitly labelled control/baseline series, or a
  // responder's own note describing one. Words like "successful" in an automated title are not a cohort.
  const hasHealthyCohort = events.some((event) => {
    const meta = event.metadata ?? {};
    if (meta.cohortRole === "healthy" || ["healthy", "control", "baseline"].includes(String(meta.cohort ?? ""))) return true;
    return event.provenance === "manual" && /\b(healthy|control|baseline)\b.*\b(cohort|group|requests|traffic|instances?)\b/i.test(`${event.title} ${event.detail}`);
  });
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
    title: topCandidate.id === symptom.id ? `What led to “${symptom.title}”?` : `Did “${topCandidate.title}” cause this?`,
    claim: `“${topCandidate.title}” happened just before ${symptom.service} started failing, so it may be the cause.`,
    confidence: Math.min(confidence, clamp(changeCandidates[0]?.score ?? confidence, 20, 94)),
    supportingEvidence: [
      `${topCandidate.title} was recorded ${evidenceSpan ? `${humanLead(evidenceSpan)} before` : "at"} the first high-impact symptom.`,
      ...(changeCandidates[0]?.eventId === topCandidate.id && changeCandidates[0].reason.includes(". ") ? [changeCandidates[0].reason.slice(changeCandidates[0].reason.indexOf(". ") + 2)] : []),
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
  if (!events.some((event) => event.kind === "deploy" || event.metadata?.eventType === "push")) evidenceGaps.push(incident.environment && incident.environment !== "unknown"
    ? `No deploy, flag, or config change to ${incident.service} in ${incident.environment} is recorded. If none happened, look at dependencies, traffic, or data instead; otherwise send deploys to ReplayOps (Sources → Generic, or GitHub deployments).`
    : "No deployment or configuration change is recorded in the incident window.");
  const githubOnly = events.every((event) => event.metadata?.provider === "github");
  if (!hasRecovery && !githubOnly) evidenceGaps.push("No recovery has been observed yet, so there is nothing to compare a fix against.");
  if (events.filter((event) => event.timestamp < symptom.timestamp).length < 2) evidenceGaps.push("The pre-symptom baseline is thin; add healthy-window measurements for comparison.");
  if (events.length < 5) evidenceGaps.push(`Only ${events.length} piece${events.length === 1 ? "" : "s"} of evidence so far, so the explanation is tentative. Connect more sources or add an observation.`);

  // Once a test has run, repeating the same test adds nothing. Point the responder at the next distinct step.
  for (const hypothesis of hypotheses) {
    if (hypothesis.state === "supported") hypothesis.nextTest = events.some((event) => githubChangeRange(event, events)) && hypothesis.id === `origin-${topCandidate.id}` && githubChangeRange(topCandidate, events)
      ? `Fix it: ${hypothesis.safeAction}`
      : `Confirm by intervention: ${hypothesis.safeAction} Verify that the ${symptom.service} symptom falls and returns if the change is reverted.`;
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
  const automaticRecovery = incident.status === "resolved" ? null : evaluateAutomaticRecovery(incident);
  const nextAction = automaticRecovery?.state === "verified"
    ? { label: "Resolve it — it recovered", reason: automaticRecovery.reason.replace(/ This verifies delivery, not runtime health\.$/, ""), href: "?area=validate" }
    : incident.status === "monitoring"
    ? { label: "Confirm it stays fixed, then resolve", reason: automaticRecovery?.reason ?? "Resolve once you're satisfied it's fixed.", href: "?area=validate" }
    : incident.status === "resolved"
      ? { label: "Write down what you learned", reason: "Note the cause and any follow-ups in Investigation tools → Activity & handoff.", href: "?area=handoff" }
    : activeTest
    ? { label: activeTest.status === "running" ? "Record what the check showed" : "Do the assigned check", reason: activeTest.title, href: `?area=investigate&test=${activeTest.id}` }
    : contested
      ? { label: "Sort out the checks that disagree", reason: contested.outcomeSummary, href: `?area=investigate&hypothesis=${encodeURIComponent(contested.id)}` }
    : leading?.state === "supported"
      ? { label: leading.nextTest.startsWith("Fix it:") ? "Fix it, then mark it fixed" : "Try a fix", reason: leading.nextTest, href: "?area=validate" }
    : leading
      ? { label: leading.testCount ? "Try a different check" : "Check the likely cause", reason: leading.nextTest, href: `?area=investigate&hypothesis=${encodeURIComponent(leading.id)}` }
      : { label: "Add more of what you're seeing", reason: evidenceGaps[0] ?? "Every explanation so far has been ruled out.", href: "?area=evidence&gap=missing" };

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
      ? `${leading.claim} ${leading.state === "supported" ? "A check you ran supports it." : leading.state === "contested" ? "The checks you ran disagree." : "It hasn't been checked yet."}`
      : "Every explanation so far has been ruled out. Add more of what you're seeing to find another.",
    nextAction
  };
}
