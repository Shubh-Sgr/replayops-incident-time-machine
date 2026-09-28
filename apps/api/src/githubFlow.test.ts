import { describe, expect, it } from "vitest";
import { evaluateGitHubDeliveryRecovery } from "./casework.js";
import { diagnoseIncident } from "./diagnosis.js";
import { buildInvestigationIntelligence } from "./intelligence.js";
import type { Incident, IncidentEvent } from "./types.js";

const repo = "acme/api";
const event = (id: string, timestamp: string, kind: IncidentEvent["kind"], metadata: Record<string, unknown>): IncidentEvent => ({ id, incidentId: "i", timestamp, service: repo, kind, title: id, detail: id, impactScore: kind === "alert" ? 78 : 24, metadata: { provider: "github", repository: repo, ...metadata } });
const incident = (events: IncidentEvent[]): Incident => ({ id: "i", code: "AUTO-1", title: "Deployment failure", summary: "", service: repo, environment: "production", severity: "high", status: "monitoring", owner: "a@b.c", startedAt: "2026-09-28T10:04:00Z", resolvedAt: null, createdAt: "2026-09-28T10:04:00Z", updatedAt: "2026-09-28T10:04:00Z", events });
const push = event("push", "2026-09-28T10:00:00Z", "metric", { eventType: "push", sha: "bbbbbbb1", beforeSha: "aaaaaaa1" });
const deploy = event("deploy", "2026-09-28T10:02:00Z", "deploy", { eventType: "deployment", sha: "bbbbbbb1", deploymentEnvironment: "production" });
const failed = event("failed", "2026-09-28T10:04:00Z", "alert", { eventType: "deployment_status", state: "failure", sha: "bbbbbbb1", deploymentEnvironment: "production", sourceUrl: "https://ci/run/1" });
const success = event("success", "2026-09-28T10:20:00Z", "deploy", { eventType: "deployment_status", state: "success", sha: "ccccccc1", deploymentEnvironment: "production" });

describe("GitHub delivery incidents", () => {
  it("verifies recovery only after a later success on the same lane", () => {
    expect(evaluateGitHubDeliveryRecovery(incident([push, deploy, failed]))!.state).toBe("insufficient");
    expect(evaluateGitHubDeliveryRecovery(incident([push, deploy, failed, success]))!.state).toBe("verified");
    const refailed = event("refailed", "2026-09-28T10:30:00Z", "alert", { eventType: "deployment_status", state: "error", deploymentEnvironment: "production" });
    expect(evaluateGitHubDeliveryRecovery(incident([push, deploy, failed, success, refailed]))!.state).toBe("insufficient");
    const otherEnv = { ...success, metadata: { ...success.metadata, deploymentEnvironment: "staging" } };
    expect(evaluateGitHubDeliveryRecovery(incident([failed, otherEnv]))!.state).toBe("insufficient");
  });

  it("suggests the commit diff and a redeploy of the last good commit", () => {
    const diagnosis = diagnoseIncident({ ...incident([push, deploy, failed]), status: "investigating" });
    expect(diagnosis.hypotheses[0]!.nextTest).toContain("https://github.com/acme/api/compare/aaaaaaa1...bbbbbbb1");
    expect(diagnosis.hypotheses[0]!.safeAction).toContain("aaaaaaa");
    expect(diagnosis.evidenceGaps.join(" ")).not.toContain("No trace");
    const queries = buildInvestigationIntelligence(incident([push, deploy, failed]), []).querySuggestions;
    expect(queries.map((item) => item.source)).toEqual(["GitHub", "GitHub"]);
    expect(queries[1]!.query).toBe("https://ci/run/1");
  });

  it("points a monitoring incident at recovery", () => {
    expect(diagnoseIncident(incident([push, deploy, failed])).nextAction.href).toBe("?area=validate");
  });
});
