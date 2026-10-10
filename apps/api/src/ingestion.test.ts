import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveIntegrationToken, normalizePayload, verifyGitHubSignature } from "./ingestion.js";
import { MemoryRepository } from "./repository.js";

describe("automated ingestion", () => {
  it("validates GitHub HMAC signatures without plain string comparison", () => {
    const integrationId = "9d75f834-f399-4b38-9c42-854c16204174";
    const body = Buffer.from(JSON.stringify({ zen: "Keep it logically awesome." }));
    const signature = `sha256=${createHmac("sha256", deriveIntegrationToken(integrationId)).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(body, integrationId, signature)).toBe(true);
    expect(verifyGitHubSignature(body, integrationId, `${signature.slice(0, -1)}0`)).toBe(false);
  });

  it("rotating a source's secret kills its old token and leaves other sources alone", async () => {
    const integrationId = "9d75f834-f399-4b38-9c42-854c16204174";
    // Version 0 is the original formula, so sources created before rotation existed keep their token.
    expect(deriveIntegrationToken(integrationId, 0)).toBe(deriveIntegrationToken(integrationId));
    expect(deriveIntegrationToken(integrationId, 1)).not.toBe(deriveIntegrationToken(integrationId, 0));
    const body = Buffer.from("{}");
    const oldSignature = `sha256=${createHmac("sha256", deriveIntegrationToken(integrationId, 0)).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(body, integrationId, oldSignature, 1)).toBe(false);

    const repository = new MemoryRepository();
    const first = await repository.createIntegration("demo", { name: "Grafana prod", provider: "generic" });
    const second = await repository.createIntegration("demo", { name: "GitHub", provider: "github" });
    const rotated = await repository.rotateIntegrationToken("demo", first.id);
    expect(rotated?.tokenVersion).toBe(1);
    expect((await repository.getIntegrationTarget(first.id))?.tokenVersion).toBe(1);
    expect((await repository.getIntegrationTarget(second.id))?.tokenVersion).toBe(0);
  });

  it("normalizes failed GitHub workflows as incident-grade evidence", () => {
    const signals = normalizePayload("github", {
      repository: { full_name: "acme/checkout", html_url: "https://github.com/acme/checkout" },
      sender: { login: "release-bot" },
      workflow_run: {
        id: 42, name: "Deploy production", conclusion: "failure", event: "push",
        head_branch: "main", head_sha: "abc123", updated_at: "2026-09-20T10:00:00Z",
        html_url: "https://github.com/acme/checkout/actions/runs/42"
      }
    }, "delivery-1", "workflow_run");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ service: "acme/checkout", kind: "alert", severity: "high", impactScore: 76 });
  });

  it("keeps CI success and inactive deployments separate from production health", () => {
    const workflow = normalizePayload("github", { repository:{ id:7, full_name:"acme/api" }, workflow_run:{ id:9, workflow_id:4, name:"CI", status:"completed", conclusion:"success", head_sha:"abc", head_branch:"main", run_attempt:2, updated_at:"2026-09-20T10:00:00Z" } }, "delivery-ci", "workflow_run")[0]!;
    const inactive = normalizePayload("github", { repository:{ id:7, full_name:"acme/api" }, deployment:{ id:3, environment:"production", sha:"abc" }, deployment_status:{ state:"inactive", created_at:"2026-09-20T10:01:00Z" } }, "delivery-deploy", "deployment_status")[0]!;
    expect(workflow.kind).toBe("metric");
    expect(workflow.metadata).toMatchObject({ eventType:"workflow_run", runId:9, runAttempt:2, productionHealthMeasured:false });
    expect(inactive.kind).toBe("metric");
  });

  it("preserves Grafana firing, resolved, and refiring lifecycle observations", () => {
    const payload = (status:string, startsAt:string, endsAt?:string) => ({ status, alerts:[{ status, fingerprint:"checkout-errors", startsAt, endsAt, labels:{ alertname:"CheckoutErrors", service:"checkout-api", environment:"production" }, annotations:{ summary:"Checkout errors", stateReason:"threshold" }, values:{ A:7.2 } }] });
    const firing = normalizePayload("generic", payload("firing", "2026-09-20T10:00:00Z"), "delivery-1")[0]!;
    const resolved = normalizePayload("generic", payload("resolved", "2026-09-20T10:00:00Z", "2026-09-20T10:15:00Z"), "delivery-2")[0]!;
    const refiring = normalizePayload("generic", payload("firing", "2026-09-20T10:30:00Z"), "delivery-3")[0]!;
    expect(new Set([firing.externalId,resolved.externalId,refiring.externalId]).size).toBe(3);
    expect(resolved).toMatchObject({ kind:"recovery", timestamp:"2026-09-20T10:15:00.000Z", environment:"production" });
    expect(resolved.metadata).toMatchObject({ alertIdentity:"checkout-errors", startsAt:"2026-09-20T10:00:00.000Z", values:{ A:7.2 } });
  });

  it("does not infer a threshold alert from a zero-valued error gauge", () => {
    const signal = normalizePayload("otel", { resourceMetrics:[{ resource:{ attributes:[{key:"service.name",value:{stringValue:"checkout-api"}}] }, scopeMetrics:[{ metrics:[{ name:"http.errors", unit:"1", gauge:{ dataPoints:[{ asInt:0, timeUnixNano:"1789898400000000000" }] } }] }] }] }, "delivery-metric")[0]!;
    expect(signal.kind).toBe("metric");
    expect(signal.title).toContain("measurement received");
    expect(signal.metadata).toMatchObject({ metricType:"gauge", value:0, recoveryEligibility:"requires-configured-evaluator" });
  });

  it("uses the receipt time when a sender omits the timestamp", () => {
    const before = Date.now();
    const signal = normalizePayload("generic", { title:"No clock", detail:"timestamp omitted" }, "delivery-no-time")[0]!;
    expect(Date.parse(signal.timestamp)).toBeGreaterThanOrEqual(before);
    expect(signal.metadata.timestampSource).toBe("received");
  });

  it("does not turn malformed timestamps into fresh evidence", () => {
    const signal = normalizePayload("generic", { title:"Bad clock", detail:"invalid timestamp", timestamp:"not-a-date" }, "delivery-bad-time")[0]!;
    expect(signal.timestamp).toBe("1970-01-01T00:00:00.000Z");
  });

  it("filters OTLP traces to failed or slow spans and preserves trace context", () => {
    const signals = normalizePayload("otel", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "payments-api" } }] },
        scopeSpans: [{ spans: [{
          traceId: "5b8efff798038103d269b633813fc60c", spanId: "a1b2", name: "POST /authorize",
          startTimeUnixNano: "1789898400000000000", endTimeUnixNano: "1789898403200000000",
          status: { code: 2, message: "deadline exceeded" }, attributes: []
        }] }]
      }]
    }, "delivery-2");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ service: "payments-api", kind: "alert", traceId: "5b8efff798038103d269b633813fc60c" });
  });

  it("honors the connector's healthy trace sample rate", () => {
    const spans = Array.from({ length: 400 }, (_, index) => ({ traceId: `trace-${index}`, spanId: `span-${index}`, name: "GET /ok", startTimeUnixNano: "1789898400000000000", endTimeUnixNano: "1789898400100000000", status: { code: 0 }, attributes: [] }));
    const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] }, scopeSpans: [{ spans }] }] };
    expect(normalizePayload("otel", payload, "d", "", 0)).toHaveLength(0);
    expect(normalizePayload("otel", payload, "d", "", 1)).toHaveLength(400);
    const half = normalizePayload("otel", payload, "d", "", 0.5);
    expect(half.length).toBeGreaterThan(150);
    expect(half.length).toBeLessThan(250);
    expect(half[0]!.metadata?.sampleRate).toBe(0.5);
  });

  it("buffers a deployment, opens an incident on the later alert, and backfills the precursor", async () => {
    const repository = new MemoryRepository();
    const integration = await repository.createIntegration("demo", { name: "Production telemetry", provider: "generic" });
    const target = await repository.getIntegrationTarget(integration.id);
    expect(target).not.toBeNull();
    await repository.ingest(target!, {
      externalId: "delivery-deploy",
      signals: [{
        externalId: "deploy-1", timestamp: "2026-09-20T10:00:00Z", service: "orders-v2", kind: "deploy",
        title: "orders-v2 deployed", detail: "Version 9f31 reached production.", impactScore: 20, severity: "low",
        correlationKey: "release-9f31", metadata: { sha: "9f31" }
      }]
    });
    const result = await repository.ingest(target!, {
      externalId: "delivery-alert",
      signals: [{
        externalId: "alert-1", timestamp: "2026-09-20T10:05:00Z", service: "orders-v2", kind: "alert",
        title: "Order errors exceeded SLO", detail: "Five-minute error rate reached 8.2 percent.", impactScore: 84,
        severity: "high", correlationKey: "release-9f31", metadata: { errorRate: 8.2 }
      }]
    });
    expect(result.incidentIds).toHaveLength(1);
    const incident = await repository.getIncident("demo", result.incidentIds[0]!);
    expect(incident?.events.map((event) => event.kind)).toEqual(["deploy", "alert"]);
    expect((await repository.listIntegrations("demo"))[0]!.signalCount).toBe(2);
    const duplicate = await repository.ingest(target!, { externalId: "delivery-alert", signals: [] });
    expect(duplicate).toEqual({ status: "duplicate", acceptedSignals: 0, incidentIds: [] });
  });

  it("groups signals across services connected in the service catalog", async () => {
    const repository = new MemoryRepository();
    const integration = await repository.createIntegration("demo", { name: "Architecture test", provider: "generic" });
    const target = await repository.getIntegrationTarget(integration.id);
    const checkout = await repository.ingest(target!, {
      externalId: "checkout-alert-delivery",
      signals: [{
        externalId: "checkout-alert", timestamp: "2026-09-20T11:00:00Z", service: "checkout-api", kind: "alert",
        title: "Checkout error budget burn", detail: "Checkout failures exceeded the configured threshold.", impactScore: 82,
        severity: "high", metadata: {}
      }]
    });
    const inventory = await repository.ingest(target!, {
      externalId: "inventory-alert-delivery",
      signals: [{
        externalId: "inventory-alert", timestamp: "2026-09-20T11:04:00Z", service: "inventory-api", kind: "alert",
        title: "Inventory timeouts", detail: "A dependency listed in the service catalog started timing out.", impactScore: 77,
        severity: "high", metadata: {}
      }]
    });
    expect(inventory.incidentIds).toEqual(checkout.incidentIds);
    const incident = await repository.getIncident("demo", checkout.incidentIds[0]!);
    expect(incident?.events.map((event) => event.service)).toEqual(["checkout-api", "inventory-api"]);
  });

  it("never correlates production and staging signals into one incident",async()=>{
    const repository=new MemoryRepository();
    const integration=await repository.createIntegration("demo",{name:"Environment isolation",provider:"generic"});
    const target=await repository.getIntegrationTarget(integration.id);
    const production=await repository.ingest(target!,{externalId:"prod",signals:[{externalId:"prod-alert",timestamp:"2026-09-20T12:00:00Z",service:"checkout-api",environment:"production",kind:"alert",title:"Production checkout errors",detail:"Production failures crossed the threshold.",impactScore:82,severity:"high",metadata:{}}]});
    const staging=await repository.ingest(target!,{externalId:"stage",signals:[{externalId:"stage-alert",timestamp:"2026-09-20T12:01:00Z",service:"checkout-api",environment:"staging",kind:"alert",title:"Staging checkout errors",detail:"Staging failures crossed the threshold.",impactScore:82,severity:"high",metadata:{}}]});
    expect(staging.incidentIds[0]).not.toBe(production.incidentIds[0]);
  });
});
