import { ArrowDown, ArrowUp, Ban, ChevronLeft, ChevronRight, Edit3, ExternalLink, FileWarning, MoveRight, Search, Undo2, X } from "lucide-react";
import { useState } from "react";
import { formatElapsed, windowContains, type TimelineWindow } from "../lib/timeline";
import { cn } from "../lib/utils";
import { useTimeZone } from "../providers/TimeZoneProvider";
import type { EventKind, Incident, IncidentEvent } from "../types";

type EvidenceScope = "window" | "all";
type EvidenceStateFilter = "all" | "active" | "excluded";
type EvidenceSort = "asc" | "desc";

interface EvidenceLedgerProps {
  incident: Incident;
  selectedEventId?: string | null;
  visibleWindow?: TimelineWindow | null;
  updating?: boolean;
  onSelect(eventId: string): void;
  onEdit(event: IncidentEvent): void;
  onMove(event: IncidentEvent): void;
  onEvidenceState(event: IncidentEvent, state: "active" | "excluded"): void;
}

function typeTone(kind: EventKind) {
  if (kind === "alert") return "bg-danger/10 text-danger";
  if (kind === "recovery") return "bg-success/10 text-success";
  if (kind === "deploy") return "bg-accent/15 text-ink";
  return "bg-info/10 text-info";
}

