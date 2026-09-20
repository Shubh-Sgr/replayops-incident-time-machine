import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock3, Play, Plus, Radio, Server, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { CausalTrace } from "../components/CausalTrace";
import { EventVolumeChart } from "../components/EventVolumeChart";
import { DashboardSkeleton } from "../components/Skeleton";
import { IncidentEditor, type IncidentDraft } from "../components/IncidentEditor";
import { SeverityMark, StatusMark } from "../components/StatusMark";
import { api } from "../lib/api";
import { cn, durationBetween, formatRelative } from "../lib/utils";
import type { DashboardData, Incident } from "../types";

export function DashboardPage() {
  const [editorOpen, setEditorOpen] = useState(false);
  const queryClient = useQueryClient();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const createIncident = useMutation({
    mutationFn: (draft: IncidentDraft) => api.createIncident(draft),
    onMutate: async (draft) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard"] });
      const previous = queryClient.getQueryData<DashboardData>(["dashboard"]);
      const optimistic: Incident = {
        ...draft,
        id: `optimistic-${Date.now()}`,
        code: "ROP-NEW",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: []
      };
      queryClient.setQueryData<DashboardData>(["dashboard"], (current) => current ? { ...current, incidents: [optimistic, ...current.incidents] } : current);
      return { previous };
    },
    onError: (_error, _draft, context) => queryClient.setQueryData(["dashboard"], context?.previous),
    onSuccess: () => setEditorOpen(false),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
    }
  });

  if (dashboard.isLoading) return <DashboardSkeleton />;
  if (dashboard.error || !dashboard.data) {
    return (
      <div className="surface-lined mx-auto max-w-xl p-6 text-center">
        <TriangleAlert className="mx-auto h-7 w-7 text-danger" />
        <h1 className="mt-4 font-heading text-2xl font-semibold">Operations data is unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted">{dashboard.error instanceof Error ? dashboard.error.message : "The dashboard could not be loaded."}</p>
        <button className="control-primary mt-5" onClick={() => void dashboard.refetch()}>Retry dashboard</button>
      </div>
    );
  }

  const data = dashboard.data;
  const activeIncident = data.incidents.find((incident) => incident.status !== "resolved") ?? data.incidents[0];
  const activeCount = data.incidents.filter((incident) => incident.status !== "resolved").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Operations, reconstructed</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Follow active pressure through the system, inspect the evidence, and compare a fix against the recorded sequence.</p>
        </div>
        <button className="control-primary inline-flex items-center justify-center gap-2" onClick={() => setEditorOpen(true)}><Plus className="h-4 w-4" /> Create incident</button>
      </header>

      {activeIncident ? (
        <section className="surface overflow-hidden" aria-labelledby="active-incident-title">
          <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 p-4 sm:p-6">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><SeverityMark value={activeIncident.severity} /><StatusMark value={activeIncident.status} /><span className="measurement-number text-xs text-muted">{activeIncident.code}</span></div>
                  <h2 id="active-incident-title" className="mt-3 max-w-3xl break-words font-heading text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">{activeIncident.title}</h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{activeIncident.summary}</p>
                </div>
                <Link to={`/incidents/${activeIncident.id}`} className="control-secondary inline-flex items-center gap-2">Open workbench <ArrowRight className="h-4 w-4" /></Link>
              </div>
              <CausalTrace incident={activeIncident} />
            </div>
            <aside className="border-t border-line bg-rail p-5 xl:border-l xl:border-t-0" aria-label="Active incident measurements">
              <h3 className="section-title">Incident record</h3>
              <dl className="mt-5 divide-y divide-line">
                <div className="flex items-center justify-between py-3"><dt className="text-sm text-muted">Duration</dt><dd className="measurement-number text-sm font-semibold">{durationBetween(activeIncident.startedAt)}</dd></div>
                <div className="flex items-center justify-between py-3"><dt className="text-sm text-muted">Primary service</dt><dd className="measurement-number text-xs">{activeIncident.service}</dd></div>
                <div className="flex items-center justify-between py-3"><dt className="text-sm text-muted">Owner</dt><dd className="text-sm font-semibold">{activeIncident.owner}</dd></div>
                <div className="flex items-center justify-between py-3"><dt className="text-sm text-muted">Evidence events</dt><dd className="measurement-number text-sm font-semibold">{activeIncident.events.length}</dd></div>
              </dl>
              <div className="mt-5 rounded-control bg-accent/12 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-accent"><Play className="h-4 w-4" /> Replay in progress</div>
                <p className="mt-2 text-xs leading-5 text-muted">Testing retry ceiling against the recorded sequence.</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full w-[68%] rounded-full bg-accent" /></div>
                <p className="measurement-number mt-2 text-right text-[10px] text-muted">68% · SYNTHETIC</p>
              </div>
            </aside>
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.55fr)]">
        <section className="surface-lined p-5 sm:p-6" aria-labelledby="traffic-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 id="traffic-title" className="section-title">System pressure</h2><p className="mt-1 text-sm text-muted">Request volume and errors across the active replay window.</p></div>
            <span className="measurement-number text-xs text-muted">WINDOW 00:30:00</span>
          </div>
          <div className="mt-5"><EventVolumeChart data={data.eventVolume} /></div>
        </section>

        <section className="surface-lined overflow-hidden" aria-labelledby="service-health-title">
          <div className="flex items-center justify-between px-5 py-5 sm:px-6"><div><h2 id="service-health-title" className="section-title">Service pressure</h2><p className="mt-1 text-sm text-muted">Live operational indicators</p></div><Server className="h-5 w-5 text-muted" /></div>
          <div className="divide-y divide-line border-t border-line">
            {data.serviceHealth.map((service) => (
              <div key={service.service} className="grid grid-cols-[1fr_auto] gap-4 px-5 py-3.5 sm:px-6">
                <div className="min-w-0"><p className="measurement-number truncate text-xs font-semibold">{service.service}</p><p className="mt-1 text-xs text-muted">{service.latencyMs}ms · {service.errorRate}% errors</p></div>
                <div className="flex items-center gap-2"><span className={cn("status-dot", service.state === "nominal" ? "bg-success" : service.state === "degraded" ? "bg-warning" : "bg-danger animate-trace-pulse")} /><span className="measurement-number text-xs">{service.availability}%</span></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="surface-lined overflow-hidden" aria-labelledby="incidents-title">
          <div className="flex items-center justify-between px-5 py-5 sm:px-6"><div><h2 id="incidents-title" className="section-title">Incident ledger</h2><p className="mt-1 text-sm text-muted">{activeCount} active across the workspace</p></div><Link to="/incidents" className="text-sm font-semibold text-ink underline decoration-line underline-offset-4">View all</Link></div>
          <div className="divide-y divide-line border-t border-line">
            {data.incidents.slice(0, 4).map((incident) => (
              <Link key={incident.id} to={`/incidents/${incident.id}`} className="group grid gap-2 px-5 py-4 transition-colors hover:bg-elevated sm:grid-cols-[86px_1fr_auto] sm:items-center sm:px-6">
                <span className="measurement-number text-xs text-muted">{incident.code}</span>
                <span className="min-w-0"><span className="block truncate text-sm font-semibold">{incident.title}</span><span className="mt-1 block text-xs text-muted">{incident.service} · {formatRelative(incident.updatedAt)}</span></span>
                <StatusMark value={incident.status} />
              </Link>
            ))}
          </div>
        </section>

        <section className="surface-lined overflow-hidden" aria-labelledby="activity-title">
          <div className="px-5 py-5 sm:px-6"><h2 id="activity-title" className="section-title">Operations ledger</h2><p className="mt-1 text-sm text-muted">Latest human and system actions</p></div>
          <div className="divide-y divide-line border-t border-line">
            {data.activities.map((activity) => (
              <div key={activity.id} className="flex gap-3 px-5 py-4 sm:px-6">
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated">{activity.actor === "System" ? <Radio className="h-3.5 w-3.5 text-info" /> : activity.actor.includes("worker") ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Clock3 className="h-3.5 w-3.5 text-accent" />}</span>
                <div><p className="text-sm"><strong>{activity.actor}</strong> {activity.action}</p><p className="mt-1 text-xs leading-5 text-muted">{activity.detail} · {formatRelative(activity.timestamp)}</p></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <IncidentEditor
        open={editorOpen}
        saving={createIncident.isPending}
        error={createIncident.error instanceof Error ? createIncident.error.message : undefined}
        onClose={() => setEditorOpen(false)}
        onSave={(draft) => createIncident.mutate(draft)}
      />
    </div>
  );
}
