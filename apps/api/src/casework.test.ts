import { describe, expect, it } from "vitest";
import { evaluateDeliveryRecovery, evaluateRuntimeRecovery, type RecoveryCriterion, type TypedMeasurement, type ValidationArtifact } from "./casework.js";

const criterion:RecoveryCriterion={id:"criterion-1",incidentId:"incident-1",version:2,kind:"runtime",name:"HTTP 5xx rate",source:"Prometheus",query:"rate(http_requests_total)",unit:"%",comparison:"lte",targetValue:1,minConsecutiveWindows:2,maxAgeMinutes:10,observationMinutes:10,deliveryIdentity:null,createdAt:"2026-09-27T09:00:00.000Z"};
const measurement=(id:string,value:number,observedAt:string,start:string,end:string):TypedMeasurement=>({id,incidentId:"incident-1",criterionId:criterion.id,value,unit:"%",source:"Prometheus",query:"rate(http_requests_total)",windowStartedAt:start,windowEndedAt:end,observedAt,state:"valid",note:"fixture",createdAt:observedAt});

describe("server-owned recovery evaluation",()=>{
  it("requires consecutive, fresh, sufficiently long runtime windows",()=>{
    const result=evaluateRuntimeRecovery(criterion,[measurement("m2",0.4,"2026-09-27T10:00:00.000Z","2026-09-27T09:55:00.000Z","2026-09-27T10:00:00.000Z"),measurement("m1",0.6,"2026-09-27T09:55:00.000Z","2026-09-27T09:50:00.000Z","2026-09-27T09:55:00.000Z")],new Date("2026-09-27T10:01:00.000Z"));
    expect(result.state).toBe("verified");
    expect(result.supportingMeasurementIds).toEqual(["m2","m1"]);
  });

  it("does not let an old pass override a newer regression",()=>{
    const result=evaluateRuntimeRecovery(criterion,[measurement("regression",4.2,"2026-09-27T10:00:00.000Z","2026-09-27T09:55:00.000Z","2026-09-27T10:00:00.000Z"),measurement("pass-2",0.4,"2026-09-27T09:55:00.000Z","2026-09-27T09:50:00.000Z","2026-09-27T09:55:00.000Z"),measurement("pass-1",0.5,"2026-09-27T09:50:00.000Z","2026-09-27T09:45:00.000Z","2026-09-27T09:50:00.000Z")],new Date("2026-09-27T10:01:00.000Z"));
    expect(result.state).toBe("failed");
    expect(result.supportingMeasurementIds).toEqual(["regression"]);
  });

  it("rejects stale or missing runtime data",()=>{
    expect(evaluateRuntimeRecovery(criterion,[measurement("old",0.1,"2026-09-27T09:00:00.000Z","2026-09-27T08:55:00.000Z","2026-09-27T09:00:00.000Z")],new Date("2026-09-27T10:00:00.000Z")).state).toBe("stale");
    expect(evaluateRuntimeRecovery(criterion,[],new Date("2026-09-27T10:00:00.000Z")).state).toBe("insufficient");
  });

  it("verifies delivery only against the exact workflow identity",()=>{
    const delivery:RecoveryCriterion={...criterion,id:"criterion-ci",kind:"delivery",unit:"run",deliveryIdentity:{repository:"acme/shop",workflow:"deploy.yml",sha:"abc123",runId:"42",attempt:"2"}};
    const artifact:ValidationArtifact={id:"validation-1",incidentId:"incident-1",proposalId:"proposal-1",proposalVersion:3,kind:"ci",status:"passed",summary:"exact rerun passed",provenance:{repository:"acme/shop",workflow:"deploy.yml",sha:"different",runId:"42",attempt:"2"},evidenceRevision:"2026-09-27T09:00:00.000Z",createdBy:"reviewer",createdAt:"2026-09-27T10:00:00.000Z"};
    expect(evaluateDeliveryRecovery(delivery,[artifact]).state).toBe("insufficient");
    expect(evaluateDeliveryRecovery(delivery,[{...artifact,provenance:{...artifact.provenance,sha:"abc123"}}]).state).toBe("verified");
    expect(evaluateDeliveryRecovery(delivery,[{...artifact,status:"failed",provenance:{...artifact.provenance,sha:"abc123"}}]).state).toBe("failed");
  });
});

describe("demo-mode casework lifecycle",()=>{
  const userId="00000000-0000-4000-8000-000000000001";
  it("audits lifecycle transitions and reports typed errors",async()=>{
    const { CaseworkService }=await import("./casework.js");
    const { repository }=await import("./repository.js");
    const { workspaceService }=await import("./workspace.js");
    const { HttpError }=await import("./errors.js");
    const service=new CaseworkService("");
    const incident=await repository.createIncident(userId,{title:"Lifecycle audit fixture",summary:"Fixture incident for lifecycle auditing.",service:"orders-api",severity:"high",status:"investigating",owner:"Test Operator",startedAt:"2026-09-27T09:00:00.000Z",resolvedAt:null});
    const updated=await service.transition(userId,incident.id,"operator@replayops.dev","admin",{action:"start_monitoring",reason:"Observing after rollback",expectedEvidenceRevision:incident.evidenceRevision??incident.updatedAt});
    expect(updated?.status).toBe("monitoring");
    const audit=await workspaceService.listAudit(userId);
    expect(audit.some((entry)=>entry.action==="started recovery monitoring"&&entry.targetId===incident.id)).toBe(true);
    await expect(service.transition(userId,incident.id,"operator@replayops.dev","admin",{action:"resolve",reason:"No criterion defined yet",expectedEvidenceRevision:updated!.evidenceRevision??updated!.updatedAt})).rejects.toMatchObject({status:409});
    await expect(service.updateCheck(userId,"missing-check",{status:"planned",result:"",evidenceIds:[]},incident)).rejects.toBeInstanceOf(HttpError);
  });
});
