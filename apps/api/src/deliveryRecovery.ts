import type { RecoveryEvaluation } from "./casework.js";
import type { Incident } from "./types.js";

type GitHubOutcome = { event: Incident["events"][number]; lane: string; passed: boolean };
const githubOutcome = (event: Incident["events"][number]): GitHubOutcome | null => {
  const meta = event.metadata ?? {};
  if (meta.provider !== "github" || event.evidenceState === "excluded") return null;
  const repository = String(meta.repository ?? event.service);
  if (meta.eventType === "deployment_status") {
    const state = String(meta.state ?? "");
    if (!["success", "failure", "error"].includes(state)) return null;
    return { event, lane: `${repository} ${event.service} deploy ${String(meta.deploymentEnvironment ?? "production").toLowerCase()}`, passed: state === "success" };
  }
  if (meta.eventType === "workflow_run") {
    const conclusion = String(meta.conclusion ?? "");
    if (!["success", "failure", "timed_out", "action_required"].includes(conclusion)) return null;
    return { event, lane: `${repository} workflow ${String(meta.workflow ?? meta.workflowName ?? "")}`, passed: conclusion === "success" };
  }
  return null;
};

/** A failed GitHub deployment or workflow is recovered when the same lane later reports success; a newer failure overrides it. */
export function evaluateGitHubDeliveryRecovery(incident: Incident, now = new Date()): RecoveryEvaluation | null {
  const outcomes = incident.events.map(githubOutcome).filter((item): item is GitHubOutcome => Boolean(item)).sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));
  const failedLanes = [...new Set(outcomes.filter((item) => !item.passed).map((item) => item.lane))];
  if (!failedLanes.length) return null;
  const evaluatedAt = now.toISOString();
  for (const lane of failedLanes) {
    const latest = outcomes.filter((item) => item.lane === lane).at(-1)!;
    if (!latest.passed) return { automatic:"github", state:"insufficient", reason:`Waiting for GitHub to report a successful run after the failure “${latest.event.title}”. Push a fix or redeploy the last good commit; recovery is verified automatically when it succeeds.`, criterionVersion:null, evaluatedAt, supportingMeasurementIds:[latest.event.id] };
  }
  const successes = failedLanes.map((lane) => outcomes.filter((item) => item.lane === lane).at(-1)!);
  return { automatic:"github", state:"verified", reason:`GitHub reported success after the failure: ${successes.map((item) => `“${item.event.title}”${item.event.metadata?.sha ? ` (${String(item.event.metadata.sha).slice(0, 7)})` : ""}`).join(", ")}. This verifies delivery, not runtime health.`, criterionVersion:null, evaluatedAt, supportingMeasurementIds:successes.map((item) => item.event.id) };
}


/** How long a resolved alert must stay quiet before it confirms recovery, so a flapping alert doesn't. */
export const ALERT_QUIET_MINUTES = 5;
const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16) + " UTC";

/**
 * Runtime recovery from the monitoring system itself: every Grafana (or Alertmanager) alert in the incident
 * reported resolved and stayed quiet for a few minutes, and no new errors arrived after that. The alert's own
 * rule is the "number that shows it's fixed", so nobody has to re-enter it.
 */
export function evaluateAlertRecovery(incident: Incident, now = new Date()): RecoveryEvaluation | null {
  const events = incident.events.filter((event) => event.evidenceState !== "excluded").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lifecycle = events.filter((event) => event.metadata?.signal === "alert-lifecycle" && typeof event.metadata?.alertIdentity === "string" && (event.kind === "alert" || event.kind === "recovery"));
  const identities = [...new Set(lifecycle.filter((event) => event.kind === "alert").map((event) => String(event.metadata!.alertIdentity)))];
  if (!identities.length) return null;
  const evaluatedAt = now.toISOString();
  const latest = identities.map((identity) => lifecycle.filter((event) => event.metadata!.alertIdentity === identity).at(-1)!);
  const firing = latest.find((event) => event.kind === "alert");
  if (firing) return { automatic: "alerts", state: "insufficient", reason: `Waiting for Grafana to report “${firing.title}” resolved. Recovery is confirmed automatically when it does and stays quiet for ${ALERT_QUIET_MINUTES} minutes.`, criterionVersion: null, evaluatedAt, supportingMeasurementIds: [firing.id] };
  const lastResolved = latest.reduce((newest, event) => event.timestamp > newest.timestamp ? event : newest);
  const errorsAfter = events.filter((event) => event.timestamp > lastResolved.timestamp && (event.metadata?.exception || event.kind === "alert"));
  if (errorsAfter.length) return { automatic: "alerts", state: "failed", reason: `Grafana reported the alert resolved at ${clock(lastResolved.timestamp)}, but ${errorsAfter.length} new error${errorsAfter.length === 1 ? "" : "s"} arrived after that (latest: “${errorsAfter.at(-1)!.title}”).`, criterionVersion: null, evaluatedAt, supportingMeasurementIds: errorsAfter.map((event) => event.id) };
  const quietUntil = Date.parse(lastResolved.timestamp) + ALERT_QUIET_MINUTES * 60_000;
  const resolvedText = latest.map((event) => `“${event.title}”`).join(", ");
  if (now.getTime() < quietUntil) return { automatic: "alerts", state: "insufficient", reason: `Grafana reported ${resolvedText} at ${clock(lastResolved.timestamp)}. Confirmed automatically if it stays quiet until ${clock(new Date(quietUntil).toISOString())}.`, criterionVersion: null, evaluatedAt, supportingMeasurementIds: latest.map((event) => event.id) };
  return { automatic: "alerts", state: "verified", reason: `Grafana reported ${resolvedText} at ${clock(lastResolved.timestamp)}, and nothing has fired or errored since.`, criterionVersion: null, evaluatedAt, supportingMeasurementIds: latest.map((event) => event.id) };
}

/** Recovery confirmed by the source systems themselves, without a hand-entered check. */
export const evaluateAutomaticRecovery = (incident: Incident, now = new Date()) => evaluateGitHubDeliveryRecovery(incident, now) ?? evaluateAlertRecovery(incident, now);
