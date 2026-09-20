import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Incident } from "../types";
import { cn, formatClock } from "../lib/utils";

export function CausalTrace({ incident, compact = false }: { incident: Incident; compact?: boolean }) {
  const [selected, setSelected] = useState(Math.max(0, incident.events.findIndex((event) => event.impactScore === Math.max(...incident.events.map((item) => item.impactScore)))));
  const controlRef = useRef<HTMLDivElement>(null);
  const event = incident.events[selected];
  const services = useMemo(() => [...new Set(incident.events.map((item) => item.service))], [incident.events]);

  useEffect(() => {
    if (selected >= incident.events.length) setSelected(Math.max(0, incident.events.length - 1));
  }, [incident.events.length, selected]);

  const move = (amount: number) => setSelected((value) => Math.min(Math.max(value + amount, 0), incident.events.length - 1));

  if (!incident.events.length) {
    return <div className="flex min-h-56 items-center justify-center rounded-panel bg-elevated text-sm text-muted">Add timeline evidence to begin replay reconstruction.</div>;
  }

  return (
    <div
      ref={controlRef}
      className={cn("instrument-grid relative overflow-hidden rounded-panel bg-elevated", compact ? "p-4" : "p-5 sm:p-6")}
      role="group"
      aria-label={`Causal event trace for ${incident.code}`}
      tabIndex={0}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "ArrowLeft") { keyboardEvent.preventDefault(); move(-1); }
        if (keyboardEvent.key === "ArrowRight") { keyboardEvent.preventDefault(); move(1); }
      }}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="measurement-number text-xs text-muted">{incident.code} · CAUSAL TRACE</p>
          <p className="mt-1 max-w-2xl text-sm font-medium text-ink">{event?.title}</p>
        </div>
        <div className="flex items-center gap-1 rounded-control bg-panel p-1" aria-label="Timeline controls">
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => move(-1)} disabled={selected === 0} aria-label="Previous event"><ChevronLeft className="h-4 w-4" /></button>
          <span className="measurement-number min-w-16 text-center text-xs text-muted">{selected + 1}/{incident.events.length}</span>
          <button className="control-quiet !min-h-9 !px-2.5" onClick={() => move(1)} disabled={selected === incident.events.length - 1} aria-label="Next event"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="relative overflow-x-auto pb-3">
        <div className={cn("relative min-w-[680px]", compact ? "h-32" : "h-48")}>
          {services.map((service, serviceIndex) => {
            const y = 20 + serviceIndex * ((compact ? 96 : 152) / Math.max(services.length - 1, 1));
            return (
              <div key={service} className="absolute left-0 right-0" style={{ top: y }}>
                <span className="measurement-number absolute -top-4 left-0 text-[10px] text-muted">{service}</span>
                <div className="h-px bg-line" />
              </div>
            );
          })}

          {incident.events.map((item, index) => {
            const x = 12 + index * (76 / Math.max(incident.events.length - 1, 1));
            const y = 20 + services.indexOf(item.service) * ((compact ? 96 : 152) / Math.max(services.length - 1, 1));
            const active = index === selected;
            return (
              <button
                key={item.id}
                className="group absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${x}%`, top: y }}
                onClick={() => setSelected(index)}
                aria-label={`${formatClock(item.timestamp)} ${item.title}`}
                aria-pressed={active}
              >
                <motion.span
                  className={cn("block rounded-full border-2", active ? "h-5 w-5 border-accent bg-accent/30" : "h-3.5 w-3.5 border-info bg-panel group-hover:bg-info/20")}
                  animate={{ scale: active ? 1 : 0.9, boxShadow: active ? "0 0 0 7px oklch(var(--accent) / 0.12)" : "0 0 0 0 oklch(var(--accent) / 0)" }}
                  transition={{ type: "spring", stiffness: 420, damping: 28 }}
                />
                <span className="measurement-number absolute left-1/2 top-4 -translate-x-1/2 whitespace-nowrap text-[10px] text-faint">{formatClock(item.timestamp)}</span>
              </button>
            );
          })}

          <motion.div
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-accent"
            animate={{ left: `${12 + selected * (76 / Math.max(incident.events.length - 1, 1))}%` }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
          />
        </div>
      </div>

      {!compact && (
        <AnimatePresence mode="wait">
          <motion.div
            key={event?.id}
            initial={{ opacity: 0.4, filter: "blur(3px)", y: 4 }}
            animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="mt-3 grid gap-3 border-t border-line pt-4 sm:grid-cols-[140px_1fr_90px]"
          >
            <div>
              <p className="text-xs text-muted">Recorded</p>
              <p className="measurement-number mt-1 text-sm">{event && formatClock(event.timestamp)} UTC</p>
            </div>
            <div>
              <p className="text-xs text-muted">Evidence</p>
              <p className="mt-1 text-sm leading-6 text-ink">{event?.detail}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Impact</p>
              <p className="measurement-number mt-1 text-sm font-semibold">{event?.impactScore}/100</p>
            </div>
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}
