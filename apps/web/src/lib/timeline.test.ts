import { describe, expect, it } from "vitest";
import type { IncidentEvent } from "../types";
import { centerTimelineWindowOn, clusterTimelineEvents, formatElapsed, shiftTimelineWindow, timelineExtent, timelinePosition, timelineTicks, zoomTimelineWindow } from "./timeline";

function event(id: string, timestamp: string, service = "checkout"): IncidentEvent {
  return { id, incidentId: "inc-1", timestamp, service, kind: "metric", title: id, detail: id, impactScore: 0 };
}

describe("timeline model", () => {
  it("creates readable ticks across a ninety-day incident", () => {
    const window = { startMs: Date.parse("2026-01-01T00:00:00Z"), endMs: Date.parse("2026-04-01T00:00:00Z") };
    const ticks = timelineTicks(window, 7);
    expect(ticks[0]).toBe(window.startMs);
    expect(ticks.at(-1)).toBe(window.endMs);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  it("clusters dense evidence by lane instead of rendering every collision", () => {
    const start = Date.parse("2026-09-20T00:00:00Z");
    const events = Array.from({ length: 2_000 }, (_, index) => event(String(index), new Date(start + index * 1_000).toISOString(), index % 2 ? "api" : "db"));
    const clusters = clusterTimelineEvents(events, { startMs: start, endMs: start + 2_000_000 }, (item) => item.service, 40);
    expect(clusters.length).toBeLessThanOrEqual(80);
    expect(clusters.reduce((sum, cluster) => sum + cluster.events.length, 0)).toBe(2_000);
  });

  it("keeps zoom and pan inside the complete incident range", () => {
    const extent = { startMs: 0, endMs: 10_000 };
    const zoomed = zoomTimelineWindow(extent, extent, 0.5, 8_000);
    expect(zoomed).toEqual({ startMs: 4_000, endMs: 9_000 });
    expect(shiftTimelineWindow(zoomed, extent, 1)).toEqual({ startMs: 5_000, endMs: 10_000 });
  });

  it("includes incident boundaries and formats long elapsed offsets", () => {
    const extent = timelineExtent([event("late", "2026-09-22T06:30:00Z")], "2026-09-20T00:00:00Z", "2026-09-23T00:00:00Z");
    expect(extent.startMs).toBe(Date.parse("2026-09-20T00:00:00Z"));
    expect(extent.endMs).toBe(Date.parse("2026-09-23T00:00:00Z"));
    expect(formatElapsed(extent.startMs, Date.parse("2026-09-22T06:30:00Z"))).toBe("+2d 6h");
  });

  it("keeps first and last markers inside the visible plot", () => {
    const window = { startMs: 1_000, endMs: 11_000 };
    expect(timelinePosition(1_000, window, 5)).toBe(5);
    expect(timelinePosition(6_000, window, 5)).toBe(50);
    expect(timelinePosition(11_000, window, 5)).toBe(95);
  });

  it("centers an older event while preserving and clamping the current span", () => {
    const extent = { startMs: 0, endMs: 100_000 };
    const current = { startMs: 70_000, endMs: 90_000 };
    expect(centerTimelineWindowOn(current, extent, 30_000)).toEqual({ startMs: 20_000, endMs: 40_000 });
    expect(centerTimelineWindowOn(current, extent, 2_000)).toEqual({ startMs: 0, endMs: 20_000 });
  });
});
