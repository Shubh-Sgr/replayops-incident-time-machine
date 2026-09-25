import { describe, expect, it } from "vitest";
import { summarizeIngestionBatch } from "./queue.js";

describe("ingestion queue labels", () => {
  it("uses the event title instead of the provider UUID", () => {
    const summary = summarizeIngestionBatch({
      externalId: "93ca54cc-55e4-4cd5-a87f-5f6ab98e189f",
      signals: [{
        externalId: "signal-1",
        timestamp: "2026-09-25T10:00:00.000Z",
        service: "checkout-api",
        kind: "alert",
        title: "Checkout error rate exceeded SLO",
        detail: "Five-minute error rate reached 7.8 percent.",
        impactScore: 82,
        severity: "high",
        metadata: {}
      }]
    }, "Production telemetry");

    expect(summary).toEqual({ eventName: "Checkout error rate exceeded SLO", signalCount: 1 });
  });

  it("summarizes multi-signal deliveries and names empty deliveries by source", () => {
    const signal = {
      externalId: "signal-1",
      timestamp: "2026-09-25T10:00:00.000Z",
      service: "checkout-api",
      kind: "metric" as const,
      title: "Timeout while reserving inventory",
      detail: "The inventory dependency exceeded its deadline.",
      impactScore: 60,
      severity: "medium" as const,
      metadata: {}
    };

    expect(summarizeIngestionBatch({ externalId: "delivery-1", signals: [signal, { ...signal, externalId: "signal-2" }] }, "Production telemetry")).toEqual({ eventName: "Timeout while reserving inventory + 1 more", signalCount: 2 });
    expect(summarizeIngestionBatch({ externalId: "delivery-2", signals: [] }, "GitHub production")).toEqual({ eventName: "GitHub production delivery", signalCount: 0 });
  });
});
