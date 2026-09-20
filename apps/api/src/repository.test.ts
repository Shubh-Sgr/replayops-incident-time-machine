import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./repository.js";

describe("MemoryRepository", () => {
  const userId = "demo-operator";

  it("finds incident evidence and keeps results ranked", async () => {
    const repository = new MemoryRepository();
    const results = await repository.search(userId, "inventory retry payment");

    expect(results[0]?.incident.code).toBe("ROP-1842");
    expect(results[0]?.score).toBeGreaterThan(0.5);
  });

  it("supports the incident and timeline lifecycle", async () => {
    const repository = new MemoryRepository();
    const incident = await repository.createIncident(userId, {
      title: "Webhook delivery saturation",
      summary: "A downstream timeout caused the webhook queue to exceed its safe delivery rate.",
      service: "webhook-worker",
      severity: "high",
      status: "investigating",
      owner: "Test Operator",
      startedAt: "2026-09-20T08:00:00.000Z",
      resolvedAt: null
    });
    const event = await repository.createEvent(userId, incident.id, {
      timestamp: "2026-09-20T08:01:00.000Z",
      service: "webhook-worker",
      kind: "alert",
      title: "Queue depth exceeded",
      detail: "Pending deliveries crossed the configured alert threshold.",
      impactScore: 72,
      metadata: {}
    });

    expect((await repository.getIncident(userId, incident.id))?.events).toHaveLength(1);
    expect(event?.incidentId).toBe(incident.id);
    expect(await repository.deleteIncident(userId, incident.id)).toBe(true);
    expect(await repository.getIncident(userId, incident.id)).toBeNull();
  });
});
