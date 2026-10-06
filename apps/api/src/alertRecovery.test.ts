import { describe, expect, it } from "vitest";
import { evaluateAlertRecovery } from "./deliveryRecovery.js";
import { normalizePayload } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";
import type { Incident } from "./types.js";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const MINUTE = 60_000;
const t0 = Date.parse("2026-10-06T16:00:00Z");
const at = (minutes: number) => new Date(t0 + minutes * MINUTE).toISOString();
const grafana = (status: "firing" | "resolved", minutes: number, fingerprint = "p95") => ({ status, alerts: [{
  status, fingerprint, startsAt: status === "firing" ? at(minutes) : at(0), endsAt: status === "resolved" ? at(minutes) : "0001-01-01T00:00:00Z",
  labels: { alertname: "PayoutsLatencyHigh", service: "payouts", environment: "production" },
  annotations: { summary: status === "firing" ? "payouts p95 4.2s" : "payouts p95 back to 310ms" }
}] });

async function incidentFrom(payloads: Array<Record<string, unknown>>) {
  const repository = new MemoryRepository();
  const target = { id: "int-generic", organizationId: "demo-organization", name: "Grafana", provider: "generic" as const, status: "active" as const };
  let id = "";
  for (const [index, payload] of payloads.entries()) {
    const result = await repository.ingest(target, { externalId: `d${index}`, signals: normalizePayload("generic", payload, `d${index}`) });
    id ||= result.incidentIds[0] ?? "";
  }
  return (await repository.getIncident(ADMIN, id)) as Incident;
}

describe("recovery from Grafana alerts", () => {
  it("waits while the alert is firing", async () => {
    const result = evaluateAlertRecovery(await incidentFrom([grafana("firing", 0)]), new Date(at(10)));
    expect(result).toMatchObject({ state: "insufficient", reason: expect.stringContaining("Waiting for Grafana to report “payouts p95 4.2s” resolved") });
  });

  it("confirms only after the resolved alert stays quiet for 5 minutes", async () => {
    const incident = await incidentFrom([grafana("firing", 0), grafana("resolved", 12)]);
    expect(evaluateAlertRecovery(incident, new Date(at(14)))).toMatchObject({ state: "insufficient", reason: expect.stringContaining("Confirmed automatically if it stays quiet until 16:17 UTC") });
    expect(evaluateAlertRecovery(incident, new Date(at(18)))).toMatchObject({ state: "verified", reason: "Grafana reported “payouts p95 back to 310ms” at 16:12 UTC, and nothing has fired or errored since." });
  });

  it("is cancelled by new errors after the resolve, or by the alert firing again", async () => {
    const error = { kind: "metric", service: "payouts", environment: "production", title: "Payout timed out", impactScore: 50, timestamp: at(14), eventId: "e1", error: { type: "TimeoutError", message: "timeout exceeded" } };
    expect(evaluateAlertRecovery(await incidentFrom([grafana("firing", 0), grafana("resolved", 12), error]), new Date(at(30)))).toMatchObject({ state: "failed", reason: expect.stringContaining("1 new error arrived after that") });
    expect(evaluateAlertRecovery(await incidentFrom([grafana("firing", 0), grafana("resolved", 12), grafana("firing", 20)]), new Date(at(30)))?.state).toBe("insufficient");
  });

  it("needs every alert in the incident to resolve", async () => {
    const incident = await incidentFrom([grafana("firing", 0), grafana("firing", 1, "error-rate"), grafana("resolved", 12)]);
    expect(evaluateAlertRecovery(incident, new Date(at(30)))?.state).toBe("insufficient");
  });

  it("does not apply to incidents without monitoring alerts", async () => {
    const incident = await incidentFrom([{ kind: "alert", service: "payouts", environment: "production", title: "5xx", impactScore: 90, timestamp: at(0), eventId: "a1" }]);
    expect(evaluateAlertRecovery(incident, new Date(at(30)))).toBeNull();
  });
});