export function EvidenceLedger({ incident, selectedEventId, visibleWindow, updating, onSelect, onEdit, onMove, onEvidenceState }: EvidenceLedgerProps) {
  const { formatClock, formatDateTime } = useTimeZone();
  const [scope, setScope] = useState<EvidenceScope>("window");
  const [query, setQuery] = useState("");
  const [service, setService] = useState("all");
  const [kind, setKind] = useState("all");
  const [state, setState] = useState<EvidenceStateFilter>("all");
  const [sort, setSort] = useState<EvidenceSort>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const services = [...new Set(incident.events.map((event) => event.service))].sort();
  const normalizedQuery = query.trim().toLowerCase();
  const scopedEvents = scope === "window" && visibleWindow ? incident.events.filter((event) => windowContains(visibleWindow, event.timestamp)) : incident.events;
  const filteredEvents = scopedEvents
    .filter((event) => service === "all" || event.service === service)
    .filter((event) => kind === "all" || event.kind === kind)
    .filter((event) => state === "all" || (state === "excluded" ? event.evidenceState === "excluded" : event.evidenceState !== "excluded"))
    .filter((event) => !normalizedQuery || [event.id, event.title, event.detail, event.service, event.kind, event.provenance].some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery)))
    .sort((left, right) => (Date.parse(left.timestamp) - Date.parse(right.timestamp)) * (sort === "asc" ? 1 : -1));
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageEvents = filteredEvents.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selected = incident.events.find((event) => event.id === selectedEventId) ?? pageEvents[0] ?? incident.events[0];
  const selectedIsFiltered = Boolean(selected && !filteredEvents.some((event) => event.id === selected.id));
  const hiddenByWindow = scope === "window" ? incident.events.length - scopedEvents.length : 0;
  const excludedCount = scopedEvents.filter((event) => event.evidenceState === "excluded").length;
  const hasFilters = Boolean(normalizedQuery || service !== "all" || kind !== "all" || state !== "all");
  const firstVisible = filteredEvents.length ? (safePage - 1) * pageSize + 1 : 0;
  const lastVisible = Math.min(safePage * pageSize, filteredEvents.length);

  const resetFilters = () => {
    setQuery("");
    setService("all");
    setKind("all");
    setState("all");
    setPage(1);
  };
  const changeScope = (next: EvidenceScope) => { setScope(next); setPage(1); };
  const choose = (eventId: string) => onSelect(eventId);

  return <section id="evidence" className="surface-lined scroll-mt-28 overflow-hidden" aria-labelledby="evidence-title">
    <div className="border-b border-line px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 id="evidence-title" className="section-title">Evidence ledger</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">Scan the sequence, inspect one observation in depth, and correct noisy evidence without deleting its history.</p>
        </div>
        <div className="flex w-fit rounded-control bg-elevated p-1" aria-label="Evidence time scope">
          <button className={cn("min-h-9 rounded-[8px] px-3 text-xs font-semibold", scope === "window" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")} onClick={() => changeScope("window")} aria-pressed={scope === "window"}>Visible window</button>
          <button className={cn("min-h-9 rounded-[8px] px-3 text-xs font-semibold", scope === "all" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")} onClick={() => changeScope("all")} aria-pressed={scope === "all"}>All evidence</button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(240px,1fr)_repeat(3,minmax(132px,auto))]">
        <label className="relative block"><span className="sr-only">Search evidence</span><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" /><input className="field pl-10 pr-10" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search title, detail, service, or event ID" />{query && <button className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line/40 hover:text-ink" onClick={() => { setQuery(""); setPage(1); }} aria-label="Clear evidence search"><X className="h-4 w-4" /></button>}</label>
        <label><span className="sr-only">Filter by service</span><select className="field" value={service} onChange={(event) => { setService(event.target.value); setPage(1); }}><option value="all">All services</option>{services.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span className="sr-only">Filter by observation type</span><select className="field" value={kind} onChange={(event) => { setKind(event.target.value); setPage(1); }}><option value="all">All types</option>{["alert", "deploy", "dependency", "metric", "action", "recovery"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span className="sr-only">Filter by evidence state</span><select className="field" value={state} onChange={(event) => { setState(event.target.value as EvidenceStateFilter); setPage(1); }}><option value="all">Any state</option><option value="active">Active only</option><option value="excluded">Excluded only</option></select></label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span><strong className="measurement-number text-ink">{filteredEvents.length}</strong> matching</span>
        <span><strong className="measurement-number text-ink">{scopedEvents.length}</strong> in scope</span>
        <span><strong className="measurement-number text-ink">{excludedCount}</strong> excluded</span>
        {hiddenByWindow > 0 && <button className="font-semibold text-info hover:underline" onClick={() => changeScope("all")}>{hiddenByWindow} outside the timeline window</button>}
        {hasFilters && <button className="font-semibold text-info hover:underline" onClick={resetFilters}>Clear filters</button>}
      </div>
    </div>

    {selected && <article id="evidence-selected" className="scroll-mt-28 border-b border-line bg-elevated px-5 py-5 sm:px-6" aria-label="Selected evidence">
      <div className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)_auto] lg:items-start">
        <div><p className="text-xs text-muted">Selected · {formatElapsed(incident.startedAt, selected.timestamp)}</p><p className="measurement-number mt-1 text-sm font-semibold">{formatDateTime(selected.timestamp)}</p><p className="measurement-number mt-1 text-xs text-muted">{selected.service}</p></div>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-ink">{selected.title}</h3><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", typeTone(selected.kind))}>{selected.kind}</span><span className="rounded-full bg-panel px-2 py-0.5 text-xs font-semibold capitalize text-muted">{selected.provenance ?? (selected.metadata?.automated ? "ingested" : "manual")}</span>{selected.evidenceState === "excluded" && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-semibold text-warning">excluded</span>}</div><p className="mt-2 max-w-4xl text-sm leading-6 text-muted">{selected.detail}</p>{selected.correctionReason && <p className="mt-2 text-xs text-warning">History note: {selected.correctionReason}</p>}{selectedIsFiltered && <p className="mt-2 text-xs font-semibold text-warning">This selected event is outside the current list filters. It remains visible here for context.</p>}</div>
        <div className="flex flex-wrap gap-1.5"><button className="control-quiet !min-h-9 !px-2.5" onClick={() => onMove(selected)} aria-label={`Move ${selected.title}`} title="Correct incident grouping"><MoveRight className="h-4 w-4" /></button><button className="control-quiet !min-h-9 !px-2.5" onClick={() => onEdit(selected)} aria-label={`Correct ${selected.title}`} title="Create an audited correction"><Edit3 className="h-4 w-4" /></button>{selected.evidenceState === "excluded" ? <button className="control-quiet !min-h-9 !px-2.5" onClick={() => onEvidenceState(selected, "active")} disabled={updating} aria-label={`Restore ${selected.title}`} title="Restore to diagnosis"><Undo2 className="h-4 w-4" /></button> : <button className="control-quiet !min-h-9 !px-2.5 text-warning" onClick={() => onEvidenceState(selected, "excluded")} disabled={updating} aria-label={`Exclude ${selected.title}`} title="Exclude as noise"><Ban className="h-4 w-4" /></button>}{typeof selected.metadata?.sourceUrl === "string" && <a className="control-quiet inline-flex !min-h-9 items-center gap-1.5 !px-2.5 text-info" href={selected.metadata.sourceUrl} target="_blank" rel="noreferrer">Source <ExternalLink className="h-3.5 w-3.5" /></a>}</div>
      </div>
    </article>}

    {filteredEvents.length ? <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[860px] table-fixed text-left" aria-describedby="evidence-caption">
          <caption id="evidence-caption" className="sr-only">Evidence observations. Select an evidence name to inspect it above. The observed-time column is sortable.</caption>
          <thead className="bg-panel text-xs text-muted"><tr><th scope="col" className="w-44 px-5 py-3" aria-sort={sort === "asc" ? "ascending" : "descending"}><button className="flex items-center gap-1.5 font-semibold hover:text-ink" onClick={() => { setSort(sort === "asc" ? "desc" : "asc"); setPage(1); }}>Observed {sort === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}</button></th><th scope="col" className="w-36 px-3 py-3 font-semibold">Service</th><th scope="col" className="w-28 px-3 py-3 font-semibold">Type</th><th scope="col" className="px-3 py-3 font-semibold">Evidence</th><th scope="col" className="w-28 px-5 py-3 font-semibold">Source</th></tr></thead>
          <tbody className="divide-y divide-line border-t border-line">{pageEvents.map((event) => <tr key={event.id} className={cn("align-top transition-colors hover:bg-elevated/60", selected?.id === event.id && "bg-info/10", event.evidenceState === "excluded" && "opacity-55")}><td className="px-5 py-3"><span className="measurement-number block text-xs font-semibold text-ink">{formatClock(event.timestamp)}</span><span className="measurement-number mt-1 block text-xs text-muted">{formatElapsed(incident.startedAt, event.timestamp)}</span></td><td className="px-3 py-3"><span className="measurement-number block truncate text-xs text-muted" title={event.service}>{event.service}</span></td><td className="px-3 py-3"><span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", typeTone(event.kind))}>{event.kind}</span></td><td className="px-3 py-3"><button className="block w-full text-left" onClick={() => choose(event.id)} aria-pressed={selected?.id === event.id}><span className="block truncate text-sm font-semibold text-ink">{event.title}</span><span className="mt-1 block truncate text-xs text-muted">{event.detail}</span></button></td><td className="px-5 py-3"><span className="text-xs font-semibold capitalize text-muted">{event.provenance ?? (event.metadata?.automated ? "ingested" : "manual")}</span>{event.evidenceState === "excluded" && <span className="mt-1 block text-xs font-semibold text-warning">Excluded</span>}</td></tr>)}</tbody>
        </table>
      </div>

      <div className="divide-y divide-line lg:hidden">{pageEvents.map((event) => <article key={event.id} className={cn("px-5 py-4", selected?.id === event.id && "bg-info/10", event.evidenceState === "excluded" && "opacity-55")}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><button className="block w-full text-left" onClick={() => choose(event.id)} aria-pressed={selected?.id === event.id}><span className="block truncate text-sm font-semibold text-ink">{event.title}</span><span className="measurement-number mt-1 block text-xs text-muted">{formatDateTime(event.timestamp)} · {formatElapsed(incident.startedAt, event.timestamp)}</span></button></div><span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold uppercase", typeTone(event.kind))}>{event.kind}</span></div><p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{event.detail}</p><p className="measurement-number mt-2 text-xs text-muted">{event.service} · {event.provenance ?? (event.metadata?.automated ? "ingested" : "manual")}</p></article>)}</div>

      <div className="flex flex-col gap-3 border-t border-line bg-panel px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><p className="measurement-number text-xs text-muted">{firstVisible}–{lastVisible} of {filteredEvents.length}</p><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs font-semibold text-muted">Rows<select className="field !min-h-9 w-20 !px-2" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="control-quiet !min-h-9 !px-2.5" onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage === 1} aria-label="Previous evidence page"><ChevronLeft className="h-4 w-4" /></button><span className="measurement-number min-w-20 text-center text-xs text-muted">{safePage} / {pageCount}</span><button className="control-quiet !min-h-9 !px-2.5" onClick={() => setPage(Math.min(pageCount, safePage + 1))} disabled={safePage === pageCount} aria-label="Next evidence page"><ChevronRight className="h-4 w-4" /></button></div></div>
    </> : <div className="px-6 py-12 text-center"><FileWarning className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No matching evidence</p><p className="mt-1 text-sm text-muted">Clear filters, widen the timeline window, or add an observation.</p>{(hasFilters || scope === "window") && <div className="mt-4 flex justify-center gap-2">{hasFilters && <button className="control-secondary" onClick={resetFilters}>Clear filters</button>}{scope === "window" && <button className="control-secondary" onClick={() => changeScope("all")}>Show all evidence</button>}</div>}</div>}
  </section>;
}
