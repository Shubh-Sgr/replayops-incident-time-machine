/**
 * Incident grouping in real-world shapes: long outages, cascades, relapses, forgotten incidents, and
 * problems that come back days after everyone thought they were fixed. Each case drives the real intake
 * path (normalization, placement, grouping) and asserts what an on-call engineer should see.
 */
import { describe, expect, it } from "vitest";
import { extractDelivery } from "./changes.js";
import { chooseIncident, joinOutcome, type GroupingCandidate } from "./grouping.js";
import { normalizePayload } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";
import type { Incident, IntegrationProvider } from "./types.js";

const HOUR = 3_600_000;
const base = Date.now() - 10 * 24 * HOUR;
const at = (hours: number) => new Date(base + hours * HOUR).toISOString();
let sequence = 0;

function world() {
  const repository = new MemoryRepository();
  const target = (provider: IntegrationProvider) => ({ id: `int-${provider}`, organizationId: "demo-organization", name: provider, provider, status: "active" as const });
  const send = async (provider: IntegrationProvider, payload: Record<string, unknown>, eventName = "") => {
    const externalId = `grouping-${++sequence}`;
    return repository.ingest(target(provider), { externalId, signals: normalizePayload(provider, payload, externalId, eventName), delivery: extractDelivery(provider, payload, eventName, externalId) });
  };
  // checkout-api depends on inventory-api, which depends on catalog-db (the demo service catalog).
  const alert = (service: string, hours: number, extra: Record<string, unknown> = {}) => send("generic", { kind: "alert", service, environment: "production", title: `${service} errors above SLO`, detail: "Error rate 9%", impactScore: 86, timestamp: at(hours), eventId: `alert-${++sequence}`, ...extra });
  const recovery = (service: string, hours: number, extra: Record<string, unknown> = {}) => send("generic", { kind: "recovery", service, environment: "production", title: `${service} healthy`, detail: "Error rate back to baseline", timestamp: at(hours), eventId: `recovery-${++sequence}`, ...extra });
  const grafana = (status: "firing" | "resolved", labels: Record<string, string>, hours: number, fingerprint?: string) => send("generic", {
    alerts: [{ status, labels: { environment: "production", ...labels }, annotations: { summary: `${labels.alertname} on ${labels.service}` }, startsAt: at(hours), endsAt: status === "resolved" ? at(hours) : "0001-01-01T00:00:00Z", ...(fingerprint ? { fingerprint } : {}) }]
  });
  const ci = (sha: string, conclusion: "success" | "failure", hours: number) => send("github", {
    action: "completed", repository: { full_name: "acme/ledger" }, sender: { login: "asha" },
    workflow_run: { id: ++sequence, name: "CI", status: "completed", conclusion, head_sha: sha, head_branch: "main", updated_at: at(hours) }
  }, "workflow_run");
  const incident = async (id: string) => (await repository.getIncident("demo", id)) as Incident;
  return { repository, alert, recovery, grafana, ci, incident };
}

const typeError = { error: { type: "TypeError", message: "Cannot read properties of undefined (reading 'iban')", stack: "TypeError: x\n    at buildPayout (/app/services/payouts/build.ts:41:11)" } };

