/**
 * Which open incident a new signal belongs to. Pure functions only, shared by the in-memory and Postgres
 * repositories: each repository works out the facts below for its open incidents, and these rules decide.
 *
 * Real incidents don't respect a fixed clock. An outage can run for hours, a recovered problem can relapse
 * minutes later, a dependency several hops away can be the root cause, and a release or config change from
 * weeks ago can break something today. So:
 *
 *   - Identity first: the same delivery lane, alert key, failing commit, or exception fingerprint is the same
 *     problem while its incident is open, however long that takes.
 *   - Time second: a related signal joins an incident while it is still active — within the grouping window
 *     of its latest evidence, not of when it started — so a long outage stays one incident.
 *   - "Related" means connected in the service catalog to any service already in the incident, so a cascade
 *     (database → inventory → checkout) is one incident whichever symptom fires first.
 *   - Once the source has reported recovery and the incident has been quiet for the window, it is settled: a
 *     new problem opens a new incident instead of silently joining one that everyone believes is fixed.
 *     A problem inside the window is a relapse: the incident goes back to investigating and pages again.
 *   - A forgotten incident (never recovered, quiet for longer than the window) still takes its own recurring
 *     problem, but pages again, so a stale incident never swallows a page.
 */
import type { IncidentEvent, IncidentStatus } from "./types.js";

type Item = { kind?: string; metadata?: Record<string, unknown> };

/** The source reported the problem is gone: an alert resolved, a deploy succeeded, or a CI run passed. */
export const isRecoveryEvidence = (item: Item) => {
  const meta = item.metadata ?? {};
  return item.kind === "recovery" || meta.laneOnly === true || (meta.provider === "github" && meta.eventType === "workflow_run" && meta.conclusion === "success");
};

/** What a repository knows about one open incident, relative to the incoming signal. */
export interface GroupingCandidate {
  id: string;
  status: IncidentStatus;
  service: string;
  environment: string;
  startedAt: string;
  /** Time of the latest signal evidence (or the start, when there is none). */
  lastSignalAt: string;
  /** The latest problem-or-recovery evidence is a recovery. */
  recovered: boolean;
  /** Every service that has evidence in the incident, including its own. */
  services: string[];
  /** The incident has no branch evidence, or has evidence on the signal's branch. */
  branchCompatible: boolean;
  byLane: boolean;
  byCorrelation: boolean;
  byCommit: boolean;
  byFingerprint: boolean;
}

export interface GroupingContext {
  /** The signal's service and its neighbours in the service catalog. */
  relatedServices: string[];
  windowMinutes: number;
  /** Recovery evidence for its own lane only (a successful deploy). */
  laneOnly: boolean;
  /** The signal would open an incident on its own: above the threshold, allowed to page, not a recovery. */
  problem: boolean;
}

export type MatchReason = "lane" | "correlation" | "commit" | "fingerprint" | "window";
const tier: Record<MatchReason, number> = { lane: 0, correlation: 1, commit: 2, fingerprint: 3, window: 4 };

const quietFor = (candidate: Pick<GroupingCandidate, "lastSignalAt">, timestamp: string) => Date.parse(timestamp) - Date.parse(candidate.lastSignalAt);

function reasonFor(candidate: GroupingCandidate, signal: { timestamp: string; environment?: string }, context: GroupingContext): MatchReason | undefined {
  if (candidate.byLane) return "lane";
  if (context.laneOnly) return undefined;
  const sameEnvironment = candidate.environment === (signal.environment ?? "unknown");
  if (sameEnvironment && candidate.branchCompatible && candidate.byCorrelation) return "correlation";
  // A failed deployment and the failed workflow run for the same commit are one problem, wherever it ran.
  if (candidate.byCommit) return "commit";
  if (sameEnvironment && candidate.byFingerprint) return "fingerprint";
  if (!sameEnvironment || !candidate.branchCompatible) return undefined;
  if (!candidate.services.some((service) => context.relatedServices.includes(service))) return undefined;
  const window = context.windowMinutes * 60_000;
  const at = Date.parse(signal.timestamp);
  return at >= Date.parse(candidate.startedAt) - window && at <= Date.parse(candidate.lastSignalAt) + window ? "window" : undefined;
}

