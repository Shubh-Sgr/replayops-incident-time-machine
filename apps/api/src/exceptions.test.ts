import { describe, expect, it } from "vitest";
import { diagnoseIncident } from "./diagnosis.js";
import { fingerprintException, groupIncidentErrors, normalizeMessage, topFrameOf } from "./exceptions.js";
import { normalizePayload } from "./ingestion.js";
import type { Incident, IncidentEvent } from "./types.js";

const nodeStack = (line: number) => `TypeError: Cannot read properties of undefined (reading 'total')
    at computeTotal (/app/src/cart/pricing.ts:${line}:17)
    at Router.handle (/app/node_modules/express/lib/router/index.js:284:9)`;

describe("exception fingerprints", () => {
  it("normalizes the parts of a message that change per occurrence", () => {
    expect(normalizeMessage("User 4821 (ana@x.io) order 7f3e2a10-1b2c-4d5e-8f90-123456789abc failed after 3.5s at 10.0.0.12"))
      .toBe("User <n> (<email>) order <uuid> failed after <n>s at <ip>");
    expect(normalizeMessage('Key "cart:991" not found')).toBe("Key <str> not found");
  });

  it("finds the first application frame and drops line numbers", () => {
    expect(topFrameOf(nodeStack(42))).toBe("computeTotal (/app/src/cart/pricing.ts");
    expect(topFrameOf('Traceback (most recent call last):\n  File "/usr/lib/python3.12/site-packages/flask/app.py", line 880, in full_dispatch\n  File "/srv/app/orders.py", line 51, in create_order\nKeyError: \'sku\'')).toBe('File "/srv/app/orders.py", in create_order');
  });

  it("groups the same bug across redeploys and different ids, and splits different bugs", () => {
    const a = fingerprintException("cart-api", "TypeError", "Cannot read 'total' for cart 91", nodeStack(42));
    const b = fingerprintException("cart-api", "TypeError", "Cannot read 'total' for cart 17", nodeStack(57));
    const other = fingerprintException("cart-api", "TypeError", "Cannot read 'total'", nodeStack(42).replace("computeTotal", "applyCoupon"));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(other.fingerprint);
    expect(fingerprintException("cart-api", "Error", "Timeout after 30s").fingerprint).toBe(fingerprintException("cart-api", "Error", "Timeout after 45s").fingerprint);
  });
});

describe("exception extraction at ingestion", () => {
  it("reads OpenTelemetry span exception events and log attributes", () => {
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const [span] = normalizePayload("otel", { resourceSpans: [{ resource: { attributes: [attr("service.name", "cart-api")] }, scopeSpans: [{ spans: [{
      traceId: "t1", spanId: "s1", name: "POST /cart", startTimeUnixNano: "1760000000000000000", endTimeUnixNano: "1760000000100000000", status: { code: 2 },
      events: [{ name: "exception", attributes: [attr("exception.type", "TypeError"), attr("exception.message", "boom 12"), attr("exception.stacktrace", nodeStack(42))] }]
    }] }] }] }, "d1");
    expect(span!.metadata.exception).toMatchObject({ type: "TypeError", topFrame: "computeTotal (/app/src/cart/pricing.ts" });
    const [log] = normalizePayload("otel", { resourceLogs: [{ resource: { attributes: [attr("service.name", "cart-api")] }, scopeLogs: [{ logRecords: [{
      timeUnixNano: "1760000000000000000", severityNumber: 17, body: { stringValue: "unhandled" }, attributes: [attr("exception.type", "TypeError"), attr("exception.message", "boom 99"), attr("exception.stacktrace", nodeStack(57))]
    }] }] }] }, "d2");
    expect((log!.metadata.exception as { fingerprint: string }).fingerprint).toBe((span!.metadata.exception as { fingerprint: string }).fingerprint);
  });

  it("reads generic error objects and titles the event after the exception", () => {
    const [event] = normalizePayload("generic", { kind: "alert", service: "orders", error: { name: "KeyError", message: "'sku'", stack: "File \"/srv/app/orders.py\", line 51, in create_order" } }, "d3");
    expect(event!.title).toBe("KeyError: 'sku'");
    expect(event!.metadata.exception).toMatchObject({ type: "KeyError", topFrame: 'File "/srv/app/orders.py", in create_order' });
  });
});

const event = (id: string, timestamp: string, kind: IncidentEvent["kind"], title: string, exception?: ReturnType<typeof fingerprintException>): IncidentEvent => ({
  id, incidentId: "inc", timestamp, service: "cart-api", kind, title, detail: title, impactScore: kind === "alert" ? 82 : 40, metadata: { provider: "generic", ...(exception ? { exception } : {}) }
});

describe("error groups", () => {
  const fresh = fingerprintException("cart-api", "TypeError", "Cannot read 'total'", nodeStack(42));
  const chronic = fingerprintException("cart-api", "TimeoutError", "Upstream timed out");
  const incident: Incident = {
    id: "inc", code: "AUTO-1", title: "Cart errors", summary: "Cart is failing", service: "cart-api", environment: "production", severity: "high", status: "investigating", owner: "Automation",
    startedAt: "2026-10-05T10:05:00Z", createdAt: "2026-10-05T10:05:00Z", updatedAt: "2026-10-05T10:05:00Z",
    events: [
      event("e0", "2026-10-05T09:55:00Z", "metric", "Timeout", chronic),
      event("d1", "2026-10-05T10:00:00Z", "deploy", "Deployed cart-api v2.3.0"),
      event("e1", "2026-10-05T10:02:00Z", "alert", "TypeError", fresh),
      event("e2", "2026-10-05T10:03:00Z", "alert", "TypeError", fresh),
      event("e3", "2026-10-05T10:04:00Z", "metric", "Timeout", chronic)
    ]
  };

  it("counts occurrences and flags errors that are new since a change", () => {
    const groups = groupIncidentErrors(incident, new Map([[chronic.fingerprint, "2026-09-30T08:00:00.000Z"]]));
    expect(groups[0]).toMatchObject({ type: "TypeError", count: 2, newSince: { eventId: "d1", title: "Deployed cart-api v2.3.0" } });
    expect(groups[1]).toMatchObject({ type: "TimeoutError", count: 2, newSince: null, firstSeenInWorkspace: "2026-09-30T08:00:00.000Z" });
  });

  it("ranks a change higher when a brand-new error type follows it", () => {
    const candidate = diagnoseIncident(incident).changeCandidates.find((item) => item.eventId === "d1")!;
    expect(candidate.reason).toContain("1 error type (TypeError) first appeared after it.");
    const withoutErrors = diagnoseIncident({ ...incident, events: incident.events.map((item) => ({ ...item, metadata: { provider: "generic" } })) }).changeCandidates.find((item) => item.eventId === "d1")!;
    expect(candidate.score).toBeGreaterThan(withoutErrors.score);
  });
});
