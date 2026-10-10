import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { MEMBERSHIPS } from "./scope.js";
import { repository } from "./repository.js";
import { alertService } from "./alerts.js";
import { embedText } from "./ai.js";
import { workspaceService } from "./workspace.js";
import type { IncidentHeadline, IngestionBatch, IngestionResult, IntegrationTarget, QueueJob } from "./types.js";
import { notFound } from "./errors.js";

type Row = Record<string, unknown>;
type StoredJob = QueueJob & { integration: IntegrationTarget; batch: IngestionBatch };

export function summarizeIngestionBatch(batch: IngestionBatch | null | undefined, sourceName = "Evidence source") {
  const signals = batch?.signals ?? [];
  const firstTitle = signals.find((signal) => signal.title.trim())?.title.trim();
  return {
    eventName: firstTitle ? `${firstTitle}${signals.length > 1 ? ` + ${signals.length - 1} more` : ""}` : `${sourceName} delivery`,
    signalCount: signals.length
  };
}

const mapJob = (row: Row, integration?: IntegrationTarget): QueueJob => {
  const sourceName = String(row.integration_name ?? integration?.name ?? "Evidence source");
  const batch = row.batch as IngestionBatch | undefined;
  return {
    id: String(row.id), integrationId: String(row.integration_id), externalId: String(row.external_id),
    ...summarizeIngestionBatch(batch, sourceName), sourceName, status: row.status as QueueJob["status"],
    attempts: Number(row.attempts), lastError: row.last_error ? String(row.last_error) : null,
    nextAttemptAt: new Date(String(row.next_attempt_at)).toISOString(), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString()
  };
};

/**
 * Work that follows a committed delivery but must never fail it: tell people about new or recovering
 * incidents, and embed new incidents so "similar past incidents" search can find them later.
 */
export async function afterIngest(integration: IntegrationTarget, opened: IncidentHeadline[], movedToMonitoring: IncidentHeadline[], escalated: IncidentHeadline[] = [], reopened: Array<IncidentHeadline & { reason: string }> = []) {
  if (!opened.length && !movedToMonitoring.length && !escalated.length && !reopened.length) return;
  try {
    const privacy = await workspaceService.privacyForOrganization(integration.organizationId);
    await Promise.all([
      ...opened.map((incident) => alertService.dispatch(integration.organizationId, { type: "opened", incident, detail: `Opened automatically from ${integration.name}.` })),
      ...reopened.map(({ reason, ...incident }) => alertService.dispatch(integration.organizationId, { type: "reopened", incident, detail: `${reason} New evidence from ${integration.name}.` })),
      // A reopened incident already pages once; its escalation would only repeat it.
      ...escalated.filter((incident) => !reopened.some((item) => item.id === incident.id)).map((incident) => alertService.dispatch(integration.organizationId, { type: "escalated", incident, detail: `Severity raised to ${incident.severity} by new evidence from ${integration.name}.` })),
      ...movedToMonitoring.map((incident) => alertService.dispatch(integration.organizationId, { type: "monitoring", incident, detail: `${integration.name} reported a recovery signal. Verify recovery, then resolve.` })),
      ...opened.map(async (incident) => {
        const embedding = await embedText(`${incident.title}\n${incident.summary}\n${incident.service}`, privacy.externalAiEnabled).catch(() => undefined);
        if (embedding) await repository.setIncidentEmbedding(incident.id, embedding);
      })
    ]);
  } catch (error) {
    console.error("Post-ingest follow-up failed", error instanceof Error ? error.message : error);
  }
}

const publicJob = ({ integration, batch, ...job }: StoredJob): QueueJob => ({
  ...job,
  sourceName: integration.name,
  ...summarizeIngestionBatch(batch, integration.name)
});

class DurableIngestionQueue {
  private pool?: Pool;
  private jobs: StoredJob[] = [];

