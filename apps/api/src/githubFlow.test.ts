import { describe, expect, it } from "vitest";
import { evaluateGitHubDeliveryRecovery } from "./casework.js";
import { normalizePayload } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";
import { diagnoseIncident } from "./diagnosis.js";
import { buildInvestigationIntelligence } from "./intelligence.js";
import type { Incident, IncidentEvent } from "./types.js";

const repo = "acme/api";
const testWith = (hypothesisId: string, status: "supported"): import("./types.js").HypothesisTest => ({ id: "t", incidentId: "i", hypothesisId, title: "t", instruction: "i", assignee: "a", status, result: "observed", createdAt: "2026-09-28T10:05:00Z", updatedAt: "2026-09-28T10:05:00Z" });
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

  it("links diffs only for real changes, not for workflow results", () => {
    const earlierRun = event("earlier-run", "2026-09-28T09:58:00Z", "metric", { eventType: "workflow_run", conclusion: "success", sha: "zzzzzzz1", workflow: "CI" });
    const queries = buildInvestigationIntelligence(incident([earlierRun, push, deploy, failed]), []).querySuggestions;
    expect(queries.filter((item) => item.label === "Diff of the deployed change")).toHaveLength(1);
  });

  it("tells a confirmed CI failure to push a fix, not to redeploy to production", () => {
    const drillPush = event("drill-push", "2026-09-28T10:00:00Z", "metric", { eventType: "push", sha: "ddddddd1", beforeSha: "0000000000", branch: "drill" });
    const runFailed = event("run-failed", "2026-09-28T10:01:00Z", "alert", { eventType: "workflow_run", conclusion: "failure", sha: "ddddddd1", workflow: "CI", branch: "drill" });
    const open = { ...incident([drillPush, runFailed]), status: "investigating" as const };
    const leading = diagnoseIncident(open).hypotheses[0]!;
    const confirmed = diagnoseIncident(open, [{ ...testWith(leading.id, "supported") }]);
    expect(confirmed.nextAction.label).toBe("Fix it, then confirm recovery");
    expect(confirmed.nextAction.reason).toContain("on drill");
    expect(confirmed.nextAction.reason).not.toContain("production");
  });

  it("points a monitoring incident at recovery", () => {
    expect(diagnoseIncident(incident([push, deploy, failed])).nextAction.href).toBe("?area=validate");
  });
});

describe("GitHub ingestion noise", () => {
  const repository = { id: 7, full_name: "acme/api", html_url: "https://github.com/acme/api" };
  it("ignores queued and in-progress workflow runs and keeps only the commit subject", () => {
    expect(normalizePayload("github", { repository, workflow_run: { id: 1, name: "CI", status: "queued", head_branch: "main" } }, "q", "workflow_run")).toHaveLength(0);
    expect(normalizePayload("github", { repository, workflow_run: { id: 1, name: "CI", status: "in_progress", head_branch: "main" } }, "p", "workflow_run")).toHaveLength(0);
    expect(normalizePayload("github", { repository, workflow_run: { id: 1, name: "CI", status: "completed", conclusion: "failure", head_branch: "main", html_url: "https://github.com/acme/api/actions/runs/1" } }, "c", "workflow_run")[0]!.metadata?.logUrl).toBe("https://github.com/acme/api/actions/runs/1");
    const push = normalizePayload("github", { repository, ref: "refs/heads/main", after: "b", before: "a", head_commit: { message: "fix: subject\n\nlong body" } }, "push", "push")[0]!;
    expect(push.detail).toBe("fix: subject");
  });

  it("groups GitHub evidence by branch", async () => {
    const repo = new MemoryRepository();
    const integration = await repo.createIntegration("demo", { name: "GitHub", provider: "github" });
    const target = (await repo.getIntegrationTarget(integration.id))!;
    const now = Date.now();
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const signal = (id: string, branch: string, minutes: number, impactScore: number, kind: "metric" | "alert" = "metric") => ({ externalId: id, timestamp: at(minutes), service: "acme/api", kind, title: id, detail: id, impactScore, severity: impactScore > 70 ? "high" as const : "low" as const, metadata: { provider: "github", eventType: kind === "alert" ? "workflow_run" : "push", branch } });
    await repo.ingest(target, { externalId: "d1", signals: [signal("main-push", "main", 10, 18), signal("drill-push", "drill", 5, 18)] });
    const result = await repo.ingest(target, { externalId: "d2", signals: [signal("drill-fail", "drill", 1, 76, "alert")] });
    const incident = (await repo.getIncident("demo", result.incidentIds[0]!))!;
    expect(incident.events.map((event) => event.title).sort()).toEqual(["drill-fail", "drill-push"]);
    const later = await repo.ingest(target, { externalId: "d3", signals: [signal("main-push-2", "main", 0, 18)] });
    expect(later.incidentIds).toHaveLength(0);
  });
});
