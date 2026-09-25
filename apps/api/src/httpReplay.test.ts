import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "./config.js";
import { httpReplayService } from "./httpReplay.js";
import type { HttpReplaySpec } from "./types.js";

afterEach(() => {
  config.replayTargetBaseUrl = undefined;
  vi.unstubAllGlobals();
});

const spec:HttpReplaySpec={id:"00000000-0000-4000-8000-000000000010",incidentId:"incident-replay-test",name:"Checkout regression",evidenceRevision:"2026-09-25T00:00:00.000Z",applicationVersion:"candidate-sha",request:{method:"POST",path:"/checkout",headers:{"content-type":"application/json"},body:'{"reservationId":"fixture-1"}'},assertions:{status:200,bodyIncludes:"confirmed"},dependencies:[{name:"inventory",mode:"mocked",fixture:"reservation available"}],networkPolicy:"deny_except_loopback_target",createdAt:"2026-09-25T00:00:00.000Z"};

describe("bounded HTTP replay",()=>{
  it("fails against the old behavior and passes against the fixed response",async()=>{
    config.replayTargetBaseUrl="http://127.0.0.1:9099";
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{"error":"reservation lost"}',{status:500})));
    const oldRun=await httpReplayService.execute("demo-operator",spec);
    expect(oldRun.status).toBe("failed");
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{"status":"confirmed"}',{status:200})));
    const fixedRun=await httpReplayService.execute("demo-operator",spec);
    expect(fixedRun.status).toBe("passed");
    expect(fixedRun.nondeterministic).toBe(false);
  });

  it("reports unsupported instead of claiming execution without an isolated target",async()=>{
    const result=await httpReplayService.execute("demo-operator",spec);
    expect(result.status).toBe("unsupported");
    expect(result.limitation).toContain("loopback replay target");
  });
});
