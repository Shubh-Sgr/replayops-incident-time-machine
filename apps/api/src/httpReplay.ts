import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { redactSensitiveText } from "./ai.js";
import { config } from "./config.js";
import { notFound } from "./errors.js";
import type { HttpReplayExecution, HttpReplaySpec } from "./types.js";
import { workspaceService } from "./workspace.js";

type SpecInput = Pick<HttpReplaySpec,"name"|"applicationVersion"|"request"|"assertions"|"dependencies">;
type Row = Record<string,unknown>;
const forbiddenHeader = /authorization|cookie|api[-_]?key|token|secret/i;

const mapSpec = (row: Row): HttpReplaySpec => ({ id:String(row.id), incidentId:String(row.incident_id), name:String(row.name), evidenceRevision:new Date(String(row.evidence_revision)).toISOString(), applicationVersion:String(row.application_version), request:row.request as HttpReplaySpec["request"], assertions:row.assertions as HttpReplaySpec["assertions"], dependencies:row.dependencies as HttpReplaySpec["dependencies"], networkPolicy:"deny_except_loopback_target", createdAt:new Date(String(row.created_at)).toISOString() });
const mapExecution = (row: Row): HttpReplayExecution => ({ id:String(row.id), specId:String(row.spec_id), incidentId:String(row.incident_id), evidenceRevision:new Date(String(row.evidence_revision)).toISOString(), status:row.status as HttpReplayExecution["status"], assertionResults:(row.assertion_results ?? []) as HttpReplayExecution["assertionResults"], responseStatus:row.response_status === null || row.response_status === undefined ? undefined : Number(row.response_status), responseBody:row.response_body ? String(row.response_body) : undefined, durationMs:row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms), nondeterministic:Boolean(row.nondeterministic), limitation:row.limitation ? String(row.limitation) : undefined, createdAt:new Date(String(row.created_at)).toISOString() });

