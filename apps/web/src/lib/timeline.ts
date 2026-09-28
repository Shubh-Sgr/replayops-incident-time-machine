import type { IncidentEvent } from "../types";

export interface TimelineWindow {
  startMs: number;
  endMs: number;
}

export interface TimelineCluster {
  key: string;
  lane: string;
  timestampMs: number;
  events: IncidentEvent[];
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TICK_STEPS = [
  SECOND,
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  30 * DAY,
  90 * DAY,
  365 * DAY
];

export const timelineDurations = {
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY
} as const;

export function timelineExtent(events: IncidentEvent[], startedAt?: string, endedAt?: string | null): TimelineWindow {
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const ended = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (Number.isFinite(started)) timestamps.push(started);
  if (Number.isFinite(ended)) timestamps.push(ended);
  if (!timestamps.length) {
    const now = Date.now();
    return { startMs: now - 30 * MINUTE, endMs: now };
  }
  let startMs = Math.min(...timestamps);
  let endMs = Math.max(...timestamps);
  if (startMs === endMs) {
    startMs -= 30 * SECOND;
    endMs += 30 * SECOND;
  }
  return { startMs, endMs };
}

export function clampTimelineWindow(window: TimelineWindow, extent: TimelineWindow): TimelineWindow {
  const fullSpan = Math.max(extent.endMs - extent.startMs, SECOND);
  const span = Math.min(Math.max(window.endMs - window.startMs, SECOND), fullSpan);
  let startMs = window.startMs;
  if (startMs < extent.startMs) startMs = extent.startMs;
  if (startMs + span > extent.endMs) startMs = extent.endMs - span;
  return { startMs, endMs: startMs + span };
}

export function zoomTimelineWindow(window: TimelineWindow, extent: TimelineWindow, factor: number, focalMs?: number): TimelineWindow {
  const currentSpan = Math.max(window.endMs - window.startMs, SECOND);
  const fullSpan = Math.max(extent.endMs - extent.startMs, SECOND);
  const nextSpan = Math.min(Math.max(currentSpan * factor, SECOND), fullSpan);
  const focal = focalMs ?? window.startMs + currentSpan / 2;
  const ratio = (focal - window.startMs) / currentSpan;
  return clampTimelineWindow({ startMs: focal - nextSpan * ratio, endMs: focal + nextSpan * (1 - ratio) }, extent);
}

export function shiftTimelineWindow(window: TimelineWindow, extent: TimelineWindow, direction: -1 | 1): TimelineWindow {
  const span = Math.max(window.endMs - window.startMs, SECOND);
  const shift = span * 0.8 * direction;
  return clampTimelineWindow({ startMs: window.startMs + shift, endMs: window.endMs + shift }, extent);
}

export function centerTimelineWindowOn(window: TimelineWindow, extent: TimelineWindow, timestamp: string | number): TimelineWindow {
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const span = Math.max(window.endMs - window.startMs, SECOND);
  return clampTimelineWindow({ startMs: value - span / 2, endMs: value + span / 2 }, extent);
}

export function timelineTicks(window: TimelineWindow, maximum = 7): number[] {
  const span = Math.max(window.endMs - window.startMs, SECOND);
  const step = TICK_STEPS.find((candidate) => span / candidate <= maximum - 1) ?? TICK_STEPS.at(-1)!;
  const ticks = [window.startMs];
  let tick = Math.ceil(window.startMs / step) * step;
  while (tick < window.endMs && ticks.length < maximum + 1) {
    if (tick > window.startMs) ticks.push(tick);
    tick += step;
  }
  if (ticks.at(-1) !== window.endMs) ticks.push(window.endMs);
  return ticks;
}

export function clusterTimelineEvents(
  events: IncidentEvent[],
  window: TimelineWindow,
  laneFor: (event: IncidentEvent) => string,
  bucketCount = 56
): TimelineCluster[] {
  const span = Math.max(window.endMs - window.startMs, SECOND);
  const buckets = new Map<string, { lane: string; items: IncidentEvent[] }>();
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < window.startMs || timestamp > window.endMs) continue;
    const lane = laneFor(event);
    const bucket = Math.min(bucketCount - 1, Math.floor(((timestamp - window.startMs) / span) * bucketCount));
    const key = `${lane}:${bucket}`;
    const current = buckets.get(key) ?? { lane, items: [] };
    current.items.push(event);
    buckets.set(key, current);
  }
  return [...buckets.entries()].map(([key, value]) => {
    value.items.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    const total = value.items.reduce((sum, event) => sum + Date.parse(event.timestamp), 0);
    return { key, lane: value.lane, timestampMs: total / value.items.length, events: value.items };
  });
}

export function timelineDensity(events: IncidentEvent[], extent: TimelineWindow, bucketCount = 72): number[] {
  const buckets = Array.from({ length: bucketCount }, () => 0);
  const span = Math.max(extent.endMs - extent.startMs, SECOND);
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(((timestamp - extent.startMs) / span) * bucketCount)));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

export function formatElapsed(start: string | number, end: string | number): string {
  const startMs = typeof start === "number" ? start : Date.parse(start);
  const endMs = typeof end === "number" ? end : Date.parse(end);
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / SECOND));
  if (totalSeconds < 60) return `+${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `+${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `+${totalHours}h ${totalMinutes % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `+${days}d ${totalHours % 24}h`;
}

export function windowContains(window: TimelineWindow, timestamp: string): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value >= window.startMs && value <= window.endMs;
}

export function timelinePosition(timestamp: string | number, window: TimelineWindow, insetPercent = 0): number {
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const span = Math.max(window.endMs - window.startMs, SECOND);
  const ratio = Math.min(1, Math.max(0, (value - window.startMs) / span));
  const inset = Math.min(25, Math.max(0, insetPercent));
  return inset + ratio * (100 - inset * 2);
}

/** Offsets are measured from the earliest evidence, so precursors recorded before the incident opened don't all collapse to +0s. */
export function evidenceOrigin(incident: { startedAt: string; events: Array<{ timestamp: string }> }): number {
  const times = [incident.startedAt, ...incident.events.map((event) => event.timestamp)].map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : Date.parse(incident.startedAt);
}
