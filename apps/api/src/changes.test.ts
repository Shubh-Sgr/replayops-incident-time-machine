import { describe, expect, it } from "vitest";
import { changeEvidence, commitRange, extractDelivery, isChangeEvent, resolveChange, selectChangesForIncident, type ChangeRecord, type CommitRecord } from "./changes.js";
import { defaultEnvironments, defaultReleaseBranches, type ServiceMapping } from "./release.js";

const push = (before: string, after: string, commits: Array<[string, string, string[]]>, branch = "main") => extractDelivery("github", {
  ref: `refs/heads/${branch}`, before, after, repository: { full_name: "Acme/Platform" },
  commits: commits.map(([id, message, files]) => ({ id, message, timestamp: "2026-10-01T10:00:00Z", author: { username: "asha" }, url: `https://github.com/acme/platform/commit/${id}`, modified: files }))
}, "push", "d").commits;

describe("extracting changes", () => {
  it("records pushed commits with their files, on any branch", () => {
    const commits = push("a0", "a2", [["a1", "Add IBAN check\n\nlong body", ["services/payouts/iban.ts"]], ["a2", "Fix typo", ["README.md"]]], "feature/iban");
    expect(commits).toMatchObject([{ sha: "a1", message: "Add IBAN check", branch: "feature/iban", files: ["services/payouts/iban.ts"], pushAfter: "a2", position: 0 }, { sha: "a2", position: 1 }]);
  });

  it("turns deployment statuses and generic change events into changes", () => {
    const [deploy] = extractDelivery("github", { repository: { full_name: "acme/platform" }, deployment: { id: 9, sha: "c3", environment: "Production", ref: "main" }, deployment_status: { state: "success", created_at: "2026-10-02T09:00:00Z" } }, "deployment_status", "d").changes;
    expect(deploy).toMatchObject({ kind: "deploy", status: "success", environment: "Production", sha: "c3", repository: "acme/platform", externalId: "github:deployment:9:success" });
    expect(extractDelivery("github", { repository: { full_name: "acme/platform" }, deployment: { id: 9 }, deployment_status: { state: "in_progress" } }, "deployment_status", "d").changes).toEqual([]);
    const [flag] = extractDelivery("generic", { kind: "change", changeType: "feature_flag", service: "payouts-api", environment: "prd", flag: "fast-payouts", from: false, to: true, eventId: "f1" }, "", "d").changes;
    expect(flag).toMatchObject({ kind: "feature_flag", service: "payouts-api", externalId: "generic:f1", metadata: { flagKey: "fast-payouts", newValue: true } });
    expect(isChangeEvent({ kind: "alert", changeType: "deploy" })).toBe(false);
    expect(isChangeEvent({ kind: "deploy", service: "x" })).toBe(true);
  });
});

describe("commit ranges", () => {
  const history: CommitRecord[] = [
    ...push("a0", "a2", [["a1", "one", ["x"]], ["a2", "two", ["y"]]]),
    ...push("a2", "b2", [["b1", "three", ["services/payouts/build.ts"]], ["b2", "four", ["docs/a.md"]]]),
    ...push("b2", "c1", [["c1", "five", ["apps/web/a.tsx"]]])
  ];

  it("lists the commits between two deployed SHAs across pushes made days apart", () => {
    expect(commitRange(history, "c1", "a2")).toEqual({ commits: [expect.objectContaining({ sha: "c1" }), expect.objectContaining({ sha: "b2" }), expect.objectContaining({ sha: "b1" })], complete: true });
  });

  it("handles a deploy of a commit in the middle of a push, and short SHAs", () => {
    expect(commitRange(history, "b1", "a2").commits.map((commit) => commit.sha)).toEqual(["b1"]);
    expect(commitRange(history, "c1", "b2").commits.map((commit) => commit.sha)).toEqual(["c1"]);
  });

  it("says when the range is incomplete because earlier pushes were never seen", () => {
    expect(commitRange(history, "c1", "zz9").complete).toBe(false);
  });
});