describe("incident grouping in the real world", () => {
  it("a four-hour outage stays one incident: the window follows the latest evidence, not the start", async () => {
    const w = world();
    const first = await w.alert("checkout-api", 0);
    const id = first.opened![0]!.id;
    for (const hours of [1.5, 3, 4.5]) {
      const next = await w.alert("checkout-api", hours, { title: `Checkout failures at +${hours}h` });
      expect(next.opened).toEqual([]);
      expect(next.incidentIds).toEqual([id]);
    }
  });

  it("a problem after the incident has gone quiet for longer than the window is a new incident", async () => {
    const w = world();
    const first = await w.alert("checkout-api", 0);
    const later = await w.alert("checkout-api", 3, { title: "Checkout latency above SLO" });
    expect(later.opened).toHaveLength(1);
    expect(later.incidentIds).not.toContain(first.opened![0]!.id);
  });

  it("a cascade is one incident whichever symptom fires first: database → inventory → checkout", async () => {
    const symptomsFirst = world();
    const checkout = await symptomsFirst.alert("checkout-api", 0);
    const id = checkout.opened![0]!.id;
    expect((await symptomsFirst.alert("inventory-api", 0.05)).incidentIds).toEqual([id]);
    // catalog-db is two hops from checkout-api, but one from inventory-api, already in the incident.
    const root = await symptomsFirst.alert("catalog-db", 0.1);
    expect(root.opened).toEqual([]);
    expect(root.incidentIds).toEqual([id]);

    const rootFirst = world();
    const db = await rootFirst.alert("catalog-db", 0);
    const rootId = db.opened![0]!.id;
    expect((await rootFirst.alert("inventory-api", 0.05)).incidentIds).toEqual([rootId]);
    expect((await rootFirst.alert("checkout-api", 0.1)).incidentIds).toEqual([rootId]);
  });

  it("a dependency recovering does not mark the incident recovered; its own service recovering does", async () => {
    const w = world();
    const id = (await w.alert("checkout-api", 0)).opened![0]!.id;
    await w.alert("inventory-api", 0.05);
    const neighbour = await w.recovery("inventory-api", 0.3);
    expect(neighbour.incidentIds).toEqual([id]);
    expect(neighbour.movedToMonitoring).toEqual([]);
    expect((await w.incident(id)).status).toBe("investigating");
    const own = await w.recovery("checkout-api", 0.5);
    expect(own.movedToMonitoring?.map((item) => item.id)).toEqual([id]);
  });

  it("an alert that fires again soon after resolving reopens the same incident and pages", async () => {
    const w = world();
    const labels = { alertname: "HighErrorRate", service: "payments-api" };
    const id = (await w.grafana("firing", labels, 0, "fp-payments")).opened![0]!.id;
    expect((await w.grafana("resolved", labels, 0.2, "fp-payments")).movedToMonitoring?.map((item) => item.id)).toEqual([id]);
    const relapse = await w.grafana("firing", labels, 0.4, "fp-payments");
    expect(relapse.opened).toEqual([]);
    expect(relapse.incidentIds).toEqual([id]);
    expect(relapse.reopened).toEqual([expect.objectContaining({ id, status: "investigating", reason: expect.stringContaining("came back") })]);
    expect((await w.incident(id)).status).toBe("investigating");
  });

  it("an alert that fires again days after it resolved opens a new incident instead of joining the settled one", async () => {
    const w = world();
    const labels = { alertname: "HighErrorRate", service: "payments-api" };
    const id = (await w.grafana("firing", labels, 0, "fp-payments")).opened![0]!.id;
    await w.grafana("resolved", labels, 0.2, "fp-payments");
    const daysLater = await w.grafana("firing", labels, 72, "fp-payments");
    expect(daysLater.opened).toHaveLength(1);
    expect(daysLater.incidentIds).not.toContain(id);
    expect((await w.incident(id)).status).toBe("monitoring");
    // Its resolution goes to the new incident, not the settled one.
    expect((await w.grafana("resolved", labels, 72.5, "fp-payments")).incidentIds).toEqual([daysLater.opened![0]!.id]);
  });

  it("CI on main: a failure right after the fix joins the incident; a failure days after it passed is a new one", async () => {
    const w = world();
    const id = (await w.ci("c1", "failure", 0)).opened![0]!.id;
    expect((await w.ci("c2", "success", 1)).incidentIds).toEqual([id]);
    const flaky = await w.ci("c3", "failure", 1.5);
    expect(flaky.incidentIds).toEqual([id]);
    expect(flaky.opened).toEqual([]);
    await w.ci("c4", "success", 2);
    // Nobody resolved the incident, but the source confirmed recovery and it went quiet: c9 is a new break.
    const newBreak = await w.ci("c9", "failure", 74);
    expect(newBreak.opened).toHaveLength(1);
    expect(newBreak.incidentIds).not.toContain(id);
  });

  it("a forgotten incident still takes its own recurring error, but pages again instead of swallowing it", async () => {
    const w = world();
    const id = (await w.alert("payouts-api", 0, typeError)).opened![0]!.id;
    const recurring = await w.alert("payouts-api", 50, typeError);
    expect(recurring.opened).toEqual([]);
    expect(recurring.incidentIds).toEqual([id]);
    expect(recurring.reopened).toEqual([expect.objectContaining({ id, reason: expect.stringContaining("2 days") })]);
    // Within the window of that evidence, more of the same is just more evidence.
    expect((await w.alert("payouts-api", 50.5, typeError)).reopened).toEqual([]);
  });

  it("Grafana alerts without a fingerprint are told apart by their labels", async () => {
    const w = world();
    const disk = await w.grafana("firing", { alertname: "DiskFull", service: "billing-db" }, 0);
    const search = await w.grafana("firing", { alertname: "IndexLag", service: "search-indexer" }, 0.1);
    expect(search.opened).toHaveLength(1);
    expect(search.incidentIds).not.toContain(disk.opened![0]!.id);
    const resolved = await w.grafana("resolved", { alertname: "DiskFull", service: "billing-db" }, 0.5);
    expect(resolved.incidentIds).toEqual([disk.opened![0]!.id]);
  });

  it("a staging signal never joins or backfills a production incident, even with the same group key", async () => {
    const w = world();
    await w.alert("checkout-api", 0, { environment: "staging", title: "Staging checkout errors" });
    const production = await w.alert("checkout-api", 0.1, { groupKey: "checkout-5xx" });
    const id = production.opened![0]!.id;
    expect((await w.incident(id)).events.map((event) => event.metadata?.environment)).toEqual(["production"]);
    const staging = await w.alert("checkout-api", 0.2, { environment: "staging", groupKey: "checkout-5xx" });
    expect(staging.incidentIds).not.toContain(id);
  });

  it("evidence a responder excluded from an incident no longer pulls new signals into it", async () => {
    const w = world();
    const id = (await w.alert("payouts-api", 0, { groupKey: "nightly-sync" })).opened![0]!.id;
    const [event] = (await w.incident(id)).events;
    // The responder decides the group key was wrongly shared: that evidence isn't this incident's.
    await w.repository.updateEvent("demo", id, event!.id, { evidenceState: "excluded" });
    const unrelated = await w.alert("search-indexer", 0.2, { groupKey: "nightly-sync" });
    expect(unrelated.incidentIds).not.toContain(id);
  });
});