  constructor() {
    if (config.databaseUrl) this.pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }, max: 3 });
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`
      create table if not exists ingestion_queue (
        id uuid primary key default gen_random_uuid(), integration_id uuid not null references integrations(id) on delete cascade,
        external_id text not null, batch jsonb not null, status text not null default 'queued' check(status in ('queued','processing','completed','retrying','dead_letter')),
        attempts integer not null default 0, last_error text, next_attempt_at timestamptz not null default now(),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(integration_id,external_id)
      );
      create index if not exists ingestion_queue_ready_idx on ingestion_queue(status,next_attempt_at);
      alter table ingestion_queue enable row level security;
    `);
  }

  async enqueue(integration: IntegrationTarget, batch: IngestionBatch): Promise<{ job: QueueJob; duplicate: boolean }> {
    if (!this.pool) {
      const existing = this.jobs.find((job) => job.integrationId === integration.id && job.externalId === batch.externalId);
      if (existing) return { job: structuredClone(publicJob(existing)), duplicate: true };
      const now = new Date().toISOString();
      const job: StoredJob = { id: randomUUID(), integrationId: integration.id, externalId: batch.externalId, ...summarizeIngestionBatch(batch, integration.name), sourceName: integration.name, status: "queued", attempts: 0, lastError: null, nextAttemptAt: now, createdAt: now, updatedAt: now, integration, batch };
      this.jobs.unshift(job);
      return { job: structuredClone(publicJob(job)), duplicate: false };
    }
    const result = await this.pool.query(`insert into ingestion_queue(integration_id,external_id,batch) values($1,$2,$3) on conflict(integration_id,external_id) do nothing returning *`, [integration.id, batch.externalId, batch]);
    if (result.rows[0]) return { job: mapJob(result.rows[0] as Row, integration), duplicate: false };
    const existing = await this.pool.query(`select * from ingestion_queue where integration_id=$1 and external_id=$2`, [integration.id, batch.externalId]);
    return { job: mapJob(existing.rows[0] as Row, integration), duplicate: true };
  }

  async process(jobId: string): Promise<IngestionResult> {
    let integration: IntegrationTarget | null = null;
    let batch: IngestionBatch | null = null;
    if (!this.pool) {
      const job = this.jobs.find((item) => item.id === jobId);
      if (!job) throw new Error("Queued delivery not found.");
      job.status = "processing"; job.attempts += 1; job.updatedAt = new Date().toISOString();
      integration = job.integration; batch = job.batch;
    } else {
      const claimed = await this.pool.query(`update ingestion_queue set status='processing',attempts=attempts+1,updated_at=now() where id=$1 and status in ('queued','retrying') and next_attempt_at<=now() returning *`, [jobId]);
      const row = claimed.rows[0] as Row | undefined;
      if (!row) throw new Error("Queued delivery is not ready for processing.");
      integration = await repository.getIntegrationTarget(String(row.integration_id));
      batch = row.batch as IngestionBatch;
    }
    try {
      if (!integration || !batch) throw new Error("Connector for queued delivery is unavailable.");
      const result = await repository.ingest(integration, batch);
      if (!this.pool) {
        const job = this.jobs.find((item) => item.id === jobId)!; job.status = "completed"; job.lastError = null; job.updatedAt = new Date().toISOString();
      } else await this.pool.query(`update ingestion_queue set status='completed',last_error=null,updated_at=now() where id=$1`, [jobId]);
      const { opened = [], movedToMonitoring = [], escalated = [], reopened = [], ...reply } = result;
      void afterIngest(integration, opened, movedToMonitoring, escalated, reopened);
      return { ...reply, queueId: jobId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion failure";
      if (!this.pool) {
        const job = this.jobs.find((item) => item.id === jobId)!; job.lastError = message; job.status = job.attempts >= 5 ? "dead_letter" : "retrying"; job.nextAttemptAt = new Date(Date.now() + Math.min(300_000, 2 ** job.attempts * 5_000)).toISOString(); job.updatedAt = new Date().toISOString();
      } else await this.pool.query(`update ingestion_queue set status=case when attempts>=5 then 'dead_letter' else 'retrying' end,last_error=$2,next_attempt_at=now()+(least(300,power(2,attempts)*5)::text||' seconds')::interval,updated_at=now() where id=$1`, [jobId, message]);
      throw error;
    }
  }

  async processReady(limit = 10) {
    if (this.pool) {
      await this.pool.query(`update ingestion_queue set status='retrying',last_error=coalesce(last_error,'Worker lease expired before completion.'),next_attempt_at=now(),updated_at=now() where status='processing' and updated_at<now()-interval '5 minutes'`);
    }
    const ids = this.pool
      ? (await this.pool.query(`select id from ingestion_queue where status in ('queued','retrying') and next_attempt_at<=now() order by created_at limit $1`, [limit])).rows.map((row: Row) => String(row.id))
      : this.jobs.filter((job) => ["queued", "retrying"].includes(job.status) && new Date(job.nextAttemptAt) <= new Date()).slice(0, limit).map((job) => job.id);
    // The demo queue keeps finished entries for the longest retention a source can choose.
    if (!this.pool) this.jobs = this.jobs.filter((job) => !["completed", "dead_letter"].includes(job.status) || Date.now() - Date.parse(job.updatedAt) <= 90 * 86_400_000);
    for (const id of ids) await this.process(id).catch(() => undefined);
    return ids.length;
  }

  async list(userId: string) {
    if (!this.pool) return structuredClone(this.jobs.map(publicJob).slice(0, 50));
    const result = await this.pool.query(`select q.*, i.name as integration_name from ingestion_queue q join integrations i on i.id=q.integration_id where exists(select 1 from ${MEMBERSHIPS} m where m.organization_id=i.organization_id and m.user_id=$1) order by q.created_at desc limit 50`, [userId]);
    return result.rows.map((row) => mapJob(row as Row));
  }

  async retry(userId: string, jobId: string) {
    if (!this.pool) { const job = this.jobs.find((item) => item.id === jobId); if (!job) throw notFound("Queue job not found."); job.status = "retrying"; job.nextAttemptAt = new Date().toISOString(); job.updatedAt = new Date().toISOString(); return structuredClone(publicJob(job)); }
    const result = await this.pool.query(`update ingestion_queue q set status='retrying',next_attempt_at=now(),updated_at=now() from integrations i where q.id=$2 and i.id=q.integration_id and exists(select 1 from ${MEMBERSHIPS} m where m.organization_id=i.organization_id and m.user_id=$1 and m.role in ('admin','responder')) returning q.*, i.name as integration_name`, [userId, jobId]);
    if (!result.rows[0]) throw notFound("Queue job not found or your role cannot retry it.");
    return mapJob(result.rows[0] as Row);
  }
}

export const ingestionQueue = new DurableIngestionQueue();
