import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Pool } from "pg";
import { config } from "./config.js";
import { badRequest, notFound } from "./errors.js";
import { sendAlertEmail } from "./mailer.js";
import type { Severity } from "./types.js";
import { workspaceService } from "./workspace.js";

/**
 * Outbound alerting: tell people when an incident opens or changes state, in the tools they already
 * watch. Email (Resend free tier), phone push (ntfy), Slack and Discord incoming webhooks, and plain
 * HTTPS webhooks are all free to use.
 */
export type AlertChannelKind = "email" | "ntfy" | "slack" | "discord" | "webhook";
export type AlertEventType = "opened" | "monitoring" | "resolved" | "reopened";
export const alertEventTypes: AlertEventType[] = ["opened", "monitoring", "resolved", "reopened"];

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  /** Masked: a webhook URL is a credential and is never returned after creation. For email, the recipients. */
  target: string;
  events: AlertEventType[];
  minSeverity: Severity;
  enabled: boolean;
  lastStatus: "delivered" | "failed" | null;
  lastError: string | null;
  lastSentAt: string | null;
  createdAt: string;
  /** Only for generic webhooks: the HMAC key receivers use to verify `x-replayops-signature`. */
  signingSecret?: string;
}
export interface AlertChannelInput { name: string; kind: AlertChannelKind; url: string; events: AlertEventType[]; minSeverity: Severity; enabled?: boolean }
export interface AlertIncident { id: string; code: string; title: string; service: string; environment?: string; severity: Severity; status: string }
/** "escalated" is delivered to destinations that subscribe to "opened": it is the same "this needs attention now" signal. */
export interface AlertEvent { type: AlertEventType | "escalated" | "test"; incident: AlertIncident; detail?: string; actor?: string }

type StoredChannel = Omit<AlertChannel, "target" | "signingSecret"> & { organizationId: string; url: string };
type Row = Record<string, unknown>;

const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const headline: Record<AlertEvent["type"], string> = {
  opened: "Incident opened", escalated: "Incident escalated", monitoring: "Fix applied, monitoring recovery", resolved: "Incident resolved", reopened: "Incident reopened", test: "Test alert"
};
const emoji: Record<AlertEvent["type"], string> = { opened: "🚨", escalated: "⬆️", monitoring: "🩺", resolved: "✅", reopened: "🔁", test: "🔔" };

const webBaseUrl = () => config.publicWebUrl ?? config.webOrigin.split(",")[0]?.trim() ?? "http://localhost:5173";
export const incidentUrl = (incident: AlertIncident) => `${webBaseUrl()}/incidents/${incident.id}`;

const signingKey = () => config.ingestionSigningSecret ?? (process.env.NODE_ENV !== "production" ? "replayops-local-connector-secret" : "");
export const alertSigningSecret = (channelId: string) => createHmac("sha256", signingKey()).update(`replayops:alert:${channelId}`).digest("hex");
export const signAlertBody = (channelId: string, body: string) => `sha256=${createHmac("sha256", alertSigningSecret(channelId)).update(body).digest("hex")}`;

const privateV4 = (address: string) => {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
};
export const isPrivateAddress = (address: string) => {
  const value = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(value) === 4) return privateV4(value);
  if (isIP(value) === 6) return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80") || (value.startsWith("::ffff:") && privateV4(value.slice(7)));
  return false;
};

const emailPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** Email destinations are stored as `mailto:a@x.com,b@y.com`; returns the cleaned recipient list. */
export function parseRecipients(raw: string) {
  const recipients = [...new Set(raw.replace(/^mailto:/i, "").split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (!recipients.length) throw badRequest("Enter at least one email address.");
  if (recipients.length > 10) throw badRequest("Use at most 10 email addresses per destination.");
  const invalid = recipients.find((item) => !emailPattern.test(item));
  if (invalid) throw badRequest(`“${invalid}” is not a valid email address.`);
  return recipients;
}

/** Normalizes what the user typed into the stored destination string, validating it for its kind. */
export function normalizeDestination(kind: AlertChannelKind, raw: string) {
  if (kind === "email") return `mailto:${parseRecipients(raw).join(",")}`;
  return validateChannelUrl(kind, raw).toString();
}

/** Rejects destinations that would let a workspace member make the API call internal hosts (SSRF). */
export function validateChannelUrl(kind: AlertChannelKind, raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest("Enter a full https:// URL."); }
  if (url.protocol !== "https:") throw badRequest("Alert destinations must use https://.");
  if (url.username || url.password) throw badRequest("Put credentials in the URL path or query, not before the host.");
  const host = url.hostname.toLowerCase();
  if (kind === "slack" && host !== "hooks.slack.com") throw badRequest("Slack incoming webhooks start with https://hooks.slack.com/.");
  if (kind === "ntfy" && !/^\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)) throw badRequest("ntfy destinations look like https://ntfy.sh/your-secret-topic.");
  if (kind === "discord" && (!["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(host) || !url.pathname.startsWith("/api/webhooks/"))) throw badRequest("Discord webhooks look like https://discord.com/api/webhooks/….");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || isPrivateAddress(host)) throw badRequest("Alert destinations must be public internet hosts.");
  return url;
}

export const maskUrl = (raw: string) => {
  if (raw.startsWith("mailto:")) return raw.slice(7).split(",").join(", ");
  // Webhook URLs carry their secret in the path, so only ever show the host and a short tail.
  try { const url = new URL(raw); return `${url.host}/…${url.pathname.length > 12 ? url.pathname.slice(-4) : ""}`; } catch { return "configured"; }
};

// Slack treats <, > and & as control characters (links, @channel); escape untrusted titles.
const slackText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const discordText = (value: string) => value.replace(/([\\`*_~|[\]()>#@])/g, "\\$1");

/** Builds the request body for one destination. Pure, so formatting is unit-tested without a network. */
const alertContext = (incident: AlertIncident) => [incident.service, incident.environment && incident.environment !== "unknown" ? incident.environment : null, `severity ${incident.severity}`].filter(Boolean).join(" · ");

/** Plain-text pieces shared by email and phone push. */
export function plainAlert(event: AlertEvent) {
  const { incident } = event;
  const heading = `${headline[event.type]}: ${incident.code} ${incident.title}`;
  const lines = [alertContext(incident), event.detail?.trim().slice(0, 600), event.actor ? `By ${event.actor}` : undefined].filter((line): line is string => Boolean(line));
  return { subject: `${emoji[event.type]} ${heading}`, heading, lines, link: incidentUrl(incident), text: [heading, ...lines, `Open the investigation: ${incidentUrl(incident)}`].join("\n") };
}

/** ntfy push: plain-text body plus headers; critical incidents use urgent priority so the phone rings through. */
export function ntfyRequest(event: AlertEvent) {
  const plain = plainAlert(event);
  const priority = event.type === "opened" || event.type === "reopened" || event.type === "escalated" ? (event.incident.severity === "critical" ? "urgent" : event.incident.severity === "high" ? "high" : "default") : "default";
  // HTTP headers must be Latin-1; keep the title ASCII and leave emoji to the tags.
  const title = plain.heading.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const tags = { opened: "rotating_light", escalated: "arrow_up", monitoring: "stethoscope", resolved: "white_check_mark", reopened: "repeat", test: "bell" }[event.type];
  return { body: plain.lines.join("\n") || plain.heading, headers: { Title: title, Priority: priority, Tags: tags, Click: plain.link, "Content-Type": "text/plain; charset=utf-8" } };
}

export function formatAlert(kind: AlertChannelKind, event: AlertEvent, occurredAt = new Date().toISOString()) {
  const { incident } = event;
  const link = incidentUrl(incident);
  const context = alertContext(incident);
  const detail = event.detail?.trim().slice(0, 600);
  if (kind === "slack") {
    const lines = [`${emoji[event.type]} *${headline[event.type]}: <${link}|${slackText(incident.code)} ${slackText(incident.title)}>*`, context, detail ? slackText(detail) : null, event.actor ? `_by ${slackText(event.actor)}_` : null].filter(Boolean);
    return { text: lines.join("\n"), unfurl_links: false };
  }
  if (kind === "discord") {
    const lines = [`${emoji[event.type]} **${headline[event.type]}: [${discordText(incident.code)} ${discordText(incident.title)}](${link})**`, context, detail ? discordText(detail) : null, event.actor ? `*by ${discordText(event.actor)}*` : null].filter(Boolean);
    return { content: lines.join("\n").slice(0, 1900), allowed_mentions: { parse: [] } };
  }
  return { event: event.type === "test" ? "test" : `incident.${event.type}`, occurredAt, incident: { ...incident, url: link }, detail: detail ?? null, actor: event.actor ?? null };
}

export const channelWantsEvent = (channel: Pick<AlertChannel, "enabled" | "events" | "minSeverity">, event: AlertEvent) =>
  event.type === "test" || (channel.enabled && channel.events.includes(event.type === "escalated" ? "opened" : event.type) && severityRank[event.incident.severity] >= severityRank[channel.minSeverity]);

const mapRow = (row: Row): StoredChannel => ({
  id: String(row.id), organizationId: String(row.organization_id), name: String(row.name), kind: row.kind as AlertChannelKind, url: String(row.url),
  events: (row.events as AlertEventType[]) ?? alertEventTypes, minSeverity: row.min_severity as Severity, enabled: Boolean(row.enabled),
  lastStatus: (row.last_status as AlertChannel["lastStatus"]) ?? null, lastError: row.last_error ? String(row.last_error) : null,
  lastSentAt: row.last_sent_at ? new Date(String(row.last_sent_at)).toISOString() : null, createdAt: new Date(String(row.created_at)).toISOString()
});
const mapOutbox = (row: Row): OutboxEntry => ({
  id: String(row.id), organizationId: String(row.organization_id), channelId: String(row.channel_id), event: row.event as AlertEvent, attempts: Number(row.attempts),
  status: row.status as OutboxEntry["status"], nextAttemptAt: new Date(String(row.next_attempt_at)).toISOString(), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString()
});
const publicView = ({ url, organizationId: _org, ...channel }: StoredChannel, revealSecret = false): AlertChannel => ({
  ...channel, target: maskUrl(url), ...(channel.kind === "webhook" && revealSecret ? { signingSecret: alertSigningSecret(channel.id) } : {})
});

/** A failed send; `retryable` marks network blips, timeouts, rate limits, and provider 5xx. */
class DeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = "DeliveryError"; }
}

const networkCodes: Record<string, string> = {
  ENOTFOUND: "Host not found. Check the URL.", EAI_AGAIN: "DNS lookup failed temporarily.", ECONNREFUSED: "Connection refused by the destination.",
  ECONNRESET: "Connection reset by the destination.", ETIMEDOUT: "Connection timed out.", EPIPE: "Connection closed while sending.",
  UND_ERR_CONNECT_TIMEOUT: "Connection timed out.", UND_ERR_SOCKET: "Connection closed unexpectedly.", CERT_HAS_EXPIRED: "The destination's TLS certificate has expired."
};
/** Turns undici's opaque "fetch failed" into the underlying reason, and says whether trying again could help. */
export function describeDeliveryError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof DeliveryError) return { message: error.message, retryable: error.retryable };
  if (!(error instanceof Error)) return { message: "Delivery failed.", retryable: true };
  if (error.name === "TimeoutError" || error.name === "AbortError") return { message: "Destination did not answer within 5 seconds.", retryable: true };
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = (error as { code?: string }).code ?? cause?.code;
  if (code && networkCodes[code]) return { message: `${networkCodes[code]} (${code})`, retryable: code !== "ENOTFOUND" && code !== "CERT_HAS_EXPIRED" };
  if (error.message === "fetch failed") return { message: `Network error: ${cause?.message ?? code ?? "the request did not complete"}.`, retryable: true };
  return { message: error.message, retryable: false };
}

/** An alert waiting to be delivered. Written before the first send, so a crash or restart never loses it. */
interface OutboxEntry { id: string; organizationId: string; channelId: string; event: AlertEvent; attempts: number; status: "pending" | "sending"; nextAttemptAt: string; createdAt: string; updatedAt: string }

class AlertService {
  /** Quick in-process retries for blips; a test can shorten them. */
  retryDelaysMs = [1_000, 4_000];
  /** Later retries from the outbox, after the quick ones fail: 30 s, 2 min, 10 min, 30 min, 2 h. */
  outboxDelaysMs = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
  private inFlight = new Set<Promise<unknown>>();
  private pool?: Pool;
  private memory: StoredChannel[] = [];
  private memoryOutbox: OutboxEntry[] = [];

  constructor() {
    if (config.databaseUrl) this.pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }, max: 2 });
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`
      create table if not exists alert_channels (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        name text not null, kind text not null, url text not null,
        events text[] not null default '{opened,monitoring,resolved,reopened}', min_severity text not null default 'low' check (min_severity in ('low','medium','high','critical')),
        enabled boolean not null default true, last_status text, last_error text, last_sent_at timestamptz,
        created_by uuid, created_at timestamptz not null default now()
      );
      create index if not exists alert_channels_org_idx on alert_channels(organization_id);
      alter table alert_channels drop constraint if exists alert_channels_kind_check;
      alter table alert_channels add constraint alert_channels_kind_check check (kind in ('email','ntfy','slack','discord','webhook'));
      alter table alert_channels enable row level security;
      create table if not exists alert_outbox (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        channel_id uuid not null references alert_channels(id) on delete cascade, event jsonb not null,
        attempts integer not null default 0, status text not null default 'pending' check (status in ('pending','sending')),
        next_attempt_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create index if not exists alert_outbox_due_idx on alert_outbox(status, next_attempt_at);
      alter table alert_outbox enable row level security;
    `);
  }

  async list(userId: string) {
    const context = await workspaceService.context(userId);
    const reveal = context.role === "admin";
    if (!this.pool) return this.memory.filter((item) => item.organizationId === context.organizationId).map((item) => publicView(item, reveal));
    const result = await this.pool.query(`select * from alert_channels where organization_id=$1 order by created_at`, [context.organizationId]);
    return (result.rows as Row[]).map((row) => publicView(mapRow(row), reveal));
  }

  async create(userId: string, actor: string, input: AlertChannelInput) {
    const context = await workspaceService.assertRole(userId, ["admin"]);
    const url = normalizeDestination(input.kind, input.url);
    const events = [...new Set(input.events)];
    let stored: StoredChannel;
    if (!this.pool) {
      stored = { id: randomUUID(), organizationId: context.organizationId, name: input.name, kind: input.kind, url, events, minSeverity: input.minSeverity, enabled: input.enabled ?? true, lastStatus: null, lastError: null, lastSentAt: null, createdAt: new Date().toISOString() };
      this.memory.push(stored);
    } else {
      const result = await this.pool.query(`insert into alert_channels(organization_id,name,kind,url,events,min_severity,enabled,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [context.organizationId, input.name, input.kind, url, events, input.minSeverity, input.enabled ?? true, userId]);
      stored = mapRow(result.rows[0] as Row);
    }
    await workspaceService.audit(userId, actor, "added alert destination", "alert-channel", stored.id, { name: input.name, kind: input.kind, target: maskUrl(url), events, minSeverity: input.minSeverity });
    return publicView(stored, true);
  }

  async update(userId: string, actor: string, id: string, input: Partial<Pick<AlertChannelInput, "events" | "minSeverity" | "enabled">>) {
    const context = await workspaceService.assertRole(userId, ["admin"]);
    const current = await this.find(context.organizationId, id);
    const next = { ...current, events: input.events ? [...new Set(input.events)] : current.events, minSeverity: input.minSeverity ?? current.minSeverity, enabled: input.enabled ?? current.enabled };
    if (!this.pool) Object.assign(current, next);
    else await this.pool.query(`update alert_channels set events=$3,min_severity=$4,enabled=$5 where organization_id=$1 and id=$2`, [context.organizationId, id, next.events, next.minSeverity, next.enabled]);
    await workspaceService.audit(userId, actor, "updated alert destination", "alert-channel", id, { name: current.name, events: next.events, minSeverity: next.minSeverity, enabled: next.enabled });
    return publicView(next, true);
  }

  async remove(userId: string, actor: string, id: string) {
    const context = await workspaceService.assertRole(userId, ["admin"]);
    const current = await this.find(context.organizationId, id);
    if (!this.pool) this.memory = this.memory.filter((item) => item.id !== id);
    else await this.pool.query(`delete from alert_channels where organization_id=$1 and id=$2`, [context.organizationId, id]);
    await workspaceService.audit(userId, actor, "removed alert destination", "alert-channel", id, { name: current.name, kind: current.kind });
  }

  /** Sends a sample alert to one destination and reports the provider's answer directly. */
  async test(userId: string, actor: string, id: string) {
    const context = await workspaceService.assertRole(userId, ["admin", "responder"]);
    const channel = await this.find(context.organizationId, id);
    const sample: AlertIncident = { id: "00000000-0000-4000-8000-000000000000", code: "TEST", title: "ReplayOps alert destination check", service: "replayops", environment: "test", severity: "low", status: "investigating" };
    // A test is sent directly, never queued for later: the admin is waiting for the answer.
    const { retryable: _retryable, ...outcome } = await this.deliver(channel, { type: "test", incident: sample, detail: "If you can read this, incident alerts will arrive here.", actor });
    return { ...publicView({ ...channel, ...outcome }, context.role === "admin"), delivered: outcome.lastStatus === "delivered" };
  }

  /** Fan out one incident event to every matching destination. Never throws: alerting must not break ingestion or a lifecycle change. */
  async dispatch(organizationId: string, event: AlertEvent) {
    try {
      const channels = !this.pool
        ? this.memory.filter((item) => item.organizationId === organizationId)
        : ((await this.pool.query(`select * from alert_channels where organization_id=$1 and enabled`, [organizationId])).rows as Row[]).map(mapRow);
      await Promise.all(channels.filter((channel) => channelWantsEvent(channel, event)).map(async (channel) => this.track(this.attempt(await this.enqueue(channel, event), channel))));
    } catch (error) {
      console.error("Alert dispatch failed", error instanceof Error ? error.message : error);
    }
  }

  private async enqueue(channel: StoredChannel, event: AlertEvent): Promise<OutboxEntry> {
    const now = new Date().toISOString();
    if (!this.pool) {
      const entry: OutboxEntry = { id: randomUUID(), organizationId: channel.organizationId, channelId: channel.id, event, attempts: 0, status: "sending", nextAttemptAt: now, createdAt: now, updatedAt: now };
      this.memoryOutbox.push(entry);
      return entry;
    }
    const row = (await this.pool.query(`insert into alert_outbox(organization_id,channel_id,event,status) values($1,$2,$3,'sending') returning *`, [channel.organizationId, channel.id, event])).rows[0] as Row;
    return mapOutbox(row);
  }

  /**
   * One delivery round for an outbox entry: the quick in-process retries, then either done (delivered, or a
   * failure retrying can't fix) or scheduled for a later round. Every alert is delivered at least once.
   */
  private async attempt(entry: OutboxEntry, channel: StoredChannel) {
    const outcome = await this.deliver(channel, entry.event, entry.createdAt, entry.id);
    const attempts = entry.attempts + 1;
    const delay = outcome.lastStatus === "failed" && outcome.retryable ? this.outboxDelaysMs[attempts - 1] : undefined;
    if (delay === undefined) {
      if (outcome.lastStatus === "failed" && outcome.retryable) await this.recordStatus(channel, { ...outcome, lastError: `${outcome.lastError} Gave up after ${attempts} delivery rounds.` });
      if (!this.pool) this.memoryOutbox = this.memoryOutbox.filter((item) => item.id !== entry.id);
      else await this.pool.query(`delete from alert_outbox where id=$1`, [entry.id]).catch(() => undefined);
      return outcome;
    }
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    await this.recordStatus(channel, { ...outcome, lastError: `${outcome.lastError} Retrying at ${nextAttemptAt.slice(11, 16)} UTC.` });
    if (!this.pool) Object.assign(entry, { attempts, status: "pending", nextAttemptAt, updatedAt: new Date().toISOString() });
    else await this.pool.query(`update alert_outbox set attempts=$2,status='pending',next_attempt_at=$3,updated_at=now() where id=$1`, [entry.id, attempts, nextAttemptAt]).catch(() => undefined);
    return outcome;
  }

  /**
   * Sends alerts whose retry time has come, and picks up any a crashed or restarted server left mid-send.
   * Runs on a timer; safe to run on several API instances at once.
   */
  async processOutbox(limit = 20, now = new Date()) {
    let due: OutboxEntry[];
    if (!this.pool) {
      for (const entry of this.memoryOutbox) if (entry.status === "sending" && now.getTime() - Date.parse(entry.updatedAt) > 120_000) entry.status = "pending";
      due = this.memoryOutbox.filter((entry) => entry.status === "pending" && Date.parse(entry.nextAttemptAt) <= now.getTime()).slice(0, limit);
      for (const entry of due) Object.assign(entry, { status: "sending", updatedAt: now.toISOString() });
    } else {
      await this.pool.query(`update alert_outbox set status='pending' where status='sending' and updated_at < now() - interval '2 minutes'`);
      due = ((await this.pool.query(
        `update alert_outbox set status='sending',updated_at=now() where id in (
           select id from alert_outbox where status='pending' and next_attempt_at <= $2 order by next_attempt_at limit $1 for update skip locked
         ) returning *`, [limit, now.toISOString()])).rows as Row[]).map(mapOutbox);
    }
    for (const entry of due) {
      const channel = await this.find(entry.organizationId, entry.channelId).catch(() => undefined);
      if (!channel || !channel.enabled) {
        if (!this.pool) this.memoryOutbox = this.memoryOutbox.filter((item) => item.id !== entry.id);
        else await this.pool.query(`delete from alert_outbox where id=$1`, [entry.id]);
        continue;
      }
      await this.track(this.attempt(entry, channel)).catch(() => undefined);
    }
    return due.length;
  }

  /** Alerts still waiting for a later delivery round (for tests and diagnostics). */
  async pendingAlerts() {
    if (!this.pool) return structuredClone(this.memoryOutbox);
    return ((await this.pool.query(`select * from alert_outbox order by next_attempt_at`)).rows as Row[]).map(mapOutbox);
  }

  /** Lets a shutting-down server finish sending alerts it has already started, up to a time limit. */
  async drain(timeoutMs = 10_000) {
    if (!this.inFlight.size) return;
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  private track<T>(promise: Promise<T>) {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  async dispatchForUser(userId: string, event: AlertEvent) {
    try { const context = await workspaceService.context(userId); await this.dispatch(context.organizationId, event); } catch { /* alerting is best effort */ }
  }

  private async find(organizationId: string, id: string) {
    if (!this.pool) {
      const found = this.memory.find((item) => item.organizationId === organizationId && item.id === id);
      if (!found) throw notFound("Alert destination not found.");
      return found;
    }
    const result = await this.pool.query(`select * from alert_channels where organization_id=$1 and id=$2`, [organizationId, id]);
    if (!result.rows[0]) throw notFound("Alert destination not found.");
    return mapRow(result.rows[0] as Row);
  }

  /** Sends one alert; throws with a human-readable reason when the destination did not accept it. */
  private async send(channel: StoredChannel, event: AlertEvent, sentAt: string, deliveryId?: string) {
    if (channel.kind === "email") {
      const plain = plainAlert(event);
      const sent = await sendAlertEmail({ to: parseRecipients(channel.url), subject: plain.subject, text: plain.text, heading: plain.heading, lines: plain.lines, linkUrl: plain.link, linkLabel: "Open the investigation", idempotencyKey: `replayops-alert/${channel.id}/${event.incident.id}/${event.type}/${sentAt}` });
      if (!sent.ok) throw new DeliveryError(sent.error ?? "Email delivery failed.", /timed out|could not be reached|HTTP (429|5\d\d)/.test(sent.error ?? ""));
      return;
    }
    const url = validateChannelUrl(channel.kind, channel.url);
    // Re-check DNS at send time so a public name can't be pointed at an internal address later.
    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.some((item) => isPrivateAddress(item.address))) throw new DeliveryError("Destination resolves to a private network address.", false);
    let body: string;
    const headers: Record<string, string> = { "user-agent": "ReplayOps-Alerts/1" };
    if (channel.kind === "ntfy") {
      const push = ntfyRequest(event);
      body = push.body;
      Object.assign(headers, push.headers);
    } else {
      body = JSON.stringify(formatAlert(channel.kind, event, sentAt));
      headers["content-type"] = "application/json";
      if (channel.kind === "webhook") { headers["x-replayops-event"] = event.type; headers["x-replayops-signature"] = signAlertBody(channel.id, body); if (deliveryId) headers["x-replayops-delivery"] = deliveryId; }
    }
    const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new DeliveryError(`${response.status} ${(await response.text().catch(() => "")).slice(0, 160) || response.statusText}`.trim(), response.status === 429 || response.status >= 500);
  }

  private async deliver(channel: StoredChannel, event: AlertEvent, sentAt = new Date().toISOString(), deliveryId?: string) {
    let lastStatus: "delivered" | "failed" = "failed";
    let lastError: string | null = null;
    let retryable = false;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        await this.send(channel, event, sentAt, deliveryId);
        lastStatus = "delivered";
        lastError = null;
        retryable = false;
        break;
      } catch (error) {
        const described = describeDeliveryError(error);
        lastError = attempt ? `${described.message} (after ${attempt + 1} attempts)` : described.message;
        retryable = described.retryable;
        if (!described.retryable || attempt === this.retryDelaysMs.length) break;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt]));
      }
    }
    if (lastStatus === "failed") console.warn(`Alert to ${channel.kind} destination ${channel.id} failed: ${lastError}`);
    const outcome = { lastStatus, lastError, lastSentAt: new Date().toISOString(), retryable };
    await this.recordStatus(channel, outcome);
    return outcome;
  }

  private async recordStatus(channel: StoredChannel, outcome: { lastStatus: "delivered" | "failed"; lastError: string | null; lastSentAt: string }) {
    if (!this.pool) Object.assign(channel, { lastStatus: outcome.lastStatus, lastError: outcome.lastError, lastSentAt: outcome.lastSentAt });
    else await this.pool.query(`update alert_channels set last_status=$2,last_error=$3,last_sent_at=$4 where id=$1`, [channel.id, outcome.lastStatus, outcome.lastError, outcome.lastSentAt]).catch(() => undefined);
  }
}

export const alertService = new AlertService();
