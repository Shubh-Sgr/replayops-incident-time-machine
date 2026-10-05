import { describe, expect, it } from "vitest";
import { channelWantsEvent, formatAlert, isPrivateAddress, signAlertBody, validateChannelUrl, type AlertEvent } from "./alerts.js";
import { semanticAuditForRequest } from "./auditEvents.js";
import { diagnoseIncident } from "./diagnosis.js";
import { allowIngestRequest, normalizePayload, stripCapturedBodies } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";
import type { Incident, IntegrationTarget } from "./types.js";

const event = (type: AlertEvent["type"], severity: Incident["severity"] = "high"): AlertEvent => ({
  type, incident: { id: "inc-1", code: "AUTO-1", title: "Checkout <!channel> errors & timeouts", service: "checkout-api", environment: "production", severity, status: "investigating" }, detail: "Opened automatically."
});

describe("alert destinations", () => {
  it("accepts only public https destinations of the declared kind", () => {
    expect(validateChannelUrl("slack", "https://hooks.slack.com/services/T0/B0/xyz").hostname).toBe("hooks.slack.com");
    expect(() => validateChannelUrl("slack", "https://example.com/hook")).toThrow(/hooks.slack.com/);
    expect(() => validateChannelUrl("discord", "https://discord.com/channels/1")).toThrow(/api\/webhooks/);
    expect(() => validateChannelUrl("webhook", "http://example.com/hook")).toThrow(/https/);
    expect(() => validateChannelUrl("webhook", "https://127.0.0.1/hook")).toThrow(/public/);
    expect(() => validateChannelUrl("webhook", "https://metadata.internal/hook")).toThrow(/public/);
    expect(() => validateChannelUrl("webhook", "https://[::1]/hook")).toThrow(/public/);
    expect(validateChannelUrl("webhook", "https://ops.example.com/replayops").pathname).toBe("/replayops");
  });

  it("recognizes private and link-local addresses", () => {
    for (const address of ["10.0.0.1", "172.20.1.1", "192.168.1.1", "169.254.169.254", "127.0.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(address)).toBe(true);
    for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(address)).toBe(false);
  });

  it("escapes untrusted incident text so it cannot ping a channel", () => {
    const slack = formatAlert("slack", event("opened")) as { text: string };
    expect(slack.text).toContain("Checkout &lt;!channel&gt; errors &amp; timeouts");
    expect(slack.text).toContain("/incidents/inc-1|AUTO-1");
    const discord = formatAlert("discord", event("resolved")) as { content: string; allowed_mentions: { parse: string[] } };
    expect(discord.allowed_mentions.parse).toEqual([]);
    expect(discord.content).toContain("Incident resolved");
    const webhook = formatAlert("webhook", event("monitoring"), "2026-10-05T10:00:00.000Z") as { event: string; incident: { url: string } };
    expect(webhook.event).toBe("incident.monitoring");
    expect(webhook.incident.url).toMatch(/\/incidents\/inc-1$/);
  });

  it("signs webhook bodies deterministically per destination", () => {
    expect(signAlertBody("a", "{}")).toBe(signAlertBody("a", "{}"));
    expect(signAlertBody("a", "{}")).not.toBe(signAlertBody("b", "{}"));
    expect(signAlertBody("a", "{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("filters by event type and minimum severity", () => {
    const channel = { enabled: true, events: ["opened" as const], minSeverity: "high" as const };
    expect(channelWantsEvent(channel, event("opened", "critical"))).toBe(true);
    expect(channelWantsEvent(channel, event("opened", "medium"))).toBe(false);
    expect(channelWantsEvent(channel, event("resolved", "critical"))).toBe(false);
    expect(channelWantsEvent({ ...channel, enabled: false }, event("opened", "critical"))).toBe(false);
  });
});

describe("change events", () => {
  it("normalizes deploys, flag flips, and config edits from any tool as change suspects", () => {
    const [deploy, flag, config] = normalizePayload("generic", { events: [
      { kind: "change", changeType: "deploy", service: "checkout-api", version: "v1.4.2", previousVersion: "v1.4.1", sha: "abc1234", timestamp: "2026-10-05T10:00:00Z" },
      { kind: "feature_flag", service: "checkout-api", flag: "new-checkout", from: false, to: true, timestamp: "2026-10-05T10:01:00Z" },
      { changeType: "configuration", service: "checkout-api", key: "DB_POOL_SIZE", previousValue: 20, newValue: 5 }
    ] }, "d1");
    expect(deploy).toMatchObject({ kind: "deploy", title: "Deployed checkout-api v1.4.2", impactScore: 40, metadata: { changeType: "deploy", version: "v1.4.2", previousVersion: "v1.4.1", sha: "abc1234" } });
    expect(flag).toMatchObject({ kind: "deploy", title: "Feature flag new-checkout set to true on checkout-api", metadata: { changeType: "feature_flag", flagKey: "new-checkout", previousValue: false, newValue: true } });
    expect(config).toMatchObject({ kind: "deploy", metadata: { changeType: "config", flagKey: "DB_POOL_SIZE", previousValue: 20 } });
  });

  it("keeps an alert an alert even when it mentions a change type", () => {
    const [alert] = normalizePayload("generic", { kind: "alert", changeType: "deploy", service: "checkout-api", title: "Error rate high", detail: "5xx above SLO" }, "d2");
    expect(alert!.kind).toBe("alert");
    expect(alert!.metadata.changeType).toBeUndefined();
  });

  it("tells responders to flip a suspect flag back instead of redeploying", () => {
    const incident: Incident = {
      id: "inc-flag", code: "AUTO-9", title: "Checkout errors", summary: "Errors after a flag flip", service: "checkout-api", environment: "production", severity: "high", status: "investigating", owner: "Automation",
      startedAt: "2026-10-05T10:05:00Z", createdAt: "2026-10-05T10:05:00Z", updatedAt: "2026-10-05T10:05:00Z",
      events: [
        { id: "e1", incidentId: "inc-flag", timestamp: "2026-10-05T10:00:00Z", service: "checkout-api", kind: "deploy", title: "Feature flag new-checkout set to true on checkout-api", detail: "flag flip", impactScore: 40, metadata: { provider: "generic", changeType: "feature_flag", flagKey: "new-checkout", previousValue: false } },
        { id: "e2", incidentId: "inc-flag", timestamp: "2026-10-05T10:05:00Z", service: "checkout-api", kind: "alert", title: "Checkout 5xx above SLO", detail: "Error rate 9%", impactScore: 82 }
      ]
    };
    const leading = diagnoseIncident(incident).hypotheses[0]!;
    expect(leading.safeAction).toContain("“new-checkout” back to false");
  });
});

describe("ingestion guards", () => {
  it("drops request and response bodies unless the workspace opted in", () => {
    const [signal] = stripCapturedBodies([{ externalId: "x", timestamp: "2026-10-05T10:00:00Z", service: "api", kind: "metric", title: "t", detail: "d", impactScore: 50, severity: "medium",
      metadata: { route: "/pay", attributes: { "http.request.body": "{\"card\":\"4111\"}", "http.response.body.size": 12, "http.method": "POST" }, body: "raw", nested: [{ payload: "secret", keep: 1 }] } }]);
    expect(signal!.metadata).toEqual({ route: "/pay", attributes: { "http.method": "POST" }, nested: [{ keep: 1 }], bodiesDropped: 4 });
  });

  it("rate limits per key within a one-minute window", () => {
    const key = `test-${Math.random()}`;
    expect(allowIngestRequest(key, 2, 0).allowed).toBe(true);
    expect(allowIngestRequest(key, 2, 10).allowed).toBe(true);
    const blocked = allowIngestRequest(key, 2, 20_000);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 40 });
    expect(allowIngestRequest(key, 2, 60_000).allowed).toBe(true);
  });

  it("reports which incidents a delivery opened so alerts and embeddings can follow", async () => {
    const repository = new MemoryRepository();
    const integration: IntegrationTarget = { id: "int-1", organizationId: "demo-organization", name: "Generic", provider: "generic", status: "active" };
    const result = await repository.ingest(integration, { externalId: "batch-1", signals: normalizePayload("generic", { kind: "alert", service: "brand-new-service", title: "Brand new outage", detail: "Everything is failing", impactScore: 90, timestamp: new Date().toISOString() }, "batch-1") });
    expect(result.opened).toHaveLength(1);
    expect(result.opened![0]).toMatchObject({ title: "Brand new outage", service: "brand-new-service", status: "investigating" });
    const recovery = await repository.ingest(integration, { externalId: "batch-2", signals: normalizePayload("generic", { kind: "recovery", service: "brand-new-service", title: "Recovered", detail: "Errors back to baseline", timestamp: new Date().toISOString() }, "batch-2") });
    expect(recovery.movedToMonitoring?.map((item) => item.id)).toEqual([result.opened![0]!.id]);
  });

  it("leaves destructive deletes to their own snapshot audit entries", () => {
    expect(semanticAuditForRequest("DELETE", "/incidents/abc", {})).toBeNull();
    expect(semanticAuditForRequest("DELETE", "/integrations/abc", {})).toBeNull();
    expect(semanticAuditForRequest("POST", "/alert-channels", {})).toBeNull();
  });
});
