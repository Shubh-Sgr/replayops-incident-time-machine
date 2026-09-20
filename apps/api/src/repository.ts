import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { seedActivities, seedDashboardSeries, seedIncidents, seedReplayRuns } from "./seed.js";
import type { Activity, DashboardData, Incident, IncidentEvent, ReplayRun, SearchResult } from "./types.js";

export type IncidentInput = Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events">;
export type EventInput = Omit<IncidentEvent, "id" | "incidentId">;

export interface Repository {
  dashboard(userId: string): Promise<DashboardData>;
  listIncidents(userId: string): Promise<Incident[]>;
  getIncident(userId: string, id: string): Promise<Incident | null>;
  createIncident(userId: string, input: IncidentInput, embedding?: number[]): Promise<Incident>;
  updateIncident(userId: string, id: string, input: Partial<IncidentInput>, embedding?: number[]): Promise<Incident | null>;
  deleteIncident(userId: string, id: string): Promise<boolean>;
  createEvent(userId: string, incidentId: string, input: EventInput): Promise<IncidentEvent | null>;
  updateEvent(userId: string, incidentId: string, eventId: string, input: Partial<EventInput>): Promise<IncidentEvent | null>;
  deleteEvent(userId: string, incidentId: string, eventId: string): Promise<boolean>;
  search(userId: string, query: string, embedding?: number[]): Promise<SearchResult[]>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRepository implements Repository {
  private incidents = clone(seedIncidents);

  async dashboard(_userId: string): Promise<DashboardData> {
    return { incidents: clone(this.incidents), activities: clone(seedActivities), replayRuns: clone(seedReplayRuns), ...clone(seedDashboardSeries) };
  }
  async listIncidents(_userId: string) { return clone(this.incidents).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  async getIncident(_userId: string, id: string) { return clone(this.incidents.find((incident) => incident.id === id) ?? null); }
  async createIncident(_userId: string, input: IncidentInput) {
    const now = new Date().toISOString();
    const incident: Incident = { ...input, id: randomUUID(), code: `ROP-${Math.floor(2000 + Math.random() * 7000)}`, createdAt: now, updatedAt: now, events: [] };
    this.incidents.unshift(incident);
    return clone(incident);
  }
  async updateIncident(_userId: string, id: string, input: Partial<IncidentInput>) {
    const incident = this.incidents.find((item) => item.id === id);
    if (!incident) return null;
    Object.assign(incident, input, { updatedAt: new Date().toISOString() });
    return clone(incident);
  }
  async deleteIncident(_userId: string, id: string) {
    const before = this.incidents.length;
    this.incidents = this.incidents.filter((incident) => incident.id !== id);
    return this.incidents.length < before;
  }
  async createEvent(_userId: string, incidentId: string, input: EventInput) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return null;
    const event: IncidentEvent = { ...input, id: randomUUID(), incidentId };
    incident.events.push(event);
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString();
    return clone(event);
  }
  async updateEvent(_userId: string, incidentId: string, eventId: string, input: Partial<EventInput>) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    const event = incident?.events.find((item) => item.id === eventId);
    if (!incident || !event) return null;
    Object.assign(event, input);
    incident.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    incident.updatedAt = new Date().toISOString();
    return clone(event);
  }
  async deleteEvent(_userId: string, incidentId: string, eventId: string) {
    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident) return false;
    const before = incident.events.length;
    incident.events = incident.events.filter((event) => event.id !== eventId);
    incident.updatedAt = new Date().toISOString();
    return incident.events.length < before;
  }
  async search(_userId: string, query: string) {
    const tokens = query.toLowerCase().split(/\W+/).filter(Boolean);
    return this.incidents.map((incident) => {
      const haystack = [incident.code, incident.title, incident.summary, incident.service, ...incident.events.flatMap((event) => [event.title, event.detail, event.service])].join(" ").toLowerCase();
      const matches = tokens.filter((token) => haystack.includes(token)).length;
      return { incident: clone(incident), score: tokens.length ? matches / tokens.length : 0, matchReason: matches ? `${matches} query signal${matches === 1 ? "" : "s"} matched incident evidence` : "Related operational history" };
    }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  }
}

