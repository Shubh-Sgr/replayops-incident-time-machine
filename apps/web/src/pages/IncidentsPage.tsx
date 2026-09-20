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

export function IncidentsPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<IncidentStatus | "all">("all");
  const [editing, setEditing] = useState<Incident | null | undefined>(undefined);
  const queryClient = useQueryClient();
  const incidents = useQuery({ queryKey: ["incidents"], queryFn: api.incidents });
  const save = useMutation({
    mutationFn: ({ draft, incident }: { draft: IncidentDraft; incident?: Incident | null }) => incident ? api.updateIncident(incident.id, draft) : api.createIncident(draft),
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
    const value = `${incident.code} ${incident.title} ${incident.service} ${incident.owner}`.toLowerCase();
    return matchesStatus && value.includes(query.toLowerCase());
  }), [incidents.data, query, status]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Incident ledger</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Every investigation keeps a stable record number, evidence history, and replay state.</p></div>
        <button className="control-primary inline-flex items-center justify-center gap-2" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Create incident</button>
      </header>

      <div className="surface-lined flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
        <label className="relative flex-1"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><span className="sr-only">Filter incidents</span><input className="field pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by incident, service, or owner" /></label>
        <label className="relative sm:w-48"><Filter className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><span className="sr-only">Filter by status</span><select className="field pl-10" value={status} onChange={(event) => setStatus(event.target.value as IncidentStatus | "all")}><option value="all">All statuses</option><option value="investigating">Investigating</option><option value="identified">Identified</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select></label>
      </div>

      {incidents.isLoading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-24 w-full rounded-panel" />)}</div> : incidents.error ? (
        <div className="surface-lined p-6 text-center"><TriangleAlert className="mx-auto h-6 w-6 text-danger" /><p className="mt-3 font-semibold">Could not load incidents</p><button className="control-primary mt-4" onClick={() => void incidents.refetch()}>Retry</button></div>
      ) : (
        <div className="surface-lined overflow-hidden">
          <div className="hidden grid-cols-[100px_minmax(260px,1fr)_160px_140px_120px_52px] gap-4 border-b border-line bg-rail px-5 py-3 text-xs font-semibold text-muted lg:grid">
            <span>Record</span><span>Incident</span><span>Owner</span><span>Status</span><span>Updated</span><span><span className="sr-only">Actions</span></span>
          </div>
          <div className="divide-y divide-line">
            {filtered.map((incident) => (
              <div key={incident.id} className="grid gap-3 px-4 py-4 transition-colors hover:bg-elevated sm:px-5 lg:grid-cols-[100px_minmax(260px,1fr)_160px_140px_120px_52px] lg:items-center lg:gap-4">
                <span className="measurement-number text-xs text-muted">{incident.code}</span>
                <div className="min-w-0"><Link to={`/incidents/${incident.id}`} className="font-semibold text-ink underline decoration-transparent underline-offset-4 hover:decoration-line">{incident.title}</Link><div className="mt-1 flex flex-wrap items-center gap-2"><span className="measurement-number text-xs text-muted">{incident.service}</span><SeverityMark value={incident.severity} /></div></div>
                <span className="text-sm text-muted lg:text-ink">{incident.owner}</span>
                <StatusMark value={incident.status} />
                <span className="text-xs text-muted">{formatRelative(incident.updatedAt)}</span>
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
