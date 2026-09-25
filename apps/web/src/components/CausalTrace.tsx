import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Incident } from "../types";
import { cn } from "../lib/utils";
import { useTimeZone } from "../providers/TimeZoneProvider";

interface CausalTraceProps {
  incident: Incident;
  compact?: boolean;
  selectedEventId?: string | null;
  onSelectEvent?: (eventId: string) => void;
}

export function CausalTrace({ incident, compact = false, selectedEventId, onSelectEvent }: CausalTraceProps) {
  const { formatClock, formatDateTime, zoneLabel } = useTimeZone();
  const [internalId, setInternalId] = useState(incident.events[0]?.id ?? "");
  const [zoom, setZoom] = useState(1);
  const activeId = selectedEventId ?? internalId;
  const selected = Math.max(0, incident.events.findIndex((event) => event.id === activeId));
  const event = incident.events[selected];
  const services = useMemo(() => [...new Set(incident.events.map((item) => item.service))], [incident.events]);
  const timestamps = incident.events.map((item) => Date.parse(item.timestamp));
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  const span = Math.max(end - start, 1);

  useEffect(() => {
    if (!incident.events.some((item) => item.id === activeId)) setInternalId(incident.events[0]?.id ?? "");
  }, [activeId, incident.events]);

  const choose = (eventId: string) => {
    setInternalId(eventId);
    onSelectEvent?.(eventId);
  };
  const move = (amount: number) => {
    const next = incident.events[Math.min(Math.max(selected + amount, 0), incident.events.length - 1)];
    if (next) choose(next.id);
  };
  const xFor = (timestamp: string) => 8 + ((Date.parse(timestamp) - start) / span) * 84;

  if (!event) {
    return <div className="flex min-h-56 items-center justify-center rounded-panel bg-elevated text-sm text-muted">Add or ingest timestamped evidence to build the event timeline.</div>;
  }

  return (
    <div className={cn("instrument-grid overflow-hidden rounded-panel bg-elevated", compact ? "p-4" : "p-5 sm:p-6")} role="region" aria-label={`Event timeline for ${incident.code}`} tabIndex={0} onKeyDown={(keyboardEvent) => {
      if (keyboardEvent.key === "ArrowLeft") { keyboardEvent.preventDefault(); move(-1); }
      if (keyboardEvent.key === "ArrowRight") { keyboardEvent.preventDefault(); move(1); }
    }}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="measurement-number text-xs text-muted">{incident.code} · EVENT TIMELINE · {zoneLabel}</p>
          <p className="mt-1 max-w-2xl text-sm font-medium text-ink">{event?.title}</p>
          <p className="mt-1 text-xs text-muted">Service lanes organize observations; proximity does not prove causation.</p>
        </div>
        <div className="flex items-center gap-1 rounded-control bg-panel p-1" aria-label="Timeline controls">
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => setZoom((value) => Math.max(1, value - 0.5))} disabled={zoom === 1} aria-label="Zoom out"><Minus className="h-4 w-4" /></button>
          <span className="measurement-number min-w-12 text-center text-xs text-muted">{zoom}×</span>
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => setZoom((value) => Math.min(3, value + 0.5))} disabled={zoom === 3} aria-label="Zoom in"><Plus className="h-4 w-4" /></button>
          <span className="mx-1 h-5 w-px bg-line" />
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => move(-1)} disabled={selected === 0} aria-label="Previous event"><ChevronLeft className="h-4 w-4" /></button>
          <span className="measurement-number min-w-14 text-center text-xs text-muted">{selected + 1}/{incident.events.length}</span>
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => move(1)} disabled={selected === incident.events.length - 1} aria-label="Next event"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="overflow-x-auto pb-3">
        <div className={cn("relative min-w-[680px] transition-[width] duration-200", compact ? "h-32" : "h-48")} style={{ width: `${zoom * 100}%` }}>
          {services.map((service, serviceIndex) => {
            const y = 20 + serviceIndex * ((compact ? 96 : 152) / Math.max(services.length - 1, 1));
            return <div key={service} className="absolute left-0 right-0" style={{ top: y }}><span className="measurement-number absolute -top-4 left-0 text-xs text-muted">{service}</span><div className="h-px bg-line" /></div>;
          })}
          {incident.events.map((item) => {
            const y = 20 + services.indexOf(item.service) * ((compact ? 96 : 152) / Math.max(services.length - 1, 1));
            const active = item.id === event?.id;
            return <button key={item.id} className="group absolute -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${xFor(item.timestamp)}%`, top: y }} onClick={() => choose(item.id)} aria-label={`${formatDateTime(item.timestamp)} ${item.title}`} aria-pressed={active}>
              <motion.span className={cn("block rounded-full border-2", active ? "h-5 w-5 border-accent bg-accent/30" : item.evidenceState === "excluded" ? "h-3.5 w-3.5 border-muted bg-panel opacity-45" : "h-3.5 w-3.5 border-info bg-panel group-hover:bg-info/20")} animate={{ scale: active ? 1 : .9, boxShadow: active ? "0 0 0 7px oklch(var(--accent) / 0.12)" : "0 0 0 0 oklch(var(--accent) / 0)" }} transition={{ type: "spring", stiffness: 420, damping: 28 }} />
              <span className="measurement-number absolute left-1/2 top-4 -translate-x-1/2 whitespace-nowrap text-xs text-faint">{formatClock(item.timestamp)}</span>
            </button>;
          })}
          <motion.div className="pointer-events-none absolute bottom-0 top-0 w-px bg-accent" animate={{ left: `${xFor(event.timestamp)}%` }} transition={{ type: "spring", stiffness: 380, damping: 34 }} />
        </div>
      </div>

      {!compact && <AnimatePresence mode="wait"><motion.div key={event.id} initial={{ opacity: .4, filter: "blur(3px)", y: 4 }} animate={{ opacity: 1, filter: "blur(0px)", y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .18 }} className="mt-3 grid gap-3 border-t border-line pt-4 sm:grid-cols-[190px_1fr_120px]">
        <div><p className="text-xs text-muted">Observed</p><p className="measurement-number mt-1 text-sm">{formatDateTime(event.timestamp)}</p></div>
        <div><p className="text-xs text-muted">Evidence</p><p className="mt-1 text-sm leading-6 text-ink">{event.detail}</p></div>
        <div><p className="text-xs text-muted">Provenance</p><p className="mt-1 text-sm font-semibold capitalize">{event.provenance ?? (event.metadata?.synthetic ? "synthetic" : "recorded")}</p></div>
      </motion.div></AnimatePresence>}
    </div>
  );
}
