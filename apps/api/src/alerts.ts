import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Pool } from "pg";
import { config } from "./config.js";
import { badRequest, notFound } from "./errors.js";
import type { Severity } from "./types.js";
import { workspaceService } from "./workspace.js";

/**
 * Outbound alerting: tell people when an incident opens or changes state, in the tools they already
 * watch. Slack and Discord incoming webhooks and plain HTTPS webhooks are all free to use.
 */
export type AlertChannelKind = "slack" | "discord" | "webhook";
export type AlertEventType = "opened" | "monitoring" | "resolved" | "reopened";
export const alertEventTypes: AlertEventType[] = ["opened", "monitoring", "resolved", "reopened"];

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  /** Masked: the full URL is a credential and is never returned after creation. */
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
export interface AlertEvent { type: AlertEventType | "test"; incident: AlertIncident; detail?: string; actor?: string }

type StoredChannel = Omit<AlertChannel, "target" | "signingSecret"> & { organizationId: string; url: string };
type Row = Record<string, unknown>;

const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const headline: Record<AlertEvent["type"], string> = {
  opened: "Incident opened", monitoring: "Fix applied, monitoring recovery", resolved: "Incident resolved", reopened: "Incident reopened", test: "Test alert"
};
const emoji: Record<AlertEvent["type"], string> = { opened: "🚨", monitoring: "🩺", resolved: "✅", reopened: "🔁", test: "🔔" };

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

