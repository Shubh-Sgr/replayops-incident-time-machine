import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BellRing, CheckCircle2, Plus, RadioTower, Search, TriangleAlert, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { IncidentEditor } from "../components/IncidentEditor";
import { Skeleton } from "../components/Skeleton";
import { SeverityMark, StatusMark } from "../components/StatusMark";
import { api } from "../lib/api";
import { createIncidentFromDraft, isOpen, isSelfTest, isUnowned } from "../lib/incidents";
import { useOwnerName } from "../lib/useOwnerName";
import { cn, formatRelative } from "../lib/utils";
import { useAuth } from "../providers/AuthProvider";
import type { Incident } from "../types";

type View = "open" | "fixed" | "resolved" | "all";
const views: Array<{ id: View; label: string; matches(incident: Incident): boolean }> = [
  { id: "open", label: "Open", matches: isOpen },
  { id: "fixed", label: "Fixed", matches: (incident) => incident.status === "monitoring" },
  { id: "resolved", label: "Resolved", matches: (incident) => incident.status === "resolved" },
  { id: "all", label: "All", matches: () => true }
];
const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** One thing to do next, so the list never needs a legend. */
function nextStep(incident: Incident) {
  if (incident.status === "monitoring") return "Confirm it stays fixed, then resolve";
  if (isUnowned(incident)) return "Needs an owner";
  return "Find the cause";
}

/** The one setup step that matters most right now, if any. */
function SetupPrompt() {
  const sources = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const alerts = useQuery({ queryKey: ["alert-channels"], queryFn: api.alertChannels });
  if (!sources.data || !alerts.data) return null;
  const receiving = sources.data.some((source) => source.deliveries.some((delivery) => !isSelfTest(delivery.externalId)));
  const prompt = !receiving
    ? { to: "/integrations", icon: RadioTower, title: "Connect a source so incidents open by themselves", detail: "GitHub, OpenTelemetry, Grafana, or any webhook. Takes about two minutes." }
    : !alerts.data.length
      ? { to: "/workspace?tab=alerts", icon: BellRing, title: "Nobody is told when an incident opens", detail: "Add an email, Slack, or phone alert." }
      : null;
  if (!prompt) return null;
  return <Link to={prompt.to} className="surface-lined flex items-center gap-3 p-4 transition-colors hover:bg-elevated"><prompt.icon className="h-5 w-5 shrink-0 text-info" /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{prompt.title}</span><span className="block text-sm text-muted">{prompt.detail}</span></span><ArrowRight className="h-4 w-4 shrink-0 text-muted" /></Link>;
}

export function IncidentsPage() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("open");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ownerName = useOwnerName();
  const { user } = useAuth();
  const incidents = useQuery({ queryKey: ["incidents"], queryFn: api.incidents, refetchInterval: 20_000 });
  const create = useMutation({
    mutationFn: createIncidentFromDraft,
    onSuccess: (created) => { setCreating(false); void queryClient.invalidateQueries({ queryKey: ["incidents"] }); navigate(`/incidents/${created.id}`); }
  });

  const list = useMemo(() => {
    const selected = views.find((item) => item.id === view)!;
    const text = query.trim().toLowerCase();
    return (incidents.data ?? [])
      .filter((incident) => selected.matches(incident) && (!text || `${incident.code} ${incident.title} ${incident.service} ${incident.owner}`.toLowerCase().includes(text)))
      .sort((a, b) => view === "open" ? severityOrder[a.severity] - severityOrder[b.severity] || b.startedAt.localeCompare(a.startedAt) : b.startedAt.localeCompare(a.startedAt));
  }, [incidents.data, query, view]);
  const counts = Object.fromEntries(views.map((item) => [item.id, (incidents.data ?? []).filter(item.matches).length])) as Record<View, number>;

  return <div className="space-y-5">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Incidents</h1><p className="mt-1 text-sm text-muted">{counts.open ? `${counts.open} open${counts.fixed ? ` · ${counts.fixed} fixed and being watched` : ""}` : "Nothing is broken right now."}</p></div>
      <button className="control-primary inline-flex items-center justify-center gap-2" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New incident</button>
    </header>

    <SetupPrompt />

    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex overflow-x-auto rounded-control bg-rail p-1" role="tablist" aria-label="Incident views">{views.map((item) => <button key={item.id} role="tab" aria-selected={view === item.id} className={cn("min-h-9 shrink-0 rounded-[8px] px-3 text-sm font-semibold", view === item.id ? "bg-ink text-panel" : "text-muted hover:bg-elevated")} onClick={() => setView(item.id)}>{item.label}{item.id !== "all" && <span className="ml-1.5 measurement-number opacity-70">{counts[item.id]}</span>}</button>)}</div>
      <label className="relative sm:w-72"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><span className="sr-only">Search incidents</span><input className="field pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title, service, or code" /></label>
    </div>

    {incidents.isLoading ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 w-full rounded-panel" />)}</div>
      : incidents.error ? <div className="surface-lined p-6 text-center"><TriangleAlert className="mx-auto h-6 w-6 text-danger" /><p className="mt-3 font-semibold">Couldn't load incidents</p><p className="mt-1 text-sm text-muted">{incidents.error instanceof Error ? incidents.error.message : "Try again in a moment."}</p><button className="control-primary mt-4" onClick={() => void incidents.refetch()}>Try again</button></div>
      : <div className="surface-lined divide-y divide-line overflow-hidden">
        {list.map((incident) => <Link key={incident.id} to={`/incidents/${incident.id}`} className="group flex items-start gap-4 px-4 py-4 transition-colors hover:bg-elevated sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><SeverityMark value={incident.severity} /><StatusMark value={incident.status} /><span className="measurement-number text-xs text-muted">{incident.code}</span></div>
            <p className="mt-2 truncate font-semibold">{incident.title}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"><span className="measurement-number">{incident.service}{incident.environment && incident.environment !== "unknown" ? ` · ${incident.environment}` : ""}</span><span>started {formatRelative(incident.startedAt)}</span><span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />{isUnowned(incident) ? "No owner" : incident.owner === user?.email ? "You" : ownerName(incident.owner)}</span></p>
          </div>
          {incident.status !== "resolved" && <span className="hidden shrink-0 self-center text-xs font-semibold text-info sm:block">{nextStep(incident)}</span>}
          <ArrowRight className="mt-1 h-4 w-4 shrink-0 self-center text-faint transition-transform group-hover:translate-x-1" />
        </Link>)}
        {!list.length && <div className="px-6 py-14 text-center">{view === "open" && !query ? <><CheckCircle2 className="mx-auto h-7 w-7 text-success" /><p className="mt-3 font-semibold">No open incidents</p><p className="mt-1 text-sm text-muted">New incidents show up here automatically from your sources, or create one yourself.</p></> : <><p className="font-semibold">Nothing matches</p><p className="mt-1 text-sm text-muted">Try another tab or clear the search.</p></>}</div>}
      </div>}

    <IncidentEditor open={creating} saving={create.isPending} error={create.error instanceof Error ? create.error.message : undefined} onClose={() => { setCreating(false); create.reset(); }} onSave={(draft) => create.mutate(draft)} />
  </div>;
}
