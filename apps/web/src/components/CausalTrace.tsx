import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Clock3, Focus, Minus, Plus, ScanLine, X, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Incident, IncidentEvent } from "../types";
import { cn } from "../lib/utils";
import {
  clampTimelineWindow,
  clusterTimelineEvents,
  formatElapsed,
  shiftTimelineWindow,
  timelineDensity,
  timelineDurations,
  timelineExtent,
  timelinePosition,
  timelineTicks,
  windowContains,
  zoomTimelineWindow,
  type TimelineWindow
} from "../lib/timeline";
import { useTimeZone } from "../providers/TimeZoneProvider";

interface CausalTraceProps {
  incident: Incident;
  compact?: boolean;
  selectedEventId?: string | null;
  onSelectEvent?: (eventId: string) => void;
  onWindowChange?: (window: TimelineWindow) => void;
}

const PRESETS = [
  { label: "1h", duration: timelineDurations.hour },
  { label: "6h", duration: 6 * timelineDurations.hour },
  { label: "24h", duration: timelineDurations.day },
  { label: "7d", duration: timelineDurations.week }
];

function markerTone(events: IncidentEvent[]) {
  if (events.every((event) => event.evidenceState === "excluded")) return "border-muted bg-panel text-muted opacity-55";
  if (events.some((event) => event.kind === "alert")) return "border-danger bg-danger/15 text-danger";
  if (events.some((event) => event.kind === "recovery")) return "border-success bg-success/15 text-success";
  if (events.some((event) => event.kind === "deploy")) return "border-accent bg-accent/15 text-ink";
  return "border-info bg-panel text-info";
}

