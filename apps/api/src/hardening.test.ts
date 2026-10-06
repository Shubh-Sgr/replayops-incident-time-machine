import { describe, expect, it } from "vitest";
import { diagnoseIncident } from "./diagnosis.js";
import { normalizePayload } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";
import type { Incident, IncidentEvent } from "./types.js";

const target = { id: "gen", organizationId: "demo-organization", name: "Payouts service", provider: "generic" as const, status: "active" as const };
const now = () => new Date().toISOString();

describe("incident codes", () => {
  it("numbers manual incidents sequentially without collisions", async () => {
    const repository = new MemoryRepository();
    const input = { title: "Checkout slow", summary: "Checkout is slow for EU users", service: "checkout-api", severity: "high" as const, status: "investigating" as const, owner: "me", startedAt: now() };
    const codes = [await repository.createIncident("u", input), await repository.createIncident("u", input)].map((item) => item.code);
    expect(codes).toEqual(["ROP-2001", "ROP-2002"]);
  });
});

describe("severity escalation", () => {
  it("raises severity and follows the worse alert when the title is still automatic", async () => {
    const repository = new MemoryRepository();
    const first = await repository.ingest(target, { externalId: "e1", signals: normalizePayload("generic", { kind: "alert", service: "payouts-api", environment: "production", impactScore: 66, severity: "medium", title: "Payout latency rising", detail: "p95 above 2s" }, "e1") });
    const id = first.opened![0]!.id;
    const second = await repository.ingest(target, { externalId: "e2", signals: normalizePayload("generic", { kind: "alert", service: "payouts-api", environment: "production", impactScore: 95, severity: "critical", title: "Payouts failing for all banks", detail: "100% 5xx" }, "e2") });
    expect(second.incidentIds).toEqual([id]);
    expect(second.escalated).toEqual([expect.objectContaining({ id, severity: "critical", title: "Payouts failing for all banks" })]);
    const incident = (await repository.getIncident("u", id))!;
    expect(incident).toMatchObject({ severity: "critical", title: "Payouts failing for all banks" });
  });

  it("keeps a title a person wrote, and never lowers severity", async () => {
    const repository = new MemoryRepository();
    const first = await repository.ingest(target, { externalId: "e3", signals: normalizePayload("generic", { kind: "alert", service: "ledger-api", environment: "production", impactScore: 90, severity: "high", title: "Ledger errors", detail: "5xx" }, "e3") });
    const id = first.opened![0]!.id;
    await repository.updateIncident("u", id, { title: "Ledger writes failing after migration", owner: "Asha" });
    const critical = await repository.ingest(target, { externalId: "e4", signals: normalizePayload("generic", { kind: "alert", service: "ledger-api", environment: "production", impactScore: 97, severity: "critical", title: "Ledger down", detail: "all writes fail" }, "e4") });
    expect((await repository.getIncident("u", id))!).toMatchObject({ severity: "critical", title: "Ledger writes failing after migration" });
    expect(critical.escalated).toHaveLength(1);
    const lower = await repository.ingest(target, { externalId: "e5", signals: normalizePayload("generic", { kind: "alert", service: "ledger-api", environment: "production", impactScore: 70, severity: "medium", title: "Ledger warnings", detail: "retries" }, "e5") });
    expect(lower.escalated).toEqual([]);
    expect((await repository.getIncident("u", id))!.severity).toBe("critical");
  });
});

describe("healthy cohort credit", () => {
  const base = (events: IncidentEvent[]): Incident => ({ id: "i", code: "X", title: "t", summary: "s", service: "svc", severity: "high", status: "investigating", owner: "o", startedAt: "2026-10-06T10:00:00Z", createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z", events });
  const ev = (id: string, title: string, extra: Partial<IncidentEvent> = {}): IncidentEvent => ({ id, incidentId: "i", timestamp: `2026-10-06T10:0${id}:00Z`, service: "svc", kind: "alert", title, detail: title, impactScore: 80, provenance: "ingested", ...extra });
  const reasons = (incident: Incident) => diagnoseIncident(incident).scoreExplanation.join(" ");

  it("does not count a 'successful' workflow title as a healthy cohort", () => {
    expect(reasons(base([ev("1", "CI failure"), ev("2", "Deploy workflow successful", { kind: "metric", impactScore: 20 })]))).toContain("No healthy-versus-failing cohort");
  });

  it("counts sampled healthy traces and a responder's described control group", () => {
    expect(reasons(base([ev("1", "Failed span"), ev("2", "Healthy sampled span: GET /pay", { kind: "metric", metadata: { cohortRole: "healthy" } })]))).toContain("A healthy or control cohort is recorded.");
    expect(reasons(base([ev("1", "Errors"), ev("2", "EU traffic", { kind: "metric", provenance: "manual", detail: "The healthy control group of EU requests shows no errors" })]))).toContain("A healthy or control cohort is recorded.");
  });
});