/** The open incident a signal joins, and why; the strongest reason wins, then the most recently active incident. */
export function chooseIncident<T extends GroupingCandidate>(candidates: T[], signal: { timestamp: string; environment?: string }, context: GroupingContext): { candidate: T; reason: MatchReason } | undefined {
  const window = context.windowMinutes * 60_000;
  return candidates
    .filter((candidate) => candidate.status !== "resolved")
    // Recovered and quiet: the incident is settled, and a new problem is a new incident.
    .filter((candidate) => !(context.problem && (candidate.status === "monitoring" || candidate.recovered) && quietFor(candidate, signal.timestamp) > window))
    .map((candidate) => ({ candidate, reason: reasonFor(candidate, signal, context) }))
    .filter((match): match is { candidate: T; reason: MatchReason } => Boolean(match.reason))
    .sort((a, b) => tier[a.reason] - tier[b.reason] || b.candidate.lastSignalAt.localeCompare(a.candidate.lastSignalAt))[0];
}

export interface JoinOutcome {
  /** Move the incident to monitoring. */
  monitoring: boolean;
  /** Back to investigating: the problem relapsed while recovery was being monitored. */
  reopen: boolean;
  /** Page again, with this reason. */
  repage?: string;
}

/** What joining does to the incident's lifecycle. */
export function joinOutcome(candidate: GroupingCandidate, reason: MatchReason, signal: { timestamp: string; service: string; kind: string }, context: GroupingContext): JoinOutcome {
  // A neighbour recovering says nothing about this incident's own service; only its own recovery does.
  if (signal.kind === "recovery") return { monitoring: candidate.status !== "monitoring" && (reason !== "window" || signal.service === candidate.service), reopen: false };
  if (!context.problem) return { monitoring: false, reopen: false };
  if (candidate.status === "monitoring") return { monitoring: false, reopen: true, repage: "The problem came back while recovery was being monitored." };
  const quiet = quietFor(candidate, signal.timestamp);
  if (quiet > context.windowMinutes * 60_000) return { monitoring: false, reopen: false, repage: `The problem fired again after ${describeQuiet(quiet)} without new evidence.` };
  return { monitoring: false, reopen: false };
}

const describeQuiet = (ms: number) => {
  const hours = ms / 3_600_000;
  return hours >= 48 ? `${Math.round(hours / 24)} days` : hours >= 1 ? `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}` : `${Math.round(ms / 60_000)} minutes`;
};

/** Grouping facts from an incident's own evidence; responder-excluded evidence and linked changes don't count. */
export function incidentFacts(
  incident: { id: string; status: IncidentStatus; service: string; environment?: string | null; startedAt: string; events: IncidentEvent[] },
  match: { lane?: string; correlationKey?: string; commit?: string; fingerprint?: string; branch?: string },
  keys: { lane: (event: IncidentEvent) => string | undefined; commit: (event: IncidentEvent) => string | undefined; fingerprint: (event: IncidentEvent) => string | undefined; branch: (event: IncidentEvent) => string | undefined }
): GroupingCandidate {
  const evidence = incident.events.filter((event) => event.provenance === "ingested" && (event.evidenceState ?? "active") === "active");
  const lastSignalAt = evidence.reduce((latest, event) => event.timestamp > latest ? event.timestamp : latest, incident.startedAt);
  const outcome = evidence.filter((event) => event.kind === "alert" || isRecoveryEvidence(event)).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  const branches = new Set(evidence.map(keys.branch).filter(Boolean));
  return {
    id: incident.id, status: incident.status, service: incident.service, environment: incident.environment ?? "unknown", startedAt: incident.startedAt, lastSignalAt,
    recovered: Boolean(outcome && isRecoveryEvidence(outcome)),
    services: [...new Set([incident.service, ...evidence.map((event) => event.service)])],
    branchCompatible: !match.branch || !branches.size || branches.has(match.branch),
    byLane: Boolean(match.lane) && evidence.some((event) => keys.lane(event) === match.lane),
    byCorrelation: Boolean(match.correlationKey) && evidence.some((event) => event.metadata?.correlationKey === match.correlationKey),
    byCommit: Boolean(match.commit) && evidence.some((event) => event.kind === "alert" && keys.commit(event) === match.commit),
    byFingerprint: Boolean(match.fingerprint) && evidence.some((event) => keys.fingerprint(event) === match.fingerprint)
  };
}