describe("grouping rules", () => {
  const candidate = (overrides: Partial<GroupingCandidate>): GroupingCandidate => ({
    id: "i1", status: "investigating", service: "checkout-api", environment: "production", startedAt: at(0), lastSignalAt: at(0), recovered: false,
    services: ["checkout-api"], branchCompatible: true, byLane: false, byCorrelation: false, byCommit: false, byFingerprint: false, ...overrides
  });
  const context = { relatedServices: ["checkout-api"], windowMinutes: 120, laneOnly: false, problem: true };
  const signal = { timestamp: at(1), environment: "production" };

  it("prefers an identity match over a time match, then the most recently active incident", () => {
    const byTime = candidate({ id: "time", lastSignalAt: at(0.9) });
    const byKey = candidate({ id: "key", byCorrelation: true, lastSignalAt: at(0.1) });
    expect(chooseIncident([byTime, byKey], signal, context)).toMatchObject({ candidate: { id: "key" }, reason: "correlation" });
    const older = candidate({ id: "older", lastSignalAt: at(0.2) });
    expect(chooseIncident([older, byTime], signal, context)?.candidate.id).toBe("time");
  });

  it("a successful deploy only ever joins its own lane", () => {
    expect(chooseIncident([candidate({})], signal, { ...context, laneOnly: true, problem: false })).toBeUndefined();
    expect(chooseIncident([candidate({ byLane: true, environment: "staging" })], signal, { ...context, laneOnly: true, problem: false })?.reason).toBe("lane");
  });

  it("recovery and non-paging evidence may still reach a settled incident by identity", () => {
    const settled = candidate({ status: "monitoring", byCorrelation: true, lastSignalAt: at(-48) });
    expect(chooseIncident([settled], signal, context)).toBeUndefined();
    expect(chooseIncident([settled], signal, { ...context, problem: false })?.reason).toBe("correlation");
    expect(joinOutcome(settled, "correlation", { ...signal, service: "checkout-api", kind: "metric" }, { ...context, problem: false })).toEqual({ monitoring: false, reopen: false });
  });
});
