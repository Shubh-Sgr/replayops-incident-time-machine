import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type TimeZoneMode = "utc" | "local";

interface TimeZoneContextValue {
  mode: TimeZoneMode;
  setMode(mode: TimeZoneMode): void;
  zoneLabel: string;
  formatClock(value: string): string;
  formatDateTime(value: string): string;
}

const TimeZoneContext = createContext<TimeZoneContextValue | null>(null);

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<TimeZoneMode>(() => localStorage.getItem("replayops-time-zone") === "utc" ? "utc" : "local");
  const setMode = (next: TimeZoneMode) => {
    localStorage.setItem("replayops-time-zone", next);
    setModeState(next);
  };
  const value = useMemo<TimeZoneContextValue>(() => {
    const timeZone = mode === "utc" ? "UTC" : undefined;
    const resolved = mode === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
    return {
      mode,
      setMode,
      zoneLabel: resolved,
      formatClock: (input) => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone }).format(new Date(input)),
      formatDateTime: (input) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "long", hour12: false, timeZone }).format(new Date(input))
    };
  }, [mode]);
  return <TimeZoneContext.Provider value={value}>{children}</TimeZoneContext.Provider>;
}

export function useTimeZone() {
  const value = useContext(TimeZoneContext);
  if (!value) throw new Error("useTimeZone must be used inside TimeZoneProvider");
  return value;
}
