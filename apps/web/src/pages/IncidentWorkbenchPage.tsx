import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, ChevronDown, Edit3, ExternalLink, LoaderCircle, Plus, RotateCcw, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CausalTrace } from "../components/CausalTrace";
import { EvidenceLedger } from "../components/EvidenceLedger";
import { IncidentEditor, type IncidentDraft } from "../components/IncidentEditor";
import { LifecycleDialog, type LifecycleAction } from "../components/LifecycleDialog";
import { Linkified } from "../components/Linkified";
import { ResponseConsole } from "../components/ResponseConsole";
import { DebuggingInsights } from "../components/DebuggingInsights";
import { ErrorGroups } from "../components/ErrorGroups";
import { WhatChanged } from "../components/WhatChanged";
import { Skeleton } from "../components/Skeleton";
import { SeverityMark, StatusMark } from "../components/StatusMark";
import { api } from "../lib/api";
import { isOpen, isUnowned } from "../lib/incidents";
import { useIsAdmin } from "../lib/useIsAdmin";
import { usePersistentDraft } from "../lib/usePersistentDraft";
import { cn, durationBetween, formatRelative, toLocalDateTimeInput } from "../lib/utils";
import type { TimelineWindow } from "../lib/timeline";
import { useTimeZone } from "../providers/TimeZoneProvider";
import type { EventKind, Incident, IncidentEvent } from "../types";

type EventDraft = Omit<IncidentEvent, "id" | "incidentId">;
type EditorDraft = { timestamp: string; service: string; kind: EventKind; title: string; detail: string };

const kindLabel: Record<EventKind, string> = { alert: "Alert", deploy: "Change", dependency: "Dependency", metric: "Signal", action: "Action", recovery: "Recovered" };
const kindTone: Record<EventKind, string> = { alert: "bg-danger/12 text-danger", deploy: "bg-info/12 text-info", dependency: "bg-warning/14 text-warning", metric: "bg-elevated text-muted", action: "bg-elevated text-ink", recovery: "bg-success/12 text-success" };

function EventEditor({ incidentId, defaultService, event, saving, error, onCancel, onSave }: { incidentId: string; defaultService: string; event?: IncidentEvent | null; saving: boolean; error?: string; onCancel(): void; onSave(value: EventDraft): void }) {
  const initial: EditorDraft = { timestamp: toLocalDateTimeInput(event?.timestamp ?? new Date().toISOString()), service: event?.service ?? defaultService, kind: event?.kind ?? "action", title: event?.title ?? "", detail: event?.detail ?? "" };
  const draft = usePersistentDraft(`replayops:${incidentId}:evidence:${event?.id ?? "new"}`, initial);
  useEffect(() => { if (event) draft.setValue({ timestamp: toLocalDateTimeInput(event.timestamp), service: event.service, kind: event.kind, title: event.title, detail: event.detail }); }, [event?.id]);
  const set = (key: keyof EditorDraft, value: string) => draft.setValue((current) => ({ ...current, [key]: value }));
  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const inferredImpact: Record<EventKind, number> = { alert: 75, deploy: 35, dependency: 55, metric: 50, action: 25, recovery: 15 };
    const title = draft.value.title.trim();
    const detail = draft.value.detail.trim();
    onSave({ timestamp: new Date(draft.value.timestamp).toISOString(), service: draft.value.service.trim(), kind: draft.value.kind, title, detail: detail.length >= 8 ? detail : detail ? `${detail} — ${title}` : title.length >= 8 ? title : `Note: ${title}`, impactScore: event?.impactScore ?? inferredImpact[draft.value.kind], evidenceState: event?.evidenceState ?? "active", provenance: event?.provenance ?? "manual", correctionReason: event ? "Corrected by responder; previous values remain in the audit trail." : null, correctedFromId: event?.id ?? null, metadata: event?.metadata ?? {} });
  }
  return <motion.form className="surface-lined p-5" initial={{ opacity: .5, height: 0 }} animate={{ opacity: 1, height: "auto" }} onSubmit={submit}>
    <div className="flex items-start justify-between gap-4"><h3 className="section-title">{event ? "Correct this entry" : "Add to the timeline"}</h3><button type="button" className="control-quiet !min-h-9" onClick={onCancel}>Cancel</button></div>
    <div className="mt-4 grid gap-4 sm:grid-cols-3">
      <label className="text-sm font-semibold">Type<select className="field mt-2" value={draft.value.kind} onChange={(item) => set("kind", item.target.value)}><option value="action">Something we did</option><option value="alert">Alert or error</option><option value="deploy">Deploy or change</option><option value="dependency">Dependency problem</option><option value="metric">Metric, log or trace</option><option value="recovery">Sign of recovery</option></select></label>
      <label className="text-sm font-semibold">When<input type="datetime-local" className="field mt-2" value={draft.value.timestamp} onChange={(item) => set("timestamp", item.target.value)} required /></label>
      <label className="text-sm font-semibold">Service<input className="field mt-2" value={draft.value.service} onChange={(item) => set("service", item.target.value)} required minLength={2} /></label>
      <label className="text-sm font-semibold sm:col-span-3">What happened<input className="field mt-2" value={draft.value.title} onChange={(item) => set("title", item.target.value)} required minLength={3} maxLength={140} placeholder="Restarted the checkout pods" /></label>
      <label className="text-sm font-semibold sm:col-span-3">Details <span className="font-normal text-muted">(optional)</span><textarea className="field mt-2 min-h-20 resize-y py-3" value={draft.value.detail} onChange={(item) => set("detail", item.target.value)} maxLength={1200} /></label>
    </div>
    {error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">{error}</p>}
    <div className="mt-4 flex justify-end"><button type="submit" className="control-primary min-w-32" disabled={saving}>{saving ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />Saving</span> : event ? "Save" : "Add"}</button></div>
  </motion.form>;
}

