import { describe,expect,it } from "vitest";
import { buildEvidenceBundle,buildInvestigationIntelligence } from "./intelligence.js";
import { seedIncidents } from "./seed.js";

describe("investigation intelligence",()=>{
  it("never invents an impact denominator",()=>{
    const result=buildInvestigationIntelligence(seedIncidents[0]!,seedIncidents);
    expect(result.impact.measured).toBe(false);
    expect(result.impact.totalRequests).toBeNull();
    expect(result.impact.unknowns[0]).toContain("denominator");
  });

  it("redacts secrets and omits payload-like metadata from evidence bundles",()=>{
    const incident=structuredClone(seedIncidents[0]!);
    incident.events[0]!.detail="Authorization: Bearer abc.def.ghi from operator@example.com";
    incident.events[0]!.metadata={token:"secret-value",payload:{password:"unsafe"},traceId:"trace-safe"};
    const bundle=buildEvidenceBundle(incident);
    const serialized=JSON.stringify(bundle);
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("operator@example.com");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).toContain("trace-safe");
  });
});
