/**
 * Real-world scenarios: a team ships through feature branches → main → staging → production, flips flags,
 * and gets paged days later. Each scenario drives the real intake path (normalization, change log, grouping,
 * linking) and the diagnosis, and asserts what an on-call engineer should see.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { extractDelivery } from "./changes.js";
import { diagnoseIncident } from "./diagnosis.js";
import { normalizePayload } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";
import type { Incident, IntegrationProvider } from "./types.js";
import { workspaceService } from "./workspace.js";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const HOUR = 3_600_000;
const base = Date.now() - 7 * 24 * HOUR;
const at = (hours: number) => new Date(base + hours * HOUR).toISOString();
let sequence = 0;

beforeAll(async () => {
  await workspaceService.upsertService(ADMIN, "test", { name: "payouts-api", ownerTeam: "Payments", tier: "critical", repositoryUrl: null, runbookUrl: null, dependencies: [], repositories: ["acme/platform"], paths: ["services/payouts"] });
  await workspaceService.upsertService(ADMIN, "test", { name: "web", ownerTeam: "Web", tier: "standard", repositoryUrl: null, runbookUrl: null, dependencies: [], repositories: ["acme/platform"], paths: ["apps/web"] });
  // One repository, two services: a path-scoped drill service and an app that owns the rest of the repo.
  await workspaceService.upsertService(ADMIN, "test", { name: "drill-payouts", ownerTeam: "Drill", tier: "critical", repositoryUrl: null, runbookUrl: null, dependencies: [], repositories: ["acme/shop"], paths: ["drill/payouts-api"] });
  await workspaceService.upsertService(ADMIN, "test", { name: "shop", ownerTeam: "Shop", tier: "critical", repositoryUrl: null, runbookUrl: null, dependencies: [], repositories: ["acme/shop"], paths: [] });
  await workspaceService.upsertService(ADMIN, "test", { name: "ledger-api", ownerTeam: "Ledger", tier: "critical", repositoryUrl: "https://github.com/acme/ledger", runbookUrl: null, dependencies: [], repositories: [] });
});

function world() {
  const repository = new MemoryRepository();
  const target = (provider: IntegrationProvider) => ({ id: `int-${provider}`, organizationId: "demo-organization", name: provider, provider, status: "active" as const });
  const send = async (provider: IntegrationProvider, payload: Record<string, unknown>, eventName = "") => {
    const externalId = `delivery-${++sequence}`;
    return repository.ingest(target(provider), { externalId, signals: normalizePayload(provider, payload, externalId, eventName), delivery: extractDelivery(provider, payload, eventName, externalId) });
  };
  const github = {
    push: (repo: string, branch: string, before: string, after: string, commits: Array<[string, string, string[]]>, hours: number) => send("github", {
      ref: `refs/heads/${branch}`, before, after, repository: { full_name: repo }, sender: { login: "asha" }, head_commit: { id: after, message: commits.at(-1)?.[1], timestamp: at(hours) },
      commits: commits.map(([id, message, files]) => ({ id, message, timestamp: at(hours), author: { username: "asha" }, url: `https://github.com/${repo}/commit/${id}`, modified: files }))
    }, "push"),
    deploy: (repo: string, environment: string, sha: string, state: "success" | "failure", hours: number) => send("github", {
      repository: { full_name: repo }, sender: { login: "deploy-bot" }, deployment: { id: ++sequence, sha, environment, ref: "main", creator: { login: "deploy-bot" } },
      deployment_status: { state, created_at: at(hours), log_url: "https://ci.example/run" }
    }, "deployment_status"),
    ci: (repo: string, branch: string, sha: string, conclusion: "success" | "failure", hours: number) => send("github", {
      action: "completed", repository: { full_name: repo }, sender: { login: "asha" },
      workflow_run: { id: ++sequence, name: "CI", status: "completed", conclusion, head_sha: sha, head_branch: branch, updated_at: at(hours) }
    }, "workflow_run")
  };
  const alert = (service: string, environment: string, hours: number, extra: Record<string, unknown> = {}) => send("generic", { kind: "alert", service, environment, title: `${service} 5xx above SLO`, detail: "Error rate 9%", impactScore: 86, timestamp: at(hours), eventId: `alert-${++sequence}`, ...extra });
  const change = (body: Record<string, unknown>, hours: number) => send("generic", { kind: "change", timestamp: at(hours), eventId: `change-${++sequence}`, ...body });
  const incident = async (id: string) => (await repository.getIncident(ADMIN, id)) as Incident;
  const diagnose = async (value: Incident) => {
    const fingerprints = value.events.map((event) => (event.metadata?.exception as { fingerprint?: string } | undefined)?.fingerprint).filter((item): item is string => Boolean(item));
    return diagnoseIncident(value, [], { exceptionHistory: await repository.exceptionHistory(ADMIN, fingerprints) });
  };
  return { repository, github, alert, change, incident, diagnose };
}

const typeError = (payout: number, line: number) => ({ error: { type: "TypeError", message: `Cannot read properties of undefined (reading 'iban') for payout ${payout}`, stack: `TypeError: x\n    at buildPayout (/app/services/payouts/build.ts:${line}:11)` } });

describe("real-world scenarios", () => {
  it("1. a commit merged Monday, deployed Thursday, breaks Friday: the live release is the suspect, with its commits", async () => {
    const w = world();
    await w.github.push("acme/platform", "main", "a0", "a1", [["a1", "Validate IBAN before payout", ["services/payouts/build.ts"]]], 0);
    await w.github.deploy("acme/platform", "Production", "a0", "success", -24);
    await w.github.deploy("acme/platform", "staging", "a1", "success", 2);
    await w.github.deploy("acme/platform", "Production", "a1", "success", 72);
    const opened = await w.alert("payouts-api", "prd", 96, typeError(1, 41));
    const incident = await w.incident(opened.opened![0]!.id);
    const linked = incident.events.filter((event) => event.metadata?.changeId);
    expect(linked.map((event) => [event.title, event.metadata?.liveRelease])).toEqual([["Deployed payouts-api a1 to production", true]]);
    expect(linked[0]!.metadata?.commits).toEqual([expect.objectContaining({ sha: "a1", message: "Validate IBAN before payout" })]);
    expect(linked[0]!.metadata?.touchesService).toBe(true);
    const diagnosis = await w.diagnose(incident);
    expect(diagnosis.changeCandidates[0]).toMatchObject({ title: "Deployed payouts-api a1 to production" });
    expect(diagnosis.changeCandidates[0]!.reason).toContain("by 24 hours");
    expect(diagnosis.changeCandidates[0]!.reason).toContain("It was the release running when the incident started.");
    expect(diagnosis.hypotheses[0]!.nextTest).toContain("https://github.com/acme/platform/compare/a0...a1");
  });

  it("2. an unrelated merge (web only) deployed just before a payouts alert is not blamed", async () => {
    const w = world();
    await w.github.push("acme/platform", "main", "b0", "b1", [["b1", "Payout retries", ["services/payouts/retry.ts"]]], 0);
    await w.github.deploy("acme/platform", "production", "b1", "success", 1);
    await w.github.push("acme/platform", "main", "b1", "b2", [["b2", "Restyle header", ["apps/web/header.tsx"]]], 90);
    await w.github.deploy("acme/platform", "production", "b2", "success", 95);
    const opened = await w.alert("payouts-api", "production", 95.2);
    const incident = await w.incident(opened.opened![0]!.id);
    const titles = incident.events.filter((event) => event.metadata?.changeId).map((event) => event.title);
    expect(titles).not.toContain("Deployed web b2 to production");
    expect(titles).toEqual(["Deployed payouts-api b1 to production"]);
  });

  it("3. staging, QA and preview alerts are kept as early warnings and never page", async () => {
    const w = world();
    expect((await w.alert("payouts-api", "Staging", 1)).opened).toEqual([]);
    expect((await w.alert("payouts-api", "uat", 1.1)).opened).toEqual([]);
    expect((await w.alert("payouts-api", "pr-482", 1.2)).opened).toEqual([]);
    expect((await w.alert("payouts-api", "production", 1.3)).opened).toHaveLength(1);
  });

  it("4. CI failing on a feature branch never opens an incident; failing on main does, as payouts-api", async () => {
    const w = world();
    expect((await w.github.ci("acme/ledger", "feature/new-ledger", "c1", "failure", 1)).opened).toEqual([]);
    const main = await w.github.ci("acme/ledger", "main", "c2", "failure", 2);
    expect(main.opened?.[0]).toMatchObject({ service: "ledger-api" });
  });

  it("5. the same error hours later joins the open incident instead of opening a new one", async () => {
    const w = world();
    const first = await w.alert("payouts-api", "production", 10, typeError(1, 41));
    const later = await w.alert("payouts-api", "production", 16, typeError(2, 44));
    expect(later.opened).toEqual([]);
    expect(later.incidentIds).toEqual([first.opened![0]!.id]);
  });

  it("6. a chronic error does not blame yesterday's release; a brand-new one does", async () => {
    const w = world();
    const timeout = { error: { type: "TimeoutError", message: "Bank API timed out after 30s" } };
    await w.alert("ledger-api", "production", 0, { ...timeout, kind: "metric", impactScore: 30 });
    await w.change({ changeType: "deploy", service: "ledger-api", environment: "production", version: "v7" }, 140);
    const chronic = await w.incident((await w.alert("ledger-api", "production", 150, timeout)).opened![0]!.id);
    const chronicLead = (await w.diagnose(chronic)).changeCandidates.find((candidate) => candidate.title.includes("v7"))!;
    expect(chronicLead.reason).toContain("Its errors were already happening before it.");

    const fresh = world();
    await fresh.change({ changeType: "deploy", service: "ledger-api", environment: "production", version: "v8" }, 140);
    const incident = await fresh.incident((await fresh.alert("ledger-api", "production", 150, { error: { type: "KeyError", message: "'sku'" } })).opened![0]!.id);
    const freshLead = (await fresh.diagnose(incident)).changeCandidates.find((candidate) => candidate.title.includes("v8"))!;
    expect(freshLead.reason).toContain("first appeared after it");
    expect(freshLead.score).toBeGreaterThan(chronicLead.score);
  });

  it("7. a canary: errors only from the new version point at it; errors from both versions do not", async () => {
    const w = world();
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v2" }, 100);
    const incident = await w.incident((await w.alert("payouts-api", "production", 101, { version: "v2" })).opened![0]!.id);
    await w.alert("payouts-api", "production", 101.1, { version: "v2" });
    expect((await w.diagnose(await w.incident(incident.id))).changeCandidates[0]!.reason).toContain("Every failing event reports version v2.");

    const mixed = world();
    await mixed.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v2" }, 100);
    const both = await mixed.incident((await mixed.alert("payouts-api", "production", 101, { version: "v1" })).opened![0]!.id);
    await mixed.alert("payouts-api", "production", 101.1, { version: "v2" });
    expect((await mixed.diagnose(await mixed.incident(both.id))).changeCandidates[0]!.reason).toContain("Failures also come from v1");
  });

  it("8. a flag flipped 20 minutes ago outranks a release that has been live for days", async () => {
    const w = world();
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v5" }, 10);
    await w.change({ changeType: "feature_flag", service: "payouts-api", environment: "production", flag: "instant-payouts", from: false, to: true }, 99.66);
    const incident = await w.incident((await w.alert("payouts-api", "production", 100)).opened![0]!.id);
    const diagnosis = await w.diagnose(incident);
    expect(diagnosis.changeCandidates[0]!.title).toBe("Feature flag instant-payouts set to true on payouts-api");
    expect(diagnosis.hypotheses[0]!.safeAction).toContain("back to false");
  });

  it("9. a rollback during the incident is recorded as a response, not a suspect", async () => {
    const w = world();
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v9" }, 50);
    const opened = await w.alert("payouts-api", "production", 51);
    const id = opened.opened![0]!.id;
    const rollback = await w.change({ changeType: "rollback", service: "payouts-api", environment: "production", version: "v8" }, 51.5);
    expect(rollback.incidentIds).toEqual([id]);
    const incident = await w.incident(id);
    expect(incident.events.find((event) => event.title.startsWith("Rolled back"))?.metadata?.afterIncidentStart).toBe(true);
    expect((await w.diagnose(incident)).changeCandidates.map((candidate) => candidate.title)).not.toContain("Rolled back payouts-api v8 to production");
  });

  it("10. a deploy webhook that arrives after the incident opened is still linked as the live release", async () => {
    const w = world();
    const opened = await w.alert("ledger-api", "production", 30);
    const late = await w.change({ changeType: "deploy", service: "ledger-api", environment: "production", version: "v3" }, 29.9);
    expect(late.incidentIds).toEqual([opened.opened![0]!.id]);
    const incident = await w.incident(opened.opened![0]!.id);
    expect(incident.events.find((event) => event.title.includes("v3"))?.metadata?.liveRelease).toBe(true);
  });

  it("11. a failed production deploy and the errors right after it are one incident, recovered by the next good deploy", async () => {
    const w = world();
    const failed = await w.github.deploy("acme/ledger", "production", "d1", "failure", 60);
    const id = failed.opened![0]!.id;
    expect(failed.opened![0]).toMatchObject({ service: "ledger-api", environment: "production" });
    expect((await w.alert("ledger-api", "production", 60.2)).incidentIds).toEqual([id]);
    expect((await w.github.deploy("acme/ledger", "production", "d2", "success", 61)).incidentIds).toContain(id);
  });

  it("13. ruling a change out removes it from the diagnosis and the next suspect leads", async () => {
    const w = world();
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v4" }, 80);
    await w.change({ changeType: "config", service: "payouts-api", environment: "production", key: "BANK_TIMEOUT_MS", from: 3000, to: 300 }, 99.5);
    const incident = await w.incident((await w.alert("payouts-api", "production", 100)).opened![0]!.id);
    const config = incident.events.find((event) => event.title.startsWith("Config change"))!;
    expect((await w.diagnose(incident)).changeCandidates[0]!.eventId).toBe(config.id);
    await w.repository.updateEvent(ADMIN, incident.id, config.id, { evidenceState: "excluded", correctionReason: "Config was reverted before the alert." });
    const after = await w.diagnose(await w.incident(incident.id));
    expect(after.changeCandidates.map((candidate) => candidate.eventId)).not.toContain(config.id);
    expect(after.changeCandidates[0]!.title).toContain("v4");
  });

  it("14. an error seen in staging on v3.1.0 before promotion points at v3.1.0, even with a flag flipped minutes ago", async () => {
    const w = world();
    const error = (payout: number) => ({ ...typeError(payout, 41), version: "v3.1.0" });
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v3.0.9" }, 0);
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "staging", version: "v3.1.0" }, 120);
    await w.alert("payouts-api", "staging", 121, error(11));
    await w.change({ changeType: "deploy", service: "payouts-api", environment: "production", version: "v3.1.0", previousVersion: "v3.0.9" }, 128);
    await w.change({ changeType: "feature_flag", service: "payouts-api", environment: "prod", flag: "instant-payouts", from: false, to: true }, 149.7);
    const incident = await w.incident((await w.alert("payouts-api", "production", 150, error(9921))).opened![0]!.id);
    const candidates = (await w.diagnose(incident)).changeCandidates;
    const lead = candidates[0]!;
    expect(lead.title).toBe("Deployed payouts-api v3.1.0 to production");
    expect(lead.reason).toContain("The same TypeError appeared in staging on v3.1.0 before it reached production.");
    expect(lead.reason).not.toContain("already happening");
    expect(candidates.find((candidate) => candidate.title.startsWith("Feature flag"))!.reason).toContain("was already seen in staging before this change");
  });

  it("15. a failed deploy job (failed deployment + failed workflow run, same commit) is one incident", async () => {
    const w = world();
    const deploy = await w.github.deploy("acme/ledger", "production", "e5", "failure", 20);
    const run = await w.github.ci("acme/ledger", "main", "e5", "failure", 20.05);
    expect(run.opened).toEqual([]);
    expect(run.incidentIds).toEqual([deploy.opened![0]!.id]);
  });

  it("16. in a repository shared by a path-scoped service and a whole-repo app, releases and failures land on the service whose code changed", async () => {
    const w = world();
    await w.github.push("acme/shop", "main", "a0", "s1", [["s1", "Add drill release", [".github/workflows/drill.yml", "drill/payouts-api/release.txt"]]], 1);
    await w.github.deploy("acme/shop", "production", "s1", "success", 1.1);
    expect((await w.repository.listChanges(ADMIN, { environment: "production" })).filter((item) => item.sha === "s1").map((item) => item.service)).toEqual(["drill-payouts"]);

    await w.github.push("acme/shop", "main", "s1", "s2", [["s2", "Payouts v2", ["drill/payouts-api/release.txt"]]], 2);
    const failed = await w.github.deploy("acme/shop", "production", "s2", "failure", 2.1);
    const opened = await w.incident(failed.opened![0]!.id);
    expect(opened.service).toBe("drill-payouts");
    const run = await w.github.ci("acme/shop", "main", "s2", "failure", 2.15);
    expect(run.opened).toEqual([]);
    expect(run.incidentIds).toEqual([opened.id]);

    await w.github.push("acme/shop", "main", "s2", "s3", [["s3", "Restyle checkout", ["apps/web/checkout.tsx", "README.md"]]], 3);
    await w.github.deploy("acme/shop", "production", "s3", "success", 3.1);
    // s2 never reached production, so the s3 release also ships s2's payouts change, and recovers its failure.
    const servicesFor = async (sha: string) => (await w.repository.listChanges(ADMIN, { environment: "production" })).filter((item) => item.sha === sha).map((item) => item.service).sort();
    expect(await servicesFor("s3")).toEqual(["drill-payouts", "shop"]);
    expect((await w.incident(opened.id)).events.some((event) => event.metadata?.sha === "s3" && event.service === "drill-payouts")).toBe(true);
    await w.github.push("acme/shop", "main", "s3", "s4", [["s4", "Fix checkout copy", ["apps/web/checkout.tsx"]]], 4);
    const shopOnly = await w.github.deploy("acme/shop", "production", "s4", "success", 4.1);
    expect(await servicesFor("s4")).toEqual(["shop"]);
    // Another service's good deploy is not evidence for the payouts incident.
    expect(shopOnly.incidentIds).not.toContain(opened.id);
  });

  it("17. a release passes its health check, then fails on real traffic: the stack trace points at the file it changed", async () => {
    const w = world();
    const v6 = "6e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f", v5 = "5d0e9b1a8c7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d";
    await w.github.push("acme/shop", "main", "a0", v5, [[v5, "payouts: batch settlement", ["drill/payouts-api/batch.ts"]]], 0);
    await w.github.deploy("acme/shop", "production", v5, "success", 0.1);
    await w.github.push("acme/shop", "main", v5, v6, [[v6, "payouts: validate IBAN before sending", ["drill/payouts-api/iban.ts", "drill/payouts-api/send.ts"]]], 30);
    await w.github.deploy("acme/shop", "production", v6, "success", 30.1);
    // Ten minutes before the errors, someone turns on a flag: the obvious but wrong suspect.
    await w.change({ changeType: "feature_flag", service: "drill-payouts", environment: "production", flag: "instant-payouts", from: false, to: true }, 30.5);
    const crash = (payout: number) => ({ release: v6.slice(0, 7), error: { type: "TypeError", message: `Cannot read properties of undefined (reading 'iban') for payout ${payout}`, stack: `TypeError: Cannot read properties of undefined (reading 'iban')\n    at validateIban (/app/drill/payouts-api/iban.ts:12:31)\n    at sendPayout (/app/drill/payouts-api/send.ts:40:5)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)` } });
    const first = await w.alert("drill-payouts", "production", 30.66, crash(1001));
    await w.alert("drill-payouts", "production", 30.68, crash(1002));
    const diagnosis = await w.diagnose(await w.incident(first.opened![0]!.id));
    const lead = diagnosis.changeCandidates[0]!;
    expect(lead.title).toBe(`Deployed drill-payouts ${v6.slice(0, 7)} to production`);
    expect(lead.reason).toContain(`The failing stack frame drill/payouts-api/iban.ts:12 is in a file it changed (${v6.slice(0, 7)} “payouts: validate IBAN before sending”).`);
    expect(lead.reason).toContain(`Every failing event reports version ${v6.slice(0, 7)}.`);
    const flag = diagnosis.changeCandidates.find((candidate) => candidate.title.startsWith("Feature flag"))!;
    expect(lead.score - flag.score).toBeGreaterThanOrEqual(10);
    expect(flag.reason).toContain(`The failing code (iban.ts) was changed by “Deployed drill-payouts ${v6.slice(0, 7)} to production”, not by this change.`);
    // Error occurrences are symptoms, not candidate causes.
    expect(diagnosis.changeCandidates.every((candidate) => candidate.kind === "deploy")).toBe(true);
  });

  it("12. with no change recorded, the diagnosis says to look at dependencies, traffic or data", async () => {
    const w = world();
    const incident = await w.incident((await w.alert("ledger-api", "production", 5)).opened![0]!.id);
    expect((await w.diagnose(incident)).evidenceGaps.join(" ")).toContain("look at dependencies, traffic, or data");
  });
});