type Row = Record<string, unknown>;
const mapEvent = (row: Row): IncidentEvent => ({
  id: String(row.id), incidentId: String(row.incident_id), timestamp: new Date(String(row.timestamp)).toISOString(),
  service: String(row.service), kind: row.kind as IncidentEvent["kind"], title: String(row.title), detail: String(row.detail),
  impactScore: Number(row.impact_score), metadata: (row.metadata ?? {}) as Record<string, unknown>
});
const mapIncident = (row: Row, events: IncidentEvent[] = []): Incident => ({
  id: String(row.id), code: String(row.code), title: String(row.title), summary: String(row.summary), service: String(row.service),
  severity: row.severity as Incident["severity"], status: row.status as Incident["status"], owner: String(row.owner),
  startedAt: new Date(String(row.started_at)).toISOString(), resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : null,
  createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(), events
});
const mapActivity = (row: Row): Activity => ({
  id: String(row.id),
  ...(row.incident_id ? { incidentId: String(row.incident_id) } : {}),
  actor: String(row.actor), action: String(row.action), detail: String(row.detail),
  timestamp: new Date(String(row.timestamp)).toISOString()
});
const mapReplayRun = (row: Row): ReplayRun => ({
  id: String(row.id), incidentId: String(row.incident_id), name: String(row.name),
  status: row.status as ReplayRun["status"], progress: Number(row.progress),
  createdAt: new Date(String(row.created_at)).toISOString()
});

