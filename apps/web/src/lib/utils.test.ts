import { describe, expect, it, vi } from "vitest";
import { cn, durationBetween, formatRelative, toLocalDateTimeInput } from "./utils";

describe("display utilities", () => {
  it("merges competing utility classes", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });

  it("formats operational durations", () => {
    expect(durationBetween("2026-09-20T08:00:00.000Z", "2026-09-20T09:42:00.000Z")).toBe("1h 42m");
  });

  it("formats relative activity time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T10:00:00.000Z"));
    expect(formatRelative("2026-09-20T09:42:00.000Z")).toBe("18m ago");
    vi.useRealTimers();
  });

  it("round-trips UTC timestamps through a local datetime input", () => {
    const source = "2026-09-20T09:42:00.000Z";
    expect(new Date(toLocalDateTimeInput(source)).toISOString()).toBe(source);
  });
});
