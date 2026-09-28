import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { IncidentEditor, type IncidentDraft } from "../components/IncidentEditor";
import { Skeleton } from "../components/Skeleton";
import { SeverityMark, StatusMark } from "../components/StatusMark";
import { api } from "../lib/api";
import { formatRelative } from "../lib/utils";
import type { Incident, IncidentStatus } from "../types";
import { useAuth } from "../providers/AuthProvider";

type InvestigationView = "active" | "mine" | "unassigned" | "waiting" | "resolved" | "all";

export function IncidentsPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<IncidentStatus | "all">("all");
  const [view, setView] = useState<InvestigationView>("active");
  const [service, setService] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [editing, setEditing] = useState<Incident | null | undefined>(undefined);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const incidents = useQuery({ queryKey: ["incidents"], queryFn: api.incidents });
  const save = useMutation({
    mutationFn: async ({ draft, incident }: { draft: IncidentDraft; incident?: Incident | null }) => {
      if(incident) return api.updateIncident(incident.id,draft);
      const created=await api.createIncident(draft);
      if(draft.intakeLink) await api.createEvent(created.id,{timestamp:draft.startedAt,service:draft.service,kind:"alert",title:"Imported alert or trace link",detail:`Investigation started from ${draft.intakeLink}. Verify the source and attach the observed symptom.`,impactScore:65,provenance:"manual",evidenceState:"active",metadata:{sourceUrl:draft.intakeLink,intake:true}});
      return created;
    },
    onSuccess: () => setEditing(undefined),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["incidents"] }); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); }
  });
  const remove = useMutation({
    mutationFn: api.deleteIncident,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["incidents"] });
      const previous = queryClient.getQueryData<Incident[]>(["incidents"]);
      queryClient.setQueryData<Incident[]>(["incidents"], (current) => current?.filter((incident) => incident.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => queryClient.setQueryData(["incidents"], context?.previous),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["incidents"] }); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); }
  });

  const filtered = useMemo(() => (incidents.data ?? []).filter((incident) => {
    const matchesStatus = status === "all" || incident.status === status;
    const matchesView = view === "all" || (view === "active" && incident.status !== "resolved") || (view === "resolved" && incident.status === "resolved") || (view === "waiting" && incident.status === "monitoring") || (view === "unassigned" && (!incident.owner || incident.owner.toLowerCase() === "unassigned")) || (view === "mine" && (incident.owner === user?.email || incident.owner === user?.name));
    const matchesService = service === "all" || incident.service === service;
    const matchesSeverity = severity === "all" || incident.severity === severity;
    const value = `${incident.code} ${incident.title} ${incident.service} ${incident.owner}`.toLowerCase();
    return matchesStatus && matchesView && matchesService && matchesSeverity && value.includes(query.toLowerCase());
  }), [incidents.data, query, status, view, service, severity, user]);
  const services = [...new Set((incidents.data ?? []).map((item) => item.service))];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">All investigations</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Start with an alert or trace link and fill unknowns as evidence arrives.</p></div>
        <button className="control-primary inline-flex items-center justify-center gap-2" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Quick intake</button>
      </header>

      <div className="flex overflow-x-auto rounded-control bg-rail p-1" role="tablist" aria-label="Investigation views">{(["active","mine","unassigned","waiting","resolved","all"] as const).map((item)=><button key={item} role="tab" aria-selected={view===item} className={view===item?"min-h-10 shrink-0 rounded-[8px] bg-ink px-3 text-sm font-semibold capitalize text-panel":"min-h-10 shrink-0 rounded-[8px] px-3 text-sm font-semibold capitalize text-muted hover:bg-elevated"} onClick={()=>setView(item)}>{item}</button>)}</div>

      <div className="surface-lined grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_180px_180px_170px]">
        <label className="relative flex-1"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><span className="sr-only">Filter incidents</span><input className="field pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by incident, service, or owner" /></label>
        <label className="relative sm:w-48"><Filter className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><span className="sr-only">Filter by status</span><select className="field pl-10" value={status} onChange={(event) => setStatus(event.target.value as IncidentStatus | "all")}><option value="all">All statuses</option><option value="investigating">Investigating</option><option value="identified">Identified</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select></label>
        <label><span className="sr-only">Filter by service</span><select className="field" value={service} onChange={(event)=>setService(event.target.value)}><option value="all">All services</option>{services.map((item)=><option key={item}>{item}</option>)}</select></label>
        <label><span className="sr-only">Filter by severity</span><select className="field" value={severity} onChange={(event)=>setSeverity(event.target.value)}><option value="all">All severities</option>{["critical","high","medium","low"].map((item)=><option key={item}>{item}</option>)}</select></label>
      </div>

      {incidents.isLoading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-24 w-full rounded-panel" />)}</div> : incidents.error ? (
        <div className="surface-lined p-6 text-center"><TriangleAlert className="mx-auto h-6 w-6 text-danger" /><p className="mt-3 font-semibold">Could not load incidents</p><p className="mt-2 text-sm text-muted">{incidents.error instanceof Error ? incidents.error.message : "The incident list could not be loaded."}</p><button className="control-primary mt-4" onClick={() => void incidents.refetch()}>Retry</button></div>
      ) : (
        <div className="surface-lined overflow-hidden">
          <div className="hidden grid-cols-[100px_minmax(260px,1fr)_150px_130px_150px_170px_52px] gap-4 border-b border-line bg-rail px-5 py-3 text-xs font-semibold text-muted lg:grid">
            <span>Record</span><span>Impact / investigation</span><span>Environment</span><span>Status</span><span>Owner</span><span>Freshness / next</span><span><span className="sr-only">Actions</span></span>
          </div>
          <div className="divide-y divide-line">
            {filtered.map((incident) => (
              <div key={incident.id} className="grid gap-3 px-4 py-4 transition-colors hover:bg-elevated sm:px-5 lg:grid-cols-[100px_minmax(260px,1fr)_150px_130px_150px_170px_52px] lg:items-center lg:gap-4">
                <span className="measurement-number text-xs text-muted">{incident.code}</span>
                <div className="min-w-0"><Link to={`/incidents/${incident.id}?area=investigate`} className="font-semibold text-ink underline decoration-transparent underline-offset-4 hover:decoration-line">{incident.title}</Link><p className="mt-1 line-clamp-1 text-xs text-muted">{incident.customerImpact || "Impact unknown"}</p><div className="mt-1 flex flex-wrap items-center gap-2"><span className="measurement-number text-xs text-muted">{incident.service}</span><SeverityMark value={incident.severity} /></div></div>
                <span className="measurement-number text-xs text-muted">{incident.environment ?? "unknown"}</span>
                <StatusMark value={incident.status} />
                <span className="text-sm text-muted lg:text-ink">{incident.owner || "Unassigned"}</span>
                <span className="text-xs text-muted">{formatRelative(incident.evidenceRevision ?? incident.updatedAt)}<span className="mt-1 block font-semibold text-info">{incident.status==="monitoring"?"Verify recovery":incident.events.length<2?"Acquire evidence":"Run next test"}</span></span>
                <div className="flex gap-1 lg:justify-end"><button className="control-quiet !min-h-9 !px-2.5" onClick={() => setEditing(incident)} aria-label={`Edit ${incident.code}`}>Edit</button><button className="control-quiet !min-h-9 !px-2.5 text-danger hover:text-danger" onClick={() => { if (window.confirm(`Delete ${incident.code}? This also removes its timeline.`)) remove.mutate(incident.id); }} aria-label={`Delete ${incident.code}`}><Trash2 className="h-4 w-4" /></button></div>
              </div>
            ))}
            {!filtered.length && <div className="px-6 py-14 text-center"><p className="font-semibold">No incidents match this view</p><p className="mt-1 text-sm text-muted">Clear the filters or create a new incident record.</p></div>}
          </div>
        </div>
      )}

      {remove.error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger">{remove.error instanceof Error ? remove.error.message : "The incident could not be deleted."}</p>}

      <IncidentEditor open={editing !== undefined} incident={editing} saving={save.isPending} error={save.error instanceof Error ? save.error.message : undefined} onClose={() => setEditing(undefined)} onSave={(draft) => save.mutate({ draft, incident: editing })} />
    </div>
  );
}
