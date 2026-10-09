import { describe, expect, it } from "vitest";
import { diagnoseIncident } from "./diagnosis.js";
import { MemoryRepository, simulateReplay } from "./repository.js";
import { seedIncidents } from "./seed.js";

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

  it("records response decisions and deterministic replay outcomes", async () => {
    const repository = new MemoryRepository();
    const incident = (await repository.listIncidents(userId))[0]!;
    const decision = await repository.createDecision(userId, incident.id, {
      kind: "mitigation",
      status: "approved",
      title: "Reduce checkout retry ceiling",
      detail: "Limit retries to one attempt while the inventory replica catches up."
    });
    const replay = await repository.runReplay(userId, incident.id, {
      retryCeiling: 1,
      concurrencyCap: 18,
      timeoutMs: 1800
    });

    expect(decision?.status).toBe("approved");
    expect(await repository.listDecisions(userId, incident.id)).toHaveLength(1);
    expect(replay?.projection.projectedPeak).toBeLessThan(replay?.projection.baselinePeak ?? 0);
    expect(replay?.progress).toBe(100);
    expect((await repository.listReplays(userId, incident.id))[0]?.config).toEqual({ retryCeiling: 1, concurrencyCap: 18, timeoutMs: 1800 });
    expect(replay?.evidenceVersion).toBe(incident.updatedAt);
  });

  it("makes the replay model reproducible for identical inputs", () => {
    const config = { retryCeiling: 1, concurrencyCap: 18, timeoutMs: 1800 };
    expect(simulateReplay(seedIncidents[0]!, config)).toEqual(simulateReplay(seedIncidents[0]!, config));
  });

  it("ranks falsifiable incident hypotheses and exposes evidence gaps", () => {
    const diagnosis = diagnoseIncident(seedIncidents[0]!);

    expect(diagnosis.originService).toBe("inventory-api");
    expect(diagnosis.servicePath).toEqual(["inventory-api", "checkout-api", "payments-api"]);
    expect(diagnosis.hypotheses[0]?.nextTest).toContain("trace or request IDs");
    expect(diagnosis.hypotheses[0]?.conflictingEvidence.length).toBeGreaterThan(0);
    expect(diagnosis.evidenceGaps).toContain("No trace, span, or request ID is attached; cross-service causality cannot be verified.");
    expect(diagnosis.signalDeltas.length).toBeGreaterThan(0);
    expect(diagnosis.evidenceCompleteness).toBeGreaterThan(diagnosis.causalConfidence);
    expect(diagnosis.scoreExplanation).toContain("No trace-backed request relationship is present.");
  });

  it("refuses to invent a diagnosis without evidence", () => {
    const diagnosis = diagnoseIncident({ ...seedIncidents[0]!, events: [] });

    expect(diagnosis.hypotheses).toEqual([]);
    expect(diagnosis.confidence).toBe(12);
    expect(diagnosis.evidenceGaps[0]).toContain("No timestamped evidence");
  });

  it("demotes a disproved leading explanation and marks contradictory outcomes as contested", () => {
    const first=diagnoseIncident(seedIncidents[0]!);
    const hypothesis=first.hypotheses[0]!;
    const diagnosis=diagnoseIncident(seedIncidents[0]!,[
      {id:"test-1",incidentId:seedIncidents[0]!.id,hypothesisId:hypothesis.id,title:"Trace comparison",instruction:hypothesis.nextTest,assignee:"operator",status:"supported",result:"Failing traces diverged at inventory.",createdAt:"2026-09-25T00:00:00Z",updatedAt:"2026-09-25T00:01:00Z"},
      {id:"test-2",incidentId:seedIncidents[0]!.id,hypothesisId:hypothesis.id,title:"Healthy cohort",instruction:hypothesis.nextTest,assignee:"operator",status:"disproved",result:"Healthy traces showed the same inventory latency.",createdAt:"2026-09-25T00:02:00Z",updatedAt:"2026-09-25T00:03:00Z"}
    ]);
    const updated=diagnosis.hypotheses.find((item)=>item.id===hypothesis.id);
    expect(updated?.state).toBe("contested");
    expect(updated?.testCount).toBe(2);
    expect(diagnosis.nextAction.label).toContain("Sort out the checks that disagree");
  });

  it("moves incorrectly grouped evidence without losing provenance", async () => {
    const repository = new MemoryRepository();
    const [source, target] = await repository.listIncidents(userId);
    const event = source!.events[0]!;
    const moved = await repository.moveEvent(userId, source!.id, event.id, target!.id);
    expect(moved?.incidentId).toBe(target!.id);
    expect(moved?.metadata).toEqual(event.metadata);
    expect((await repository.getIncident(userId, source!.id))?.events.some((item) => item.id === event.id)).toBe(false);
    expect((await repository.getIncident(userId, target!.id))?.events.some((item) => item.id === event.id)).toBe(true);
  });
});