/** The plain timeline: newest first, most recent 30 unless expanded. */
function Timeline({ incident, onAdd }: { incident: Incident; onAdd(): void }) {
  const { formatDateTime } = useTimeZone();
  const [showAll, setShowAll] = useState(false);
  const events = incident.events.filter((event) => event.evidenceState !== "excluded").slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const hidden = incident.events.length - events.length;
  const visible = showAll ? events : events.slice(0, 30);
  return <section className="surface-lined overflow-hidden" aria-labelledby="timeline-title">
    <div className="flex items-center justify-between gap-3 px-5 py-4"><div><h2 id="timeline-title" className="section-title">Timeline</h2><p className="mt-1 text-sm text-muted">{events.length} {events.length === 1 ? "entry" : "entries"}, newest first{hidden ? ` · ${hidden} hidden as not relevant` : ""}</p></div><button className="control-secondary inline-flex items-center gap-2 !min-h-9" onClick={onAdd}><Plus className="h-4 w-4" />Add</button></div>
    <ol className="divide-y divide-line border-t border-line">{visible.map((event) => {
      const link = typeof event.metadata?.sourceUrl === "string" && /^https:\/\//.test(event.metadata.sourceUrl) ? event.metadata.sourceUrl : undefined;
      return <li key={event.id} id={`event-${event.id}`} className="grid gap-1 px-5 py-3 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
        <time className="measurement-number text-xs text-muted" dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", kindTone[event.kind])}>{kindLabel[event.kind]}</span><span className="measurement-number text-xs text-muted">{event.service}</span>{event.provenance === "derived" && <span className="text-xs text-muted">· linked automatically</span>}</div>
          <p className="mt-1 text-sm font-semibold">{event.title}</p>
          {event.detail && event.detail !== event.title && <p className="mt-0.5 break-words text-sm text-muted"><Linkified text={event.detail} /></p>}
          {link && <a href={link} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-info hover:underline">Open source<ExternalLink className="h-3 w-3" /></a>}
        </div>
      </li>;
    })}{!events.length && <li className="px-5 py-10 text-center text-sm text-muted">Nothing recorded yet. Add what you've seen or done.</li>}</ol>
    {events.length > 30 && <button className="w-full border-t border-line px-5 py-3 text-sm font-semibold text-info hover:bg-elevated" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer" : `Show all ${events.length}`}</button>}
  </section>;
}

export function IncidentWorkbenchPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();
  const [editingIncident, setEditingIncident] = useState(false);
  const [editingEvent, setEditingEvent] = useState<IncidentEvent | null | undefined>(undefined);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  // Links into the detailed tools (an `area` or an anchor) open them; otherwise they start closed.
  const [toolsOpen, setToolsOpen] = useState(() => Boolean(params.get("area") || params.get("event") || location.hash));
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow | null>(null);
  const [movingEvent, setMovingEvent] = useState<IncidentEvent | null>(null);
  const [targetIncidentId, setTargetIncidentId] = useState("");
  const incident = useQuery({ queryKey: ["incident", id], queryFn: () => api.incident(id), enabled: Boolean(id), refetchInterval: 10_000 });
  const diagnosis = useQuery({ queryKey: ["diagnosis", id, incident.data?.evidenceRevision, incident.data?.status], queryFn: () => api.diagnosis(id), enabled: Boolean(incident.data) });
  const casework = useQuery({ queryKey: ["casework", id, incident.data?.evidenceRevision, incident.data?.status], queryFn: () => api.casework(id), enabled: Boolean(incident.data) && incident.data?.status !== "resolved" });
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers });
  const incidentOptions = useQuery({ queryKey: ["incidents"], queryFn: api.incidents, enabled: Boolean(movingEvent) });

  const invalidate = () => { for (const key of ["incident", "diagnosis", "casework"]) void queryClient.invalidateQueries({ queryKey: [key, id] }); void queryClient.invalidateQueries({ queryKey: ["incidents"] }); };
  const updateIncident = useMutation({ mutationFn: ({ intakeLink: _link, ...draft }: IncidentDraft) => api.updateIncident(id, draft), onSuccess: (value) => { queryClient.setQueryData(["incident", id], value); setEditingIncident(false); }, onSettled: invalidate });
  const lifecycle = useMutation({
    mutationFn: (input: { reason: string; confirmed?: boolean }) => { const current = incident.data; if (!current || !action) throw new Error("Incident is not loaded."); return api.transitionIncident(id, { action, ...input, expectedEvidenceRevision: current.evidenceRevision ?? current.updatedAt }); },
    onSuccess: (value) => { queryClient.setQueryData(["incident", id], value); setAction(null); },
    onError: () => void incident.refetch(),
    onSettled: invalidate
  });
  const assign = useMutation({ mutationFn: (owner: string) => api.updateIncident(id, { owner }), onSuccess: (next) => queryClient.setQueryData(["incident", id], next), onSettled: invalidate });
  const deleteIncident = useMutation({ mutationFn: () => api.deleteIncident(id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["incidents"] }); navigate("/"); } });
  const saveEvent = useMutation({ mutationFn: (draft: EventDraft) => editingEvent ? api.updateEvent(id, editingEvent.id, draft) : api.createEvent(id, draft), onSuccess: () => setEditingEvent(undefined), onSettled: invalidate });
  const updateEvidenceState = useMutation({ mutationFn: ({ event, state }: { event: IncidentEvent; state: "active" | "excluded" }) => api.updateEvent(id, event.id, { evidenceState: state, correctionReason: state === "excluded" ? "Marked not relevant by a responder." : "Marked relevant again by a responder." }), onSettled: invalidate });
  const moveEvent = useMutation({ mutationFn: () => { if (!movingEvent || !targetIncidentId) throw new Error("Choose an incident to move it to."); return api.moveEvent(id, movingEvent.id, targetIncidentId); }, onSuccess: () => { setMovingEvent(null); setTargetIncidentId(""); invalidate(); } });

  if (incident.isLoading) return <div className="space-y-5"><Skeleton className="h-8 w-40" /><Skeleton className="h-40 w-full rounded-panel" /><Skeleton className="h-96 w-full rounded-panel" /></div>;
  if (incident.error || !incident.data) return <div className="surface-lined mx-auto max-w-xl p-6 text-center"><TriangleAlert className="mx-auto h-7 w-7 text-danger" /><h1 className="mt-3 font-heading text-2xl font-semibold">Incident not found</h1><p className="mt-2 text-sm text-muted">{incident.error instanceof Error ? incident.error.message : "It may have been deleted."}</p><Link to="/" className="control-primary mt-5 inline-flex items-center gap-2"><ArrowLeft className="h-4 w-4" />Back to incidents</Link></div>;

  const value = incident.data;
  const recovery = casework.data?.recovery;
  const ownerLabel = (owner: string) => isUnowned({ owner }) ? "No owner" : members.data?.find((member) => member.email === owner)?.displayName ?? owner;
  const selectEvent = (eventId: string) => { const next = new URLSearchParams(params); next.set("event", eventId); setParams(next, { replace: true }); };
  const next = diagnosis.data?.nextAction;

  // The one thing to do now, and the button that does it.
  const banner = value.status === "resolved"
    ? { tone: "bg-success/10", title: `Resolved ${value.resolvedAt ? formatRelative(value.resolvedAt) : ""}`.trim(), detail: "If it comes back, reopen it so everyone sees it again.", button: { action: "reopen" as const, label: "Reopen", icon: RotateCcw, primary: false } }
    : value.status === "monitoring"
      ? recovery?.state === "verified"
        ? { tone: "bg-success/10", title: "Your sources confirm it's fixed", detail: recovery.reason, button: { action: "resolve" as const, label: "Resolve", icon: CheckCircle2, primary: true } }
        : { tone: recovery?.state === "failed" ? "bg-warning/12" : "bg-info/10", title: recovery?.state === "failed" ? "It doesn't look fixed yet" : "Fixed — watching to make sure it stays fixed", detail: recovery?.automatic || recovery?.state === "failed" ? recovery.reason : "Resolve when you're satisfied it's fixed. If your alerts or CI report recovery, this updates by itself.", button: { action: "resolve" as const, label: "Resolve", icon: CheckCircle2, primary: true } }
      : { tone: "bg-elevated", title: next ? `Next: ${next.label.charAt(0).toLowerCase()}${next.label.slice(1)}` : "Next: find the cause", detail: next?.reason ?? "Look at what changed and the timeline below.", button: { action: "start_monitoring" as const, label: "Mark fixed", icon: Wrench, primary: true } };

  return <div className="space-y-5">
    <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />Incidents</Link>

    <header className="surface-lined p-5 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><SeverityMark value={value.severity} /><StatusMark value={value.status} /><span className="measurement-number text-xs text-muted">{value.code}</span></div>
          <h1 className="mt-3 font-heading text-2xl font-semibold tracking-[-.02em] sm:text-3xl">{value.title}</h1>
          {value.summary && !value.summary.startsWith("Reported by a responder:") && <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{value.summary}</p>}
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div><dt className="sr-only">Service</dt><dd className="measurement-number">{value.service}{value.environment && value.environment !== "unknown" ? ` · ${value.environment}` : ""}</dd></div>
            <div><dt className="inline text-muted">{value.status === "resolved" ? "Lasted " : "Going for "}</dt><dd className="inline font-semibold">{durationBetween(value.startedAt, value.resolvedAt ?? undefined)}</dd></div>
            {value.customerImpact && !/^unknown/i.test(value.customerImpact) && <div><dt className="inline text-muted">Impact: </dt><dd className="inline">{value.customerImpact}</dd></div>}
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="incident-owner">Owner</label>
          <select id="incident-owner" className="field !min-h-10 w-auto max-w-56" value={value.owner} onChange={(event) => assign.mutate(event.target.value)} disabled={assign.isPending || value.status === "resolved"}>
            {isUnowned(value) && <option value={value.owner}>No owner — assign</option>}
            {members.data?.map((member) => <option key={member.userId} value={member.email}>Owner: {member.displayName}</option>)}
            {!isUnowned(value) && !members.data?.some((member) => member.email === value.owner) && <option value={value.owner}>Owner: {ownerLabel(value.owner)}</option>}
          </select>
          <button className="control-secondary inline-flex items-center gap-2" onClick={() => setEditingIncident(true)}><Edit3 className="h-4 w-4" />Edit</button>
          {isAdmin && <button className="control-quiet text-danger hover:text-danger" aria-label={`Delete ${value.code}`} onClick={() => { if (window.prompt(`This permanently deletes ${value.code} and everything in it. Type ${value.code} to confirm.`)?.trim() === value.code) deleteIncident.mutate(); }}><Trash2 className="h-4 w-4" /></button>}
        </div>
      </div>

      <div className={cn("mt-5 flex flex-col gap-3 rounded-control p-4 sm:flex-row sm:items-center sm:justify-between", banner.tone)}>
        <div className="min-w-0"><p className="text-sm font-semibold">{banner.title}</p><p className="mt-1 break-words text-sm text-muted"><Linkified text={banner.detail} /></p></div>
        <div className="flex shrink-0 gap-2">
          {isOpen(value) && <button className="control-secondary" onClick={() => setAction("resolve")}>Resolve</button>}
          <button className={cn("inline-flex items-center gap-2", banner.button.primary ? "control-primary" : "control-secondary")} onClick={() => setAction(banner.button.action)}><banner.button.icon className="h-4 w-4" />{banner.button.label}</button>
        </div>
      </div>
      {(assign.error || deleteIncident.error) && <p role="alert" className="mt-3 text-sm text-danger">{(assign.error ?? deleteIncident.error)?.message}</p>}
    </header>

    {diagnosis.data && diagnosis.data.hypotheses.length > 0 && <section className="surface-lined p-5" aria-labelledby="cause-title">
      <h2 id="cause-title" className="section-title">Likely cause</h2>
      <p className="mt-2 text-sm leading-6">{diagnosis.data.currentExplanation}</p>
      {diagnosis.data.servicePath.length > 1 && <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">{diagnosis.data.servicePath.map((service, index) => <span key={service} className="inline-flex items-center gap-2"><span className="measurement-number rounded-full bg-elevated px-2 py-0.5">{service}</span>{index < diagnosis.data!.servicePath.length - 1 && "→"}</span>)}</p>}
      <p className="mt-3 text-xs text-muted">A best guess from the evidence so far, not proof. Check it before acting on it.</p>
    </section>}

    <div id="what-changed" className="scroll-mt-6"><WhatChanged incident={value} /></div>
    <div className="empty:hidden"><ErrorGroups incident={value} onSelectEvent={(eventId) => { setToolsOpen(true); selectEvent(eventId); }} /></div>

    {editingEvent === null && <EventEditor incidentId={id} defaultService={value.service} saving={saveEvent.isPending} error={saveEvent.error?.message} onCancel={() => setEditingEvent(undefined)} onSave={(draft) => saveEvent.mutate(draft)} />}
    <Timeline incident={value} onAdd={() => setEditingEvent(null)} />

    <section className="surface-lined overflow-hidden">
      <button className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-elevated" aria-expanded={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
        <span><span className="section-title block">Investigation tools</span><span className="mt-1 block text-sm text-muted">Zoomable timeline, evidence corrections, request comparisons, checks, recovery readings, and handoff notes.</span></span>
        <ChevronDown className={cn("h-5 w-5 shrink-0 text-muted transition-transform", toolsOpen && "rotate-180")} />
      </button>
      {toolsOpen && <div className="space-y-6 border-t border-line p-4 sm:p-5">
        <CausalTrace incident={value} selectedEventId={params.get("event")} onSelectEvent={selectEvent} onWindowChange={setTimelineWindow} />
        <EvidenceLedger incident={value} selectedEventId={params.get("event")} visibleWindow={timelineWindow} updating={updateEvidenceState.isPending} onSelect={selectEvent} onEdit={(event) => setEditingEvent(event)} onMove={(event) => setMovingEvent(event)} onEvidenceState={(event, state) => updateEvidenceState.mutate({ event, state })} />
        {editingEvent && <EventEditor incidentId={id} defaultService={value.service} event={editingEvent} saving={saveEvent.isPending} error={saveEvent.error?.message} onCancel={() => setEditingEvent(undefined)} onSave={(draft) => saveEvent.mutate(draft)} />}
        {movingEvent && <div className="surface-lined p-5"><h3 className="section-title">Move to another incident</h3><p className="mt-1 text-sm text-muted">“{movingEvent.title}” will move to the incident you choose.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><select className="field min-w-64" value={targetIncidentId} onChange={(event) => setTargetIncidentId(event.target.value)}><option value="">Choose an incident</option>{incidentOptions.data?.filter((item) => item.id !== id && item.environment === value.environment).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>)}</select><button className="control-primary" disabled={!targetIncidentId || moveEvent.isPending} onClick={() => moveEvent.mutate()}>Move</button><button className="control-quiet" onClick={() => setMovingEvent(null)}>Cancel</button></div>{moveEvent.error && <p className="mt-3 text-sm text-danger">{moveEvent.error.message}</p>}</div>}
        {updateEvidenceState.error && <p role="alert" className="text-sm text-danger">{updateEvidenceState.error.message}</p>}
        <DebuggingInsights incident={value} onSelectEvent={selectEvent} />
        <ResponseConsole incident={value} />
      </div>}
    </section>

    <IncidentEditor open={editingIncident} incident={value} saving={updateIncident.isPending} error={updateIncident.error?.message} onClose={() => { setEditingIncident(false); updateIncident.reset(); }} onSave={(draft) => updateIncident.mutate(draft)} />
    <LifecycleDialog action={action} recovery={recovery} saving={lifecycle.isPending} error={lifecycle.error?.message} onClose={() => { setAction(null); lifecycle.reset(); }} onSubmit={(input) => lifecycle.mutate(input)} />
  </div>;
}
