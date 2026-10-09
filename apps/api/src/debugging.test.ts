import { describe, expect, it } from "vitest";
import { assistantIntent, scopedDeterministicAnswer } from "./ai.js";
import { diagnoseIncident } from "./diagnosis.js";
import { buildInvestigationIntelligence } from "./intelligence.js";
import { seedIncidents } from "./seed.js";
import type { HypothesisTest } from "./types.js";

const testWith = (hypothesisId: string, status: HypothesisTest["status"]): HypothesisTest => ({
  id: "t1", incidentId: "inc-1842", hypothesisId, title: "t", instruction: "i", assignee: "a", status,
  result: "observed", createdAt: "2026-09-20T07:00:00Z", updatedAt: "2026-09-20T07:00:00Z"
});

describe("debugging guidance", () => {
  it("never names a responder's own action or a recovery as the cause", () => {
    const incident = { ...seedIncidents[0]!, events: [
      { id: "a", incidentId: "inc-1842", timestamp: "2026-09-20T06:00:00Z", service: "auth-api", kind: "action" as const, title: "Restarted auth pods", detail: "Restarted auth pods", impactScore: 25, provenance: "manual" as const },
      { id: "r", incidentId: "inc-1842", timestamp: "2026-09-20T06:05:00Z", service: "auth-api", kind: "recovery" as const, title: "Login works again", detail: "Login works again", impactScore: 15, provenance: "manual" as const }
    ] };
    const diagnosis = diagnoseIncident(incident);
    expect(diagnosis.hypotheses).toEqual([]);
    expect(diagnosis.nextAction.label).toBe("Add what you're seeing");
  });

  it("moves on to fix validation once the leading explanation is supported", () => {
    const initial = diagnoseIncident(seedIncidents[0]!);
    const leadingId = initial.hypotheses[0]!.id;
    const supported = diagnoseIncident(seedIncidents[0]!, [testWith(leadingId, "supported")]);
    expect(supported.nextAction.label).toBe("Try a fix");
    expect(supported.nextAction.href).toBe("?area=validate");
    expect(supported.hypotheses[0]!.nextTest).not.toBe(initial.hypotheses[0]!.nextTest);
  });

  it("suggests a different test after an inconclusive result", () => {
    const initial = diagnoseIncident(seedIncidents[0]!);
    const leadingId = initial.hypotheses[0]!.id;
    const inconclusive = diagnoseIncident(seedIncidents[0]!, [testWith(leadingId, "inconclusive")]);
    expect(inconclusive.nextAction.reason).not.toBe(initial.nextAction.reason);
  });

  it("classifies assistant intent from the leading instruction", () => {
    expect(assistantIntent("Propose the cheapest safe falsification test. Use only evidence")).toBe("next-test");
    expect(assistantIntent("Challenge the current explanation with the strongest contradiction")).toBe("challenge");
    expect(assistantIntent("Summarize what changed in the evidence. State unknowns")).toBe("changes");
    expect(assistantIntent("Explain the observed evidence without claiming causation. Current claim: falsify")).toBe("explain");
  });

  it("cites only events from the scoped incident, in evidence order", () => {
    const incident = seedIncidents[0]!;
    const result = scopedDeterministicAnswer("Explain the observed evidence", incident, diagnoseIncident(incident));
    const ids = new Set(incident.events.map((event) => event.id));
    expect(result.eventIds.length).toBeGreaterThan(0);
    expect(result.eventIds.every((id) => ids.has(id))).toBe(true);
    expect(result.answer).toContain("Connection pool saturation begins");
  });

  it("omits an unknown environment from generated queries and covers all affected services", () => {
    const incident = { ...structuredClone(seedIncidents[0]!), environment: "unknown" };
    const queries = buildInvestigationIntelligence(incident, [incident]).querySuggestions;
    expect(queries.map((item) => item.query).join(" ")).not.toContain("unknown");
    expect(queries.find((item) => item.id === "error-logs")!.query).toContain("payments-api");
    const production = buildInvestigationIntelligence(seedIncidents[0]!, seedIncidents).querySuggestions;
    expect(production[0]!.query).toContain('deployment.environment = "production"');
  });
});

describe("failing cohort", () => {
  it("compares slow spans with healthy controls and lists failing exemplars first", () => {
    const incident = structuredClone(seedIncidents[0]!);
    const span = (id: string, role: string, durationMs: number) => ({ id, incidentId: incident.id, timestamp: `2026-09-20T10:00:0${id.length}Z`, service: "checkout-api", kind: "metric" as const, title: id, detail: id, impactScore: 50, metadata: { signal: "trace", cohortRole: role, route: "/checkout", method: "POST", region: "us-east-1", durationMs, traceId: `trace-${id}`, sampleRate: 0.05 } });
    incident.events = [span("h", "healthy", 200), span("sl", "slow", 3000), span("fai", "failing", 4000)];
    const result = buildInvestigationIntelligence(incident, [incident]);
    expect(result.cohorts.failing.sampleCount).toBe(2);
    expect(result.cohorts.healthy.sampleCount).toBe(1);
    expect(result.querySuggestions.find((item) => item.id === "exemplar-traces")!.query.indexOf("trace-h")).toBeGreaterThan(result.querySuggestions.find((item) => item.id === "exemplar-traces")!.query.indexOf("trace-sl"));
  });
});