export function CausalTrace({ incident, compact = false, selectedEventId, onSelectEvent, onWindowChange }: CausalTraceProps) {
  const { mode, formatClock, formatDateTime, zoneLabel } = useTimeZone();
  const sortedEvents = useMemo(() => [...incident.events].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)), [incident.events]);
  const extent = useMemo(() => timelineExtent(sortedEvents, incident.startedAt, incident.resolvedAt), [incident.startedAt, incident.resolvedAt, sortedEvents]);
  const previousExtent = useRef(extent);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [window, setWindow] = useState<TimelineWindow>(extent);
  const [internalId, setInternalId] = useState(sortedEvents[0]?.id ?? "");
  const [plotWidth, setPlotWidth] = useState(720);
  const [clusterEventIds, setClusterEventIds] = useState<string[]>([]);
  const activeId = selectedEventId ?? internalId;
  const selectedIndex = Math.max(0, sortedEvents.findIndex((event) => event.id === activeId));
  const selectedEvent = sortedEvents[selectedIndex];
  const span = Math.max(window.endMs - window.startMs, 1);
  const fullSpan = Math.max(extent.endMs - extent.startMs, 1);
  const inWindow = useMemo(() => sortedEvents.filter((event) => windowContains(window, event.timestamp)), [sortedEvents, window]);

  useEffect(() => {
    const previous = previousExtent.current;
    const wasFitted = Math.abs(window.startMs - previous.startMs) < 2 && Math.abs(window.endMs - previous.endMs) < 2;
    setWindow((current) => wasFitted ? extent : clampTimelineWindow(current, extent));
    previousExtent.current = extent;
  }, [extent.startMs, extent.endMs]);

  useEffect(() => {
    if (!sortedEvents.some((event) => event.id === activeId)) setInternalId(sortedEvents[0]?.id ?? "");
  }, [activeId, sortedEvents]);

  useEffect(() => onWindowChange?.(window), [window.startMs, window.endMs]);

  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const update = () => setPlotWidth(Math.max(1, element.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of inWindow) counts.set(event.service, (counts.get(event.service) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [inWindow]);
  const laneLimit = compact ? 4 : 8;
  const hasOverflowLane = serviceCounts.length > laneLimit;
  const namedServices = serviceCounts.slice(0, hasOverflowLane ? laneLimit - 1 : laneLimit).map(([service]) => service);
  const lanes = hasOverflowLane ? [...namedServices, "Other services"] : namedServices;
  const laneFor = (event: IncidentEvent) => namedServices.includes(event.service) ? event.service : "Other services";
  const clusterBuckets = Math.max(5, Math.floor(plotWidth / (compact ? 42 : 36)));
  const clusters = useMemo(() => clusterTimelineEvents(inWindow, window, laneFor, clusterBuckets), [inWindow, window, namedServices.join("|"), clusterBuckets]);
  const tickCount = Math.max(2, Math.min(compact ? 4 : 6, Math.floor(plotWidth / 90)));
  const ticks = useMemo(() => timelineTicks(window, tickCount), [window, tickCount]);
  const density = useMemo(() => timelineDensity(sortedEvents, extent), [sortedEvents, extent]);
  const maximumDensity = Math.max(...density, 1);
  const selectedOutside = Boolean(selectedEvent && !windowContains(window, selectedEvent.timestamp));
  const isFitted = Math.abs(window.startMs - extent.startMs) < 2 && Math.abs(window.endMs - extent.endMs) < 2;
  const plotInsetPercent = Math.min(14, Math.max(2.5, (24 / plotWidth) * 100));
  const xFor = (timestamp: string | number) => timelinePosition(timestamp, window, plotInsetPercent);
  const tickFormatter = useMemo(() => {
    const timeZone = mode === "utc" ? "UTC" : undefined;
    if (span >= 90 * timelineDurations.day) return new Intl.DateTimeFormat("en", { month: "short", year: "2-digit", timeZone });
    if (span >= timelineDurations.day) return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", hour12: false, timeZone });
    return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: span <= 15 * timelineDurations.minute ? "2-digit" : undefined, hour12: false, timeZone });
  }, [mode, span]);
  const rangeLabel = useMemo(() => {
    const timeZone = mode === "utc" ? "UTC" : undefined;
    const date = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone });
    const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone });
    const start = new Date(window.startMs);
    const end = new Date(window.endMs);
    const startDate = date.format(start);
    const endDate = date.format(end);
    return startDate === endDate ? `${startDate} · ${time.format(start)}–${time.format(end)}` : `${startDate} ${time.format(start)} → ${endDate} ${time.format(end)}`;
  }, [mode, window.startMs, window.endMs]);
  const availablePresets = PRESETS.filter((preset) => fullSpan > preset.duration);
  const inspectedClusterEvents = clusterEventIds.map((id) => sortedEvents.find((event) => event.id === id)).filter((event): event is IncidentEvent => Boolean(event));

  const choose = (eventId: string, keepCluster = false) => {
    if (!keepCluster) setClusterEventIds([]);
    setInternalId(eventId);
    onSelectEvent?.(eventId);
  };
  const moveEvent = (amount: number) => {
    const next = sortedEvents[Math.min(Math.max(selectedIndex + amount, 0), sortedEvents.length - 1)];
    if (next) choose(next.id);
  };
  const applyWindow = (next: TimelineWindow) => setWindow(clampTimelineWindow(next, extent));
  const showLatest = (duration: number) => applyWindow({ startMs: extent.endMs - Math.min(duration, fullSpan), endMs: extent.endMs });
  const centerSelected = () => {
    if (!selectedEvent) return;
    const timestamp = Date.parse(selectedEvent.timestamp);
    applyWindow({ startMs: timestamp - span / 2, endMs: timestamp + span / 2 });
  };
  const moveOverview = (clientX: number, bounds: DOMRect) => {
    const center = extent.startMs + ((clientX - bounds.left) / bounds.width) * fullSpan;
    applyWindow({ startMs: center - span / 2, endMs: center + span / 2 });
  };
  const inspectCluster = (events: IncidentEvent[]) => {
    const first = events[0];
    if (!first) return;
    if (events.length === 1) {
      choose(first.id);
      return;
    }
    setClusterEventIds(events.map((event) => event.id));
    choose(first.id, true);
  };
  const zoomIntoCluster = () => {
    if (!inspectedClusterEvents.length) return;
    const timestamps = inspectedClusterEvents.map((event) => Date.parse(event.timestamp));
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    const padding = Math.max((last - first) * 0.75, 500);
    applyWindow({ startMs: first - padding, endMs: last + padding });
  };

  if (!selectedEvent) {
    return <div className="flex min-h-56 items-center justify-center rounded-panel bg-elevated text-sm text-muted">Add or ingest timestamped evidence to build the event timeline.</div>;
  }

  const plotHeight = Math.max(compact ? 132 : 176, lanes.length * 48 + 52);
  const viewportLeft = ((window.startMs - extent.startMs) / fullSpan) * 100;
  const viewportWidth = Math.max(1.5, (span / fullSpan) * 100);

  return (
    <div
      className={cn("overflow-hidden rounded-panel bg-elevated", compact ? "p-4" : "p-5 sm:p-6")}
      role="region"
      aria-label={`Event timeline for ${incident.code}`}
      tabIndex={0}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "ArrowLeft") { keyboardEvent.preventDefault(); moveEvent(-1); }
        if (keyboardEvent.key === "ArrowRight") { keyboardEvent.preventDefault(); moveEvent(1); }
        if (keyboardEvent.key === "[") { keyboardEvent.preventDefault(); applyWindow(shiftTimelineWindow(window, extent, -1)); }
        if (keyboardEvent.key === "]") { keyboardEvent.preventDefault(); applyWindow(shiftTimelineWindow(window, extent, 1)); }
      }}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="measurement-number text-xs text-muted">{incident.code} · {inWindow.length} OF {sortedEvents.length} EVENTS · {zoneLabel}</p>
          <p className="measurement-number mt-1 text-sm font-semibold text-ink">{rangeLabel}</p>
          <p className="mt-1 text-xs text-muted">Every event in this window is represented. Numbered markers contain overlapping observations; proximity does not prove causation.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-control bg-panel p-1" aria-label="Timeline range controls">
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => applyWindow(shiftTimelineWindow(window, extent, -1))} disabled={window.startMs <= extent.startMs} aria-label="Earlier time window"><ChevronLeft className="h-4 w-4" /></button>
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => applyWindow(zoomTimelineWindow(window, extent, 2, selectedOutside ? undefined : Date.parse(selectedEvent.timestamp)))} disabled={isFitted} aria-label="Zoom out"><Minus className="h-4 w-4" /></button>
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => applyWindow(zoomTimelineWindow(window, extent, 0.5, selectedOutside ? undefined : Date.parse(selectedEvent.timestamp)))} disabled={span <= 1_000} aria-label="Zoom in"><Plus className="h-4 w-4" /></button>
          <button className={cn("control-quiet !min-h-9 !px-3", isFitted && "bg-elevated text-ink")} onClick={() => setWindow(extent)} aria-pressed={isFitted}><ScanLine className="mr-1.5 inline h-4 w-4" />Fit</button>
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => applyWindow(shiftTimelineWindow(window, extent, 1))} disabled={window.endMs >= extent.endMs} aria-label="Later time window"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {availablePresets.length ? <><span className="text-xs font-semibold text-muted">Latest</span>{availablePresets.map((preset) => <button key={preset.label} className="min-h-9 rounded-control bg-panel px-3 text-xs font-semibold text-muted transition-colors hover:bg-line/40 hover:text-ink" onClick={() => showLatest(preset.duration)}>{preset.label}</button>)}</> : <span className="text-xs text-muted">Use + to isolate a dense moment; Fit restores the complete incident.</span>}
        {selectedOutside && <button className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-control bg-warning/10 px-3 text-xs font-semibold text-warning" onClick={centerSelected}><Focus className="h-3.5 w-3.5" />Center selected event</button>}
      </div>

      <div className="mt-4 grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[112px_minmax(0,1fr)]">
        <span className="text-xs font-semibold text-muted">Full incident</span>
        <button
          className="relative flex h-10 items-end gap-px overflow-hidden rounded-control bg-panel px-1.5 pb-1 pt-1.5"
          aria-label="Incident overview. Click to move the visible time window."
          onClick={(event) => moveOverview(event.clientX, event.currentTarget.getBoundingClientRect())}
        >
          {density.map((count, index) => <span key={index} className="min-w-0 flex-1 rounded-[1px] bg-info/45" style={{ height: `${Math.max(8, (count / maximumDensity) * 100)}%` }} />)}
          <span className="pointer-events-none absolute bottom-0 top-0 rounded-[7px] border border-accent bg-accent/10" style={{ left: `${viewportLeft}%`, width: `${viewportWidth}%` }} />
        </button>
      </div>

      <div className="mt-4 min-w-0 pb-2">
          {lanes.length ? <div className="grid min-w-0 grid-cols-[82px_minmax(0,1fr)] gap-2 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-3">
            <div className="relative" style={{ height: plotHeight }}>
              {lanes.map((lane, index) => <span key={lane} className="measurement-number absolute right-0 max-w-[78px] truncate pr-1 text-xs text-muted sm:max-w-[106px] sm:pr-2" style={{ top: 22 + index * 48 }}>{lane}</span>)}
            </div>
            <div ref={plotRef} className="instrument-grid relative min-w-0 overflow-hidden rounded-control bg-panel" style={{ height: plotHeight }}>
              {ticks.map((tick, index) => <div key={tick} className="absolute bottom-0 top-0 border-l border-line/70" style={{ left: `${xFor(tick)}%` }}><span className={cn("measurement-number absolute bottom-2 whitespace-nowrap text-xs text-faint", index === 0 ? "left-1" : index === ticks.length - 1 ? "right-1" : "-translate-x-1/2")}>{tickFormatter.format(new Date(tick))}</span></div>)}
              {lanes.map((lane, index) => <div key={lane} className="absolute left-0 right-0 h-px bg-line" style={{ top: 28 + index * 48 }} />)}
              {clusters.map((cluster) => {
                const laneIndex = lanes.indexOf(cluster.lane);
                const containsSelected = cluster.events.some((item) => item.id === selectedEvent.id);
                const representative = containsSelected ? selectedEvent : cluster.events[0];
                if (!representative) return null;
                return <button key={cluster.key} className="group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full" style={{ left: `${xFor(cluster.timestampMs)}%`, top: 28 + laneIndex * 48 }} onClick={() => inspectCluster(cluster.events)} aria-label={`${cluster.events.length > 1 ? `${cluster.events.length} events near ` : ""}${formatDateTime(representative.timestamp)}. ${representative.title}`} aria-pressed={containsSelected}>
                  <motion.span className={cn("measurement-number flex h-7 items-center justify-center border-2 text-xs font-semibold shadow-sm", cluster.events.length > 1 ? "min-w-8 rounded-full px-1.5" : "w-7 rounded-full", markerTone(cluster.events), containsSelected && "border-accent bg-accent text-accent-ink")} animate={{ scale: containsSelected ? 1.08 : 1 }} transition={{ type: "spring", stiffness: 420, damping: 28 }}>{cluster.events.length > 1 ? cluster.events.length : <span className="h-1.5 w-1.5 rounded-full bg-current" />}</motion.span>
                </button>;
              })}
              {!inWindow.length && <div className="absolute inset-0 flex items-center justify-center"><p className="rounded-control bg-elevated px-4 py-3 text-sm text-muted">No evidence in this window. Pan, zoom out, or choose Fit.</p></div>}
              {!selectedOutside && <motion.div className="pointer-events-none absolute bottom-7 top-0 w-px bg-accent" animate={{ left: `${xFor(selectedEvent.timestamp)}%` }} transition={{ type: "spring", stiffness: 380, damping: 34 }} />}
            </div>
          </div> : <div className="flex min-h-40 items-center justify-center rounded-control bg-panel text-sm text-muted">No events are visible in this time window.</div>}
      </div>

      {hasOverflowLane && <p className="mt-1 text-xs text-muted">Showing the {namedServices.length} busiest service lanes in this window; {serviceCounts.length - namedServices.length} lower-volume services are grouped without dropping their evidence.</p>}

      {inspectedClusterEvents.length > 1 && <div className="mt-4 border-t border-line pt-4" role="region" aria-label="Overlapping timeline events">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-ink">{inspectedClusterEvents.length} events share this marker</p><p className="mt-1 text-xs text-muted">Select an event here or zoom into the cluster. The page stays at the timeline.</p></div><div className="flex gap-1"><button className="control-secondary inline-flex !min-h-9 items-center gap-1.5 !px-3" onClick={zoomIntoCluster}><ZoomIn className="h-3.5 w-3.5" />Zoom into cluster</button><button className="control-quiet !min-h-9 !px-2.5" onClick={() => setClusterEventIds([])} aria-label="Close overlapping events"><X className="h-4 w-4" /></button></div></div>
        <div className="mt-3 max-h-48 divide-y divide-line overflow-y-auto border-y border-line">{inspectedClusterEvents.map((event) => <button key={event.id} className={cn("grid min-h-11 w-full gap-1 px-2 py-2.5 text-left transition-colors hover:bg-panel sm:grid-cols-[110px_120px_minmax(0,1fr)]", event.id === selectedEvent.id && "bg-info/10")} onClick={() => choose(event.id, true)} aria-pressed={event.id === selectedEvent.id}><span className="measurement-number text-xs text-muted">{formatClock(event.timestamp)}</span><span className="measurement-number truncate text-xs text-muted">{event.service}</span><span className="text-sm font-semibold text-ink">{event.title}</span></button>)}</div>
      </div>}

      {!compact && <AnimatePresence mode="wait"><motion.div key={selectedEvent.id} initial={{ opacity: .4, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .18 }} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
        <div><p className="text-xs text-muted">Selected · {formatElapsed(incident.startedAt, selectedEvent.timestamp)}</p><p className="measurement-number mt-1 text-sm">{formatDateTime(selectedEvent.timestamp)}</p></div>
        <div><p className="text-xs text-muted">{selectedEvent.service} · {selectedEvent.kind}</p><p className="mt-1 text-sm font-semibold text-ink">{selectedEvent.title}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{selectedEvent.detail}</p></div>
        <div className="flex items-start gap-2 text-xs font-semibold text-muted"><Clock3 className="mt-0.5 h-3.5 w-3.5" />{formatClock(selectedEvent.timestamp)}</div>
      </motion.div></AnimatePresence>}
      <p className="sr-only">Use left and right arrows for adjacent events. Use left and right brackets to move the time window.</p>
    </div>
  );
}