class PostgresRepository implements Repository {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }, max: 6 });
  }
  private async hydrated(userId: string, where = "", values: unknown[] = []) {
    const incidentResult = await this.pool.query(
      `select i.* from incidents i
       where exists (
         select 1 from organization_members m
         where m.organization_id = i.organization_id and m.user_id = $1
       ) ${where}
       order by i.started_at desc`,
      [userId, ...values]
    );
    if (!incidentResult.rows.length) return [];
    const ids = incidentResult.rows.map((row: Row) => row.id);
    const eventResult = await this.pool.query("select * from incident_events where incident_id = any($1::uuid[]) order by timestamp", [ids]);
    const grouped = new Map<string, IncidentEvent[]>();
    for (const row of eventResult.rows as Row[]) {
      const event = mapEvent(row);
      grouped.set(event.incidentId, [...(grouped.get(event.incidentId) ?? []), event]);
    }
    return (incidentResult.rows as Row[]).map((row) => mapIncident(row, grouped.get(String(row.id)) ?? []));
  }
  async dashboard(userId: string): Promise<DashboardData> {
    const [incidents, activities, replayRuns, serviceHealth, eventVolume] = await Promise.all([
      this.listIncidents(userId),
      this.pool.query(
        `select a.* from incident_activities a
         where exists (select 1 from organization_members m where m.organization_id = a.organization_id and m.user_id = $1)
         order by a.timestamp desc limit 20`,
        [userId]
      ),
      this.pool.query(
        `select r.* from replay_runs r
         where exists (select 1 from organization_members m where m.organization_id = r.organization_id and m.user_id = $1)
         order by r.created_at desc limit 20`,
        [userId]
      ),
      this.pool.query(
        `select * from (
           select distinct on (s.service) s.* from service_health_snapshots s
           where exists (select 1 from organization_members m where m.organization_id = s.organization_id and m.user_id = $1)
           order by s.service, s.observed_at desc
         ) latest order by case latest.state when 'critical' then 1 when 'degraded' then 2 else 3 end, latest.service`,
        [userId]
      ),
      this.pool.query(
        `select v.* from event_volume_samples v
         where exists (select 1 from organization_members m where m.organization_id = v.organization_id and m.user_id = $1)
         order by v.sampled_at asc limit 48`,
        [userId]
      )
    ]);

    return {
      incidents,
      activities: (activities.rows as Row[]).map(mapActivity),
      replayRuns: (replayRuns.rows as Row[]).map(mapReplayRun),
      serviceHealth: (serviceHealth.rows as Row[]).map((row) => ({
        service: String(row.service), availability: Number(row.availability), latencyMs: Number(row.latency_ms),
        errorRate: Number(row.error_rate), state: row.state as DashboardData["serviceHealth"][number]["state"]
      })),
      eventVolume: (eventVolume.rows as Row[]).map((row) => ({
        time: new Date(String(row.sampled_at)).toISOString().slice(11, 16),
        requests: Number(row.requests), errors: Number(row.errors)
      }))
    };
  }
  listIncidents(userId: string) { return this.hydrated(userId); }
  async getIncident(userId: string, id: string) { return (await this.hydrated(userId, "and i.id = $2", [id]))[0] ?? null; }
  async createIncident(userId: string, input: IncidentInput, embedding?: number[]) {
    const result = await this.pool.query(
      `insert into incidents (organization_id,code,title,summary,service,severity,status,owner,started_at,resolved_at,embedding)
       select m.organization_id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector
       from organization_members m where m.user_id = $1
       order by m.created_at limit 1 returning *`,
      [userId, `ROP-${Math.floor(2000 + Math.random() * 7000)}`, input.title, input.summary, input.service, input.severity, input.status, input.owner, input.startedAt, input.resolvedAt ?? null, embedding ? `[${embedding.join(",")}]` : null]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new Error("No organization membership exists for this account. Complete workspace onboarding before creating incidents.");
    return mapIncident(row);
  }
  async updateIncident(userId: string, id: string, input: Partial<IncidentInput>, embedding?: number[]) {
    const fields: Array<[string, unknown, boolean?]> = [
      ["title", input.title], ["summary", input.summary], ["service", input.service], ["severity", input.severity], ["status", input.status],
      ["owner", input.owner], ["started_at", input.startedAt], ["resolved_at", input.resolvedAt], ["embedding", embedding ? `[${embedding.join(",")}]` : undefined, true]
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown, boolean?]>;
    if (!fields.length) return this.getIncident(userId, id);
    const values = [userId, ...fields.map((entry) => entry[1])];
    const sets = fields.map(([key, , vector], index) => `${key} = $${index + 2}${vector ? "::vector" : ""}`);
    values.push(id);
    await this.pool.query(
      `update incidents i set ${sets.join(", ")}, updated_at = now()
       where i.id = $${values.length}
       and exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)`,
      values
    );
    return this.getIncident(userId, id);
  }
  async deleteIncident(userId: string, id: string) {
    return (await this.pool.query(
      `delete from incidents i where i.id = $2
       and exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)`,
      [userId, id]
    )).rowCount === 1;
  }
  async createEvent(userId: string, incidentId: string, input: EventInput) {
    if (!await this.getIncident(userId, incidentId)) return null;
    const result = await this.pool.query(`insert into incident_events (incident_id,timestamp,service,kind,title,detail,impact_score,metadata) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [incidentId, input.timestamp, input.service, input.kind, input.title, input.detail, input.impactScore, input.metadata ?? {}]);
    const row = result.rows[0] as Row | undefined;
    return row ? mapEvent(row) : null;
  }
  async updateEvent(userId: string, incidentId: string, eventId: string, input: Partial<EventInput>) {
    const fields = [["timestamp", input.timestamp], ["service", input.service], ["kind", input.kind], ["title", input.title], ["detail", input.detail], ["impact_score", input.impactScore], ["metadata", input.metadata]].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (!fields.length) return null;
    const values = [userId, ...fields.map((entry) => entry[1])];
    const sets = fields.map(([key], index) => `${key} = $${index + 2}`);
    values.push(incidentId, eventId);
    const result = await this.pool.query(
      `update incident_events e set ${sets.join(", ")}
       where e.incident_id = $${values.length - 1} and e.id = $${values.length}
       and exists (
         select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
         where i.id = e.incident_id and m.user_id = $1
       ) returning e.*`,
      values
    );
    const row = result.rows[0] as Row | undefined;
    return row ? mapEvent(row) : null;
  }
  async deleteEvent(userId: string, incidentId: string, eventId: string) {
    return (await this.pool.query(
      `delete from incident_events e where e.incident_id = $2 and e.id = $3
       and exists (
         select 1 from incidents i join organization_members m on m.organization_id = i.organization_id
         where i.id = e.incident_id and m.user_id = $1
       )`,
      [userId, incidentId, eventId]
    )).rowCount === 1;
  }
  async search(userId: string, query: string, embedding?: number[]) {
    const result = embedding
      ? await this.pool.query(
        `select i.*, 1 - (i.embedding <=> $2::vector) as score from incidents i
         where i.embedding is not null
         and exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)
         order by i.embedding <=> $2::vector limit 6`,
        [userId, `[${embedding.join(",")}]`]
      )
      : await this.pool.query(
        `select i.*, ts_rank_cd(to_tsvector('english', i.title || ' ' || i.summary || ' ' || i.service), plainto_tsquery('english', $2)) as score
         from incidents i
         where exists (select 1 from organization_members m where m.organization_id = i.organization_id and m.user_id = $1)
         and to_tsvector('english', i.title || ' ' || i.summary || ' ' || i.service) @@ plainto_tsquery('english', $2)
         order by score desc limit 6`,
        [userId, query]
      );
    const hydrated = await Promise.all((result.rows as Row[]).map((row) => this.getIncident(userId, String(row.id))));
    return hydrated.flatMap((incident, index) => incident ? [{ incident, score: Number((result.rows[index] as Row | undefined)?.score ?? 0), matchReason: embedding ? "Semantic similarity across incident evidence" : "Full-text match across incident evidence" }] : []);
  }
}

export const repository: Repository = config.databaseUrl ? new PostgresRepository(config.databaseUrl) : new MemoryRepository();
