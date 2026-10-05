import { createHash } from "node:crypto";
import type { Incident, IncidentEvent } from "./types.js";

/**
 * Exception grouping. Thousands of error events usually come from a handful of bugs; grouping them by a
 * stable fingerprint shows which errors are new, how often they happen, and whether they started right
 * after a change.
 */
export interface ExceptionInfo { fingerprint: string; type: string; message: string; topFrame: string | null; stack: string | null }
export interface ErrorGroup {
  fingerprint: string; type: string; message: string; topFrame: string | null; stack: string | null; services: string[];
  count: number; firstSeen: string; lastSeen: string; sampleEventId: string;
  /** Earliest sighting anywhere in the workspace's retained evidence. */
  firstSeenInWorkspace: string;
  /** The change this error first appeared after, when it had never been seen before that change. */
  newSince: { eventId: string; title: string; timestamp: string } | null;
}

type Record_ = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const object = (value: unknown): Record_ => value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : {};

/** Replaces the parts of a message that vary per occurrence, so the same bug always groups together. */
export function normalizeMessage(message: string) {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/(["'`])(?:(?!\1).){1,80}\1/g, "<str>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const vendorFrame = /node_modules|node:internal|internal\/|site-packages|dist-packages|<anonymous>|java\.base\/|kotlin\.|runtime\/|\(native\)/;
/** First application frame of a stack trace, with line/column numbers removed so a redeploy doesn't split groups. */
export function topFrameOf(stack: string | null | undefined) {
  if (!stack) return null;
  const frames = stack.split("\n").map((line) => line.trim()).filter((line) => /^at\s|^File\s"|\.(?:js|ts|py|go|java|rb|kt|cs|php):\d+|\(\S+:\d+(?::\d+)?\)$/.test(line));
  const frame = frames.find((line) => !vendorFrame.test(line)) ?? frames[0];
  return frame ? frame.replace(/:\d+(?::\d+)?\)?$/, "").replace(/, line \d+/, "").replace(/^at\s+/, "").replace(/\s+\($/, "").slice(0, 200) : null;
}

export function fingerprintException(service: string, type: string, message: string, stack?: string | null): ExceptionInfo {
  const cleanType = type.trim().slice(0, 120) || "Error";
  const topFrame = topFrameOf(stack);
  // With a stack, the bug's location identifies it; the message only disambiguates frameless errors.
  const identity = topFrame ? [service, cleanType, topFrame] : [service, cleanType, normalizeMessage(message)];
  return {
    fingerprint: createHash("sha256").update(identity.join("|")).digest("hex").slice(0, 16),
    type: cleanType, message: message.trim().slice(0, 500), topFrame,
    stack: stack ? stack.split("\n").slice(0, 25).join("\n").slice(0, 4000) : null
  };
}

/** Reads OpenTelemetry semantic-convention attributes (`exception.type`, `exception.message`, `exception.stacktrace`). */
export function exceptionFromAttributes(service: string, attributes: Record_): ExceptionInfo | null {
  const type = text(attributes["exception.type"]);
  const message = text(attributes["exception.message"]);
  if (!type && !message) return null;
  return fingerprintException(service, type || "Error", message, text(attributes["exception.stacktrace"]) || null);
}

/** Generic JSON: `error`/`exception` objects ({type|name, message, stack}) or flat errorType/errorMessage/stack fields. */
export function exceptionFromGeneric(service: string, input: Record_): ExceptionInfo | null {
  const nested = object(input.error ?? input.exception);
  const type = text(nested.type ?? nested.name ?? nested.class ?? input.errorType ?? input.exceptionType);
  const message = text(nested.message ?? nested.value ?? input.errorMessage ?? (typeof input.error === "string" ? input.error : ""));
  const stack = text(nested.stack ?? nested.stacktrace ?? nested.stackTrace ?? input.stack ?? input.stacktrace) || null;
  if (!type && !message) return null;
  return fingerprintException(service, type || "Error", message, stack);
}

const exceptionOf = (event: IncidentEvent) => {
  const value = object(event.metadata?.exception);
  return typeof value.fingerprint === "string" ? value as unknown as ExceptionInfo : null;
};

/** Groups an incident's exceptions and marks the ones that first appeared after a change. */
export function groupIncidentErrors(incident: Incident, firstSeenInWorkspace: Map<string, string> = new Map()): ErrorGroup[] {
  const events = incident.events.filter((event) => event.evidenceState !== "excluded").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const changes = events.filter((event) => event.kind === "deploy");
  const groups = new Map<string, ErrorGroup>();
  for (const event of events) {
    const exception = exceptionOf(event);
    if (!exception) continue;
    const current = groups.get(exception.fingerprint);
    if (current) {
      current.count += 1;
      current.lastSeen = event.timestamp;
      if (!current.services.includes(event.service)) current.services.push(event.service);
      continue;
    }
    groups.set(exception.fingerprint, {
      ...exception, services: [event.service], count: 1, firstSeen: event.timestamp, lastSeen: event.timestamp, sampleEventId: event.id,
      firstSeenInWorkspace: event.timestamp, newSince: null
    });
  }
  for (const group of groups.values()) {
    const known = firstSeenInWorkspace.get(group.fingerprint);
    if (known && known < group.firstSeenInWorkspace) group.firstSeenInWorkspace = known;
    const change = [...changes].reverse().find((item) => item.timestamp <= group.firstSeen);
    if (change && group.firstSeenInWorkspace >= change.timestamp) group.newSince = { eventId: change.id, title: change.title, timestamp: change.timestamp };
  }
  return [...groups.values()].sort((a, b) => Number(Boolean(b.newSince)) - Number(Boolean(a.newSince)) || b.count - a.count || a.firstSeen.localeCompare(b.firstSeen));
}