/** Rejects destinations that would let a workspace member make the API call internal hosts (SSRF). */
export function validateChannelUrl(kind: AlertChannelKind, raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest("Enter a full https:// URL."); }
  if (url.protocol !== "https:") throw badRequest("Alert destinations must use https://.");
  if (url.username || url.password) throw badRequest("Put credentials in the URL path or query, not before the host.");
  const host = url.hostname.toLowerCase();
  if (kind === "slack" && host !== "hooks.slack.com") throw badRequest("Slack incoming webhooks start with https://hooks.slack.com/.");
  if (kind === "discord" && (!["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(host) || !url.pathname.startsWith("/api/webhooks/"))) throw badRequest("Discord webhooks look like https://discord.com/api/webhooks/….");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || isPrivateAddress(host)) throw badRequest("Alert destinations must be public internet hosts.");
  return url;
}

export const maskUrl = (raw: string) => {
  // Webhook URLs carry their secret in the path, so only ever show the host and a short tail.
  try { const url = new URL(raw); return `${url.host}/…${url.pathname.length > 12 ? url.pathname.slice(-4) : ""}`; } catch { return "configured"; }
};

// Slack treats <, > and & as control characters (links, @channel); escape untrusted titles.
const slackText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const discordText = (value: string) => value.replace(/([\\`*_~|[\]()>#@])/g, "\\$1");

/** Builds the request body for one destination. Pure, so formatting is unit-tested without a network. */
export function formatAlert(kind: AlertChannelKind, event: AlertEvent, occurredAt = new Date().toISOString()) {
  const { incident } = event;
  const link = incidentUrl(incident);
  const context = [incident.service, incident.environment && incident.environment !== "unknown" ? incident.environment : null, `severity ${incident.severity}`].filter(Boolean).join(" · ");
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
  event.type === "test" || (channel.enabled && channel.events.includes(event.type) && severityRank[event.incident.severity] >= severityRank[channel.minSeverity]);

const mapRow = (row: Row): StoredChannel => ({
  id: String(row.id), organizationId: String(row.organization_id), name: String(row.name), kind: row.kind as AlertChannelKind, url: String(row.url),
  events: (row.events as AlertEventType[]) ?? alertEventTypes, minSeverity: row.min_severity as Severity, enabled: Boolean(row.enabled),
  lastStatus: (row.last_status as AlertChannel["lastStatus"]) ?? null, lastError: row.last_error ? String(row.last_error) : null,
  lastSentAt: row.last_sent_at ? new Date(String(row.last_sent_at)).toISOString() : null, createdAt: new Date(String(row.created_at)).toISOString()
});
const publicView = ({ url, organizationId: _org, ...channel }: StoredChannel, revealSecret = false): AlertChannel => ({
  ...channel, target: maskUrl(url), ...(channel.kind === "webhook" && revealSecret ? { signingSecret: alertSigningSecret(channel.id) } : {})
});

class AlertService {
  private pool?: Pool;
  private memory: StoredChannel[] = [];

  constructor() {
    if (config.databaseUrl) this.pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }, max: 2 });
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`
      create table if not exists alert_channels (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
        name text not null, kind text not null check (kind in ('slack','discord','webhook')), url text not null,
        events text[] not null default '{opened,monitoring,resolved,reopened}', min_severity text not null default 'low' check (min_severity in ('low','medium','high','critical')),
        enabled boolean not null default true, last_status text, last_error text, last_sent_at timestamptz,
        created_by uuid, created_at timestamptz not null default now()
      );
      create index if not exists alert_channels_org_idx on alert_channels(organization_id);
      alter table alert_channels enable row level security;
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
    const url = validateChannelUrl(input.kind, input.url).toString();
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
    const outcome = await this.deliver(channel, { type: "test", incident: sample, detail: "If you can read this, incident alerts will arrive here.", actor });
    return { ...publicView({ ...channel, ...outcome }, context.role === "admin"), delivered: outcome.lastStatus === "delivered" };
  }

  /** Fan out one incident event to every matching destination. Never throws: alerting must not break ingestion or a lifecycle change. */
  async dispatch(organizationId: string, event: AlertEvent) {
    try {
      const channels = !this.pool
        ? this.memory.filter((item) => item.organizationId === organizationId)
        : ((await this.pool.query(`select * from alert_channels where organization_id=$1 and enabled`, [organizationId])).rows as Row[]).map(mapRow);
      await Promise.all(channels.filter((channel) => channelWantsEvent(channel, event)).map((channel) => this.deliver(channel, event)));
    } catch (error) {
      console.error("Alert dispatch failed", error instanceof Error ? error.message : error);
    }
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

  private async deliver(channel: StoredChannel, event: AlertEvent) {
    const sentAt = new Date().toISOString();
    let lastStatus: "delivered" | "failed" = "failed";
    let lastError: string | null = null;
    try {
      const url = validateChannelUrl(channel.kind, channel.url);
      // Re-check DNS at send time so a public name can't be pointed at an internal address later.
      const addresses = await lookup(url.hostname, { all: true });
      if (addresses.some((item) => isPrivateAddress(item.address))) throw new Error("Destination resolves to a private network address.");
      const body = JSON.stringify(formatAlert(channel.kind, event, sentAt));
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "ReplayOps-Alerts/1" };
      if (channel.kind === "webhook") { headers["x-replayops-event"] = event.type; headers["x-replayops-signature"] = signAlertBody(channel.id, body); }
      const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.ok) lastStatus = "delivered";
      else lastError = `${response.status} ${(await response.text().catch(() => "")).slice(0, 160) || response.statusText}`.trim();
    } catch (error) {
      const code = (error as { code?: string }).code;
      lastError = !(error instanceof Error) ? "Delivery failed."
        : error.name === "TimeoutError" ? "Destination did not answer within 5 seconds."
          : code === "ENOTFOUND" ? "Host not found. Check the webhook URL."
            : code === "ECONNREFUSED" ? "Connection refused by the destination."
              : error.message;
    }
    if (!this.pool) Object.assign(channel, { lastStatus, lastError, lastSentAt: sentAt });
    else await this.pool.query(`update alert_channels set last_status=$2,last_error=$3,last_sent_at=$4 where id=$1`, [channel.id, lastStatus, lastError, sentAt]).catch(() => undefined);
    return { lastStatus, lastError, lastSentAt: sentAt };
  }
}

export const alertService = new AlertService();
