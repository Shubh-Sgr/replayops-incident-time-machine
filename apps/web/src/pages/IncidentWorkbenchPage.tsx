import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, Edit3, FileWarning, LoaderCircle, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CausalTrace } from "../components/CausalTrace";
import { IncidentEditor, type IncidentDraft } from "../components/IncidentEditor";
import { ResponseConsole } from "../components/ResponseConsole";
import { Skeleton } from "../components/Skeleton";
import { SeverityMark, StatusMark } from "../components/StatusMark";
import { api } from "../lib/api";
import { cn, durationBetween, formatClock } from "../lib/utils";
import type { EventKind, Incident, IncidentEvent } from "../types";

type EventDraft = Omit<IncidentEvent, "id" | "incidentId">;

function EventEditor({ event, saving, error, onCancel, onSave }: { event?: IncidentEvent | null; saving: boolean; error?: string; onCancel(): void; onSave(value: EventDraft): void }) {
  const [timestamp, setTimestamp] = useState("");
  const [service, setService] = useState("");
  const [kind, setKind] = useState<EventKind>("metric");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [impactScore, setImpactScore] = useState(50);

  useEffect(() => {
    setTimestamp(new Date(event?.timestamp ?? Date.now()).toISOString().slice(0, 16));
    setService(event?.service ?? "");
    setKind(event?.kind ?? "metric");
    setTitle(event?.title ?? "");
    setDetail(event?.detail ?? "");
    setImpactScore(event?.impactScore ?? 50);
  }, [event]);

  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    onSave({ timestamp: new Date(timestamp).toISOString(), service: service.trim(), kind, title: title.trim(), detail: detail.trim(), impactScore, metadata: event?.metadata ?? {} });
  }

  return (
    <motion.form className="surface-lined p-5 sm:p-6" initial={{ opacity: 0.5, height: 0 }} animate={{ opacity: 1, height: "auto" }} onSubmit={submit}>
      <div className="flex items-start justify-between gap-4"><div><h2 className="section-title">{event ? "Edit evidence event" : "Add evidence event"}</h2><p className="mt-1 text-sm text-muted">Record an observation, action, or dependency change in incident time.</p></div><button type="button" className="control-quiet !min-h-9" onClick={onCancel}>Cancel</button></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Timestamp<input type="datetime-local" className="field mt-2" value={timestamp} onChange={(e) => setTimestamp(e.target.value)} required /></label>
        <label className="text-sm font-semibold">Service<input className="field mt-2" value={service} onChange={(e) => setService(e.target.value)} required placeholder="inventory-api" /></label>
        <label className="text-sm font-semibold">Event type<select className="field mt-2" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}><option value="alert">Alert</option><option value="deploy">Deploy</option><option value="dependency">Dependency</option><option value="metric">Metric</option><option value="action">Action</option><option value="recovery">Recovery</option></select></label>
        <label className="text-sm font-semibold">Impact score <span className="measurement-number text-muted">{impactScore}/100</span><input type="range" className="mt-3 h-2 w-full cursor-pointer accent-[oklch(var(--accent))]" min="0" max="100" value={impactScore} onChange={(e) => setImpactScore(Number(e.target.value))} /></label>
        <label className="text-sm font-semibold sm:col-span-2">Title<input className="field mt-2" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} /></label>
        <label className="text-sm font-semibold sm:col-span-2">Evidence detail<textarea className="field mt-2 min-h-28 resize-y py-3" value={detail} onChange={(e) => setDetail(e.target.value)} required minLength={8} /></label>
      </div>
      {error && <p role="alert" className="mt-4 rounded-control bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end"><button type="submit" className="control-primary min-w-36" disabled={saving}>{saving ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" /> Saving</span> : event ? "Save event" : "Add to timeline"}</button></div>
    </motion.form>
  );
}

