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

  it("rejects unmatched healthy routes and regions as controls",()=>{
    const incident=structuredClone(seedIncidents[0]!);
    incident.events=[
      {id:"fail",incidentId:incident.id,timestamp:"2026-09-20T10:00:00Z",service:"checkout-api",kind:"alert",title:"checkout failed",detail:"failed",impactScore:80,metadata:{signal:"trace",cohortRole:"failing",route:"/checkout",method:"POST",region:"us-east-1",durationMs:900}},
      {id:"healthy",incidentId:incident.id,timestamp:"2026-09-20T10:00:01Z",service:"checkout-api",kind:"metric",title:"health ok",detail:"healthy",impactScore:5,metadata:{signal:"trace",cohortRole:"healthy",route:"/health",method:"GET",region:"eu-west-1",durationMs:20}}
    ];
    const result=buildInvestigationIntelligence(incident,[incident]);
    expect(result.cohorts.healthy.sampleCount).toBe(0);
    expect(result.cohorts.limitations.join(" ")).toContain("excluded");
  });

  it("does not combine unrelated numerator and denominator events",()=>{
    const incident=structuredClone(seedIncidents[0]!);
    incident.events=[
      {...incident.events[0]!,id:"failed",metadata:{failedRequests:10,measurementSeriesId:"errors",measurementScope:"prod",intervalStart:"2026-09-20T10:00:00Z",intervalEnd:"2026-09-20T10:05:00Z"}},
      {...incident.events[1]!,id:"total",metadata:{totalRequests:100,measurementSeriesId:"requests",measurementScope:"prod",intervalStart:"2026-09-20T10:00:00Z",intervalEnd:"2026-09-20T10:05:00Z"}}
    ];
    expect(buildInvestigationIntelligence(incident,[incident]).impact.measured).toBe(false);
  });
});