const services: ServiceMapping[] = [
  { name: "payouts-api", repositories: ["acme/platform"], paths: ["services/payouts"] },
  { name: "web", repositories: ["acme/platform"], paths: ["apps/web"] }
];
const context = { environments: defaultEnvironments, services, releaseBranches: defaultReleaseBranches, repositoryCommits: [
  ...push("a0", "a2", [["a1", "one", ["x"]], ["a2", "two", ["y"]]]),
  ...push("a2", "b2", [["b1", "Validate IBAN in payouts", ["services/payouts/build.ts"]], ["b2", "Restyle header", ["apps/web/header.tsx"]]])
] };

describe("resolving a change", () => {
  it("names the environment canonically and splits a monorepo deploy per touched service", () => {
    const records = resolveChange({ kind: "deploy", status: "success", environment: "Production", sha: "b2", repository: "acme/platform", occurredAt: "2026-10-02T09:00:00Z", source: "github", externalId: "github:deployment:9:success", metadata: {} }, { ...context, previousDeploy: { sha: "a2" } });
    expect(records.map((record) => [record.service, record.environment, record.title, record.commits.length])).toEqual([
      ["payouts-api", "production", "Deployed payouts-api b2 to production", 2],
      ["web", "production", "Deployed web b2 to production", 2]
    ]);
    expect(new Set(records.map((record) => record.externalId)).size).toBe(2);
  });
});

describe("previous release", () => {
  it("is inherited by deploys, never by flag or config changes", () => {
    const flag = resolveChange({ kind: "feature_flag", status: "success", service: "payouts-api", environment: "prod", occurredAt: "2026-10-02T09:00:00Z", source: "generic", externalId: "f", metadata: { flagKey: "x", newValue: true } }, { ...context, previousDeploy: { version: "v3.1.0" } })[0]!;
    expect(flag.previousVersion).toBeUndefined();
    const deploy = resolveChange({ kind: "deploy", status: "success", service: "payouts-api", environment: "prod", version: "v3.2.0", occurredAt: "2026-10-02T09:00:00Z", source: "generic", externalId: "d", metadata: {} }, { ...context, previousDeploy: { version: "v3.1.0" } })[0]!;
    expect(deploy.previousVersion).toBe("v3.1.0");
  });
});

describe("linking changes to an incident", () => {
  const change = (id: string, overrides: Partial<ChangeRecord>): ChangeRecord => ({ id, kind: "deploy", status: "success", service: "payouts-api", environment: "production", title: id, occurredAt: "2026-10-02T09:00:00Z", source: "github", externalId: id, metadata: {}, commits: [], files: [], ...overrides });
  const changes = [
    change("prod-v1", { occurredAt: "2026-09-25T09:00:00Z", version: "v1" }),
    change("prod-v2", { occurredAt: "2026-10-01T09:00:00Z", version: "v2" }),
    change("staging-v3", { environment: "staging", occurredAt: "2026-10-03T08:00:00Z" }),
    change("flag", { kind: "feature_flag", occurredAt: "2026-10-03T08:30:00Z" }),
    change("web-deploy", { service: "web", occurredAt: "2026-10-03T08:45:00Z" }),
    change("after", { occurredAt: "2026-10-03T11:00:00Z" })
  ];

  it("includes the live release however old, recent changes, and nothing from other environments, services, or after the start", () => {
    const selected = selectChangesForIncident(changes, { service: "payouts-api", relatedServices: ["payouts-api"], environment: "production", startedAt: "2026-10-03T10:00:00Z" });
    expect(selected.map((item) => [item.change.id, item.liveRelease])).toEqual([["flag", false], ["prod-v2", true]]);
  });

  it("describes a change that did not touch the failing service", () => {
    const evidence = changeEvidence(change("web", { service: "payouts-api", files: ["apps/web/header.tsx"] }), { liveRelease: true, incidentService: "payouts-api", services });
    expect(evidence.metadata.touchesService).toBe(false);
    expect(evidence.detail).toContain("None of its changed files are in payouts-api's paths.");
  });
});
