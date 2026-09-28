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
    return { event, lane: `${repository} deploy ${String(meta.deploymentEnvironment ?? "production")}`, passed: state === "success" };
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
    if (!latest.passed) return { state:"insufficient", reason:`Waiting for GitHub to report a successful run after the failure “${latest.event.title}”. Push a fix or redeploy the last good commit; recovery is verified automatically when it succeeds.`, criterionVersion:null, evaluatedAt, supportingMeasurementIds:[latest.event.id] };
  }
  const successes = failedLanes.map((lane) => outcomes.filter((item) => item.lane === lane).at(-1)!);
  return { state:"verified", reason:`GitHub reported success after the failure: ${successes.map((item) => `“${item.event.title}”${item.event.metadata?.sha ? ` (${String(item.event.metadata.sha).slice(0, 7)})` : ""}`).join(", ")}. This verifies delivery, not runtime health.`, criterionVersion:null, evaluatedAt, supportingMeasurementIds:successes.map((item) => item.event.id) };
}