class HttpReplayService {
  private pool?: Pool;
  private specs: HttpReplaySpec[] = [];
  private executions: HttpReplayExecution[] = [];
  constructor() { if (config.databaseUrl) this.pool = new Pool({ connectionString:config.databaseUrl, ssl:config.databaseUrl.includes("localhost")?false:{rejectUnauthorized:false}, max:2 }); }
  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`
      create table if not exists http_replay_specs (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        incident_id uuid not null references incidents(id) on delete cascade, name text not null, evidence_revision timestamptz not null,
        application_version text not null, request jsonb not null, assertions jsonb not null, dependencies jsonb not null default '[]',
        network_policy text not null default 'deny_except_loopback_target', created_at timestamptz not null default now()
      );
      create table if not exists http_replay_executions (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        incident_id uuid not null references incidents(id) on delete cascade, spec_id uuid not null references http_replay_specs(id) on delete cascade,
        evidence_revision timestamptz not null, status text not null check(status in ('passed','failed','unsupported')),
        assertion_results jsonb not null default '[]', response_status integer, response_body text, duration_ms integer,
        nondeterministic boolean not null default false, limitation text, created_at timestamptz not null default now()
      );
      create index if not exists http_replay_incident_idx on http_replay_specs(incident_id,created_at desc);
      alter table http_replay_specs enable row level security;
      alter table http_replay_executions enable row level security;
    `);
  }
  private sanitize(input: SpecInput): SpecInput {
    const headers = Object.fromEntries(Object.entries(input.request.headers ?? {}).filter(([key])=>!forbiddenHeader.test(key)).map(([key,value])=>[key,redactSensitiveText(String(value)).text]));
    return { ...input, name:redactSensitiveText(input.name).text, applicationVersion:redactSensitiveText(input.applicationVersion).text, request:{...input.request, path:redactSensitiveText(input.request.path).text, headers, ...(input.request.body ? {body:redactSensitiveText(input.request.body).text.slice(0,64_000)} : {})}, assertions:{...input.assertions,...(input.assertions.bodyIncludes?{bodyIncludes:redactSensitiveText(input.assertions.bodyIncludes).text}:{})}, dependencies:input.dependencies.map((item)=>({...item,name:redactSensitiveText(item.name).text,fixture:redactSensitiveText(item.fixture).text.slice(0,16_000)})) };
  }
  async create(userId:string, incidentId:string, evidenceRevision:string, input:SpecInput) {
    const context=await workspaceService.assertRole(userId,["admin","responder"]); const safe=this.sanitize(input);
    if (!this.pool) { const value:HttpReplaySpec={id:randomUUID(),incidentId,evidenceRevision,...safe,networkPolicy:"deny_except_loopback_target",createdAt:new Date().toISOString()};this.specs.unshift(value);return structuredClone(value); }
    const result=await this.pool.query(`insert into http_replay_specs(organization_id,incident_id,name,evidence_revision,application_version,request,assertions,dependencies) select $1,i.id,$3,$4,$5,$6,$7,$8 from incidents i where i.id=$2 and i.organization_id=$1 returning *`,[context.organizationId,incidentId,safe.name,evidenceRevision,safe.applicationVersion,safe.request,safe.assertions,safe.dependencies]);
    if(!result.rows[0]) throw notFound("Incident not found in this workspace."); return mapSpec(result.rows[0] as Row);
  }
  async list(userId:string,incidentId:string) {
    const context=await workspaceService.context(userId);
    if(!this.pool) return {specs:structuredClone(this.specs.filter((item)=>item.incidentId===incidentId)),executions:structuredClone(this.executions.filter((item)=>item.incidentId===incidentId))};
    const [specs,executions]=await Promise.all([this.pool.query(`select * from http_replay_specs where organization_id=$1 and incident_id=$2 order by created_at desc`,[context.organizationId,incidentId]),this.pool.query(`select * from http_replay_executions where organization_id=$1 and incident_id=$2 order by created_at desc`,[context.organizationId,incidentId])]);
    return {specs:(specs.rows as Row[]).map(mapSpec),executions:(executions.rows as Row[]).map(mapExecution)};
  }
  private async saveExecution(userId:string, value:HttpReplayExecution) {
    const context=await workspaceService.context(userId);
    // Response bodies are only kept when the workspace opted in to body capture; assertions already ran in memory.
    if(value.responseBody!==undefined&&!(await workspaceService.getPrivacy(userId)).captureRequestBodies) value={...value,responseBody:undefined}; if(!this.pool){this.executions.unshift(value);return value;}
    const result=await this.pool.query(`insert into http_replay_executions(id,organization_id,incident_id,spec_id,evidence_revision,status,assertion_results,response_status,response_body,duration_ms,nondeterministic,limitation,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,[value.id,context.organizationId,value.incidentId,value.specId,value.evidenceRevision,value.status,value.assertionResults,value.responseStatus??null,value.responseBody??null,value.durationMs??null,value.nondeterministic,value.limitation??null,value.createdAt]);return mapExecution(result.rows[0] as Row);
  }
  async execute(userId:string, spec:HttpReplaySpec):Promise<HttpReplayExecution> {
    await workspaceService.assertRole(userId,["admin","responder"]);
    const base=config.replayTargetBaseUrl;
    const unsupported=async(limitation:string)=>this.saveExecution(userId,{id:randomUUID(),specId:spec.id,incidentId:spec.incidentId,evidenceRevision:spec.evidenceRevision,status:"unsupported",assertionResults:[],nondeterministic:false,limitation,createdAt:new Date().toISOString()});
    if(!base) return unsupported("No isolated loopback replay target is configured. Run the generated manifest in CI with REPLAY_TARGET_BASE_URL.");
    const target=new URL(base); if(!["localhost","127.0.0.1","::1","[::1]"].includes(target.hostname)) return unsupported("Replay target was rejected because only loopback targets are allowed.");
    const targetUrl=new URL(spec.request.path,target); if(targetUrl.origin!==target.origin) return unsupported("Captured request path attempted to escape the configured target origin.");
    const invoke=async()=>{const started=Date.now();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);try{const response=await fetch(targetUrl,{method:spec.request.method,headers:{...spec.request.headers,"x-replayops-version":spec.applicationVersion},body:["GET","DELETE"].includes(spec.request.method)?undefined:spec.request.body,redirect:"error",signal:controller.signal});const body=(await response.text()).slice(0,64_000);return{status:response.status,body,durationMs:Date.now()-started,digest:createHash("sha256").update(`${response.status}:${body}`).digest("hex")};}finally{clearTimeout(timer);}};
    try { const first=await invoke();const second=await invoke();const nondeterministic=first.digest!==second.digest;const results=[{assertion:`status = ${spec.assertions.status}`,passed:first.status===spec.assertions.status,observed:String(first.status)},...(spec.assertions.bodyIncludes?[{assertion:`body includes ${spec.assertions.bodyIncludes}`,passed:first.body.includes(spec.assertions.bodyIncludes),observed:first.body.slice(0,240)}]:[])];const status=results.every((item)=>item.passed)&&!nondeterministic?"passed":"failed";return this.saveExecution(userId,{id:randomUUID(),specId:spec.id,incidentId:spec.incidentId,evidenceRevision:spec.evidenceRevision,status,assertionResults:results,responseStatus:first.status,responseBody:redactSensitiveText(first.body).text,durationMs:first.durationMs,nondeterministic,limitation:nondeterministic?"Two identical requests produced different outputs; inspect time, randomness, and external state.":undefined,createdAt:new Date().toISOString()}); } catch(error){return this.saveExecution(userId,{id:randomUUID(),specId:spec.id,incidentId:spec.incidentId,evidenceRevision:spec.evidenceRevision,status:"failed",assertionResults:[],nondeterministic:false,limitation:error instanceof Error?error.message:"Replay execution failed.",createdAt:new Date().toISOString()});}
  }
}

export const httpReplayService=new HttpReplayService();