export function IncidentWorkbenchPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editingIncident, setEditingIncident] = useState(false);
  const [editingEvent, setEditingEvent] = useState<IncidentEvent | null | undefined>(undefined);
  const incident = useQuery({ queryKey: ["incident", id], queryFn: () => api.incident(id), enabled: Boolean(id) });

  const updateIncident = useMutation({
    mutationFn: (draft: IncidentDraft) => api.updateIncident(id, draft),
    onSuccess: (value) => { queryClient.setQueryData(["incident", id], value); setEditingIncident(false); },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); void queryClient.invalidateQueries({ queryKey: ["incidents"] }); }
  });
  const deleteIncident = useMutation({
    mutationFn: () => api.deleteIncident(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["incidents"] }); navigate("/incidents"); }
  });
  const saveEvent = useMutation({
    mutationFn: (draft: EventDraft) => editingEvent ? api.updateEvent(id, editingEvent.id, draft) : api.createEvent(id, draft),
    onMutate: async (draft) => {
      await queryClient.cancelQueries({ queryKey: ["incident", id] });
      const previous = queryClient.getQueryData<Incident>(["incident", id]);
      if (previous) {
        const optimistic: IncidentEvent = editingEvent ? { ...editingEvent, ...draft } : { ...draft, id: `optimistic-${Date.now()}`, incidentId: id };
        const events = editingEvent ? previous.events.map((event) => event.id === editingEvent.id ? optimistic : event) : [...previous.events, optimistic];
        queryClient.setQueryData<Incident>(["incident", id], { ...previous, events: events.sort((a, b) => a.timestamp.localeCompare(b.timestamp)) });
      }
      return { previous };
    },
    onError: (_error, _draft, context) => queryClient.setQueryData(["incident", id], context?.previous),
    onSuccess: () => setEditingEvent(undefined),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["incident", id] }); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); }
  });
  const deleteEvent = useMutation({
    mutationFn: (eventId: string) => api.deleteEvent(id, eventId),
    onMutate: async (eventId) => {
      await queryClient.cancelQueries({ queryKey: ["incident", id] });
      const previous = queryClient.getQueryData<Incident>(["incident", id]);
      if (previous) queryClient.setQueryData<Incident>(["incident", id], { ...previous, events: previous.events.filter((event) => event.id !== eventId) });
      return { previous };
    },
    onError: (_error, _eventId, context) => queryClient.setQueryData(["incident", id], context?.previous),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["incident", id] }); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); }
  });

  if (incident.isLoading) return <div className="space-y-5"><Skeleton className="h-8 w-40" /><Skeleton className="h-28 w-full rounded-panel" /><Skeleton className="h-[420px] w-full rounded-panel" /></div>;
  if (incident.error || !incident.data) return <div className="surface-lined mx-auto max-w-xl p-6 text-center"><TriangleAlert className="mx-auto h-7 w-7 text-danger" /><h1 className="mt-3 font-heading text-2xl font-semibold">Incident record unavailable</h1><p className="mt-2 text-sm text-muted">{incident.error instanceof Error ? incident.error.message : "This incident may have been deleted."}</p><Link to="/incidents" className="control-primary mt-5 inline-flex items-center gap-2"><ArrowLeft className="h-4 w-4" /> Return to ledger</Link></div>;

  const value = incident.data;

  return (
    <div className="space-y-6">
      <Link to="/incidents" className="inline-flex items-center gap-2 text-sm font-semibold text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> Incident ledger</Link>
      <header className="surface-lined p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 max-w-4xl">
            <div className="flex flex-wrap items-center gap-2"><span className="measurement-number text-xs text-muted">{value.code}</span><SeverityMark value={value.severity} /><StatusMark value={value.status} /></div>
            <h1 className="mt-3 font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">{value.title}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-muted">{value.summary}</p>
          </div>
          <div className="flex flex-wrap gap-2"><button className="control-secondary inline-flex items-center gap-2" onClick={() => setEditingIncident(true)}><Edit3 className="h-4 w-4" /> Edit</button><button className="control-quiet inline-flex items-center gap-2 text-danger hover:text-danger" onClick={() => { if (window.confirm(`Delete ${value.code} and all recorded events?`)) deleteIncident.mutate(); }}><Trash2 className="h-4 w-4" /> Delete</button></div>
        </div>
        <dl className="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-muted">Duration</dt><dd className="measurement-number mt-1 text-sm font-semibold">{durationBetween(value.startedAt, value.resolvedAt ?? undefined)}</dd></div>
          <div><dt className="text-xs text-muted">Primary service</dt><dd className="measurement-number mt-1 text-sm">{value.service}</dd></div>
          <div><dt className="text-xs text-muted">Owner</dt><dd className="mt-1 text-sm font-semibold">{value.owner}</dd></div>
          <div><dt className="text-xs text-muted">Recorded evidence</dt><dd className="measurement-number mt-1 text-sm font-semibold">{value.events.length} events</dd></div>
        </dl>
      </header>

      <section aria-labelledby="reconstruction-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 id="reconstruction-title" className="section-title">Incident reconstruction</h2><p className="mt-1 text-sm text-muted">Use arrow keys while focused on the trace to move through incident time.</p></div><button className="control-primary inline-flex items-center gap-2" onClick={() => setEditingEvent(null)}><Plus className="h-4 w-4" /> Add evidence</button></div>
        <CausalTrace incident={value} />
      </section>

      <ResponseConsole incident={value} />

      {editingEvent !== undefined && <EventEditor event={editingEvent} saving={saveEvent.isPending} error={saveEvent.error instanceof Error ? saveEvent.error.message : undefined} onCancel={() => setEditingEvent(undefined)} onSave={(draft) => saveEvent.mutate(draft)} />}

      <div>
        <section className="surface-lined overflow-hidden" aria-labelledby="evidence-title">
          <div className="px-5 py-5 sm:px-6"><h2 id="evidence-title" className="section-title">Evidence ledger</h2><p className="mt-1 text-sm text-muted">Observations and actions remain editable and auditable.</p></div>
          <div className="divide-y divide-line border-t border-line">
            {value.events.map((event) => (
              <div key={event.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[86px_110px_1fr_auto] sm:items-start sm:px-6">
                <span className="measurement-number text-xs text-muted">{formatClock(event.timestamp)}</span>
                <span className="measurement-number text-xs text-muted">{event.service}</span>
                <div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{event.title}</span><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold uppercase", event.kind === "alert" ? "bg-danger/10 text-danger" : event.kind === "recovery" ? "bg-success/10 text-success" : "bg-info/10 text-info")}>{event.kind}</span></div><p className="mt-1 text-xs leading-5 text-muted">{event.detail}</p></div>
                <div className="flex gap-1"><button className="control-quiet !min-h-8 !px-2" onClick={() => setEditingEvent(event)} aria-label={`Edit ${event.title}`}><Edit3 className="h-3.5 w-3.5" /></button><button className="control-quiet !min-h-8 !px-2 text-danger hover:text-danger" onClick={() => deleteEvent.mutate(event.id)} aria-label={`Delete ${event.title}`}><Trash2 className="h-3.5 w-3.5" /></button></div>
              </div>
            ))}
            {!value.events.length && <div className="px-6 py-12 text-center"><FileWarning className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No timeline evidence yet</p><p className="mt-1 text-sm text-muted">Add an alert, deploy, metric, dependency, action, or recovery event.</p></div>}
          </div>
        </section>
      </div>

      {(deleteIncident.error || deleteEvent.error) && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger">{(deleteIncident.error ?? deleteEvent.error) instanceof Error ? (deleteIncident.error ?? deleteEvent.error)?.message : "The requested change could not be completed."}</p>}

      <IncidentEditor open={editingIncident} incident={value} saving={updateIncident.isPending} error={updateIncident.error instanceof Error ? updateIncident.error.message : undefined} onClose={() => setEditingIncident(false)} onSave={(draft) => updateIncident.mutate(draft)} />
    </div>
  );
}
