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
