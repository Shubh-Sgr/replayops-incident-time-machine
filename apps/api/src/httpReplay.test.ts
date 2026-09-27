import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
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

  it("executes against a real loopback candidate and preserves assertion output",async()=>{
    const server=createServer((request,response)=>{
      if(request.headers["x-replayops-version"]==="fixed-sha"){
        response.writeHead(200,{"content-type":"application/json"});response.end('{"status":"confirmed"}');return;
      }
      response.writeHead(500,{"content-type":"application/json"});response.end('{"error":"reservation lost"}');
    });
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve());});
    try{
      const address=server.address();if(!address||typeof address==="string")throw new Error("Loopback fixture did not expose a port.");
      config.replayTargetBaseUrl=`http://127.0.0.1:${address.port}`;
      const oldRun=await httpReplayService.execute("demo-operator",{...spec,applicationVersion:"old-sha"});
      const fixedRun=await httpReplayService.execute("demo-operator",{...spec,applicationVersion:"fixed-sha"});
      expect(oldRun.status).toBe("failed");
      expect(oldRun.responseStatus).toBe(500);
      expect(fixedRun.status).toBe("passed");
      expect(fixedRun.assertionResults.every((item)=>item.passed)).toBe(true);
    }finally{await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
  });
});
