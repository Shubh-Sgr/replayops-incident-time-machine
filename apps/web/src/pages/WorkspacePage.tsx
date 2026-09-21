import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, BookOpenCheck, Boxes, CheckCircle2, Copy, DatabaseZap, GitBranch, LoaderCircle, Plus, RotateCcw, ShieldCheck, TriangleAlert, UserPlus, UsersRound, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { cn, formatRelative } from "../lib/utils";
import type { IncidentPolicy, ServiceDefinition, WorkspaceRole } from "../types";

type Mode = "services" | "intake" | "team" | "audit" | "queue";
const modes = [
  { id: "services" as const, label: "Service map", icon: Boxes },
  { id: "intake" as const, label: "Intake policy", icon: Wrench },
  { id: "team" as const, label: "Team access", icon: UsersRound },
  { id: "audit" as const, label: "Audit trail", icon: BookOpenCheck },
  { id: "queue" as const, label: "Delivery queue", icon: DatabaseZap }
];

function ServiceMap() {
  const queryClient = useQueryClient();
  const services = useQuery({ queryKey: ["services"], queryFn: api.services });
  const [draft, setDraft] = useState({ name: "", ownerTeam: "", tier: "standard" as ServiceDefinition["tier"], repositoryUrl: "", runbookUrl: "", dependencies: "" });
  const save = useMutation({
    mutationFn: () => api.saveService({ ...draft, repositoryUrl: draft.repositoryUrl || null, runbookUrl: draft.runbookUrl || null, dependencies: draft.dependencies.split(",").map((item) => item.trim()).filter(Boolean) }),
    onSuccess: () => { setDraft({ name: "", ownerTeam: "", tier: "standard", repositoryUrl: "", runbookUrl: "", dependencies: "" }); void queryClient.invalidateQueries({ queryKey: ["services"] }); }
  });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };

  return <div className="grid gap-6 xl:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.28fr)]">
    <form className="surface-lined p-5 sm:p-6" onSubmit={submit}>
      <h2 className="section-title">Register operational context</h2>
      <p className="mt-2 text-sm leading-6 text-muted">Ownership and dependencies give grouping rules architectural context instead of relying on timestamps alone.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <label className="text-sm font-semibold">Service name<input className="field mt-2" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="checkout-api" required minLength={2} /></label>
        <label className="text-sm font-semibold">Owner team<input className="field mt-2" value={draft.ownerTeam} onChange={(e) => setDraft({ ...draft, ownerTeam: e.target.value })} placeholder="Commerce" required minLength={2} /></label>
        <label className="text-sm font-semibold">Criticality<select className="field mt-2" value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value as ServiceDefinition["tier"] })}><option value="critical">Critical</option><option value="standard">Standard</option><option value="internal">Internal</option></select></label>
        <label className="text-sm font-semibold">Dependencies<input className="field mt-2" value={draft.dependencies} onChange={(e) => setDraft({ ...draft, dependencies: e.target.value })} placeholder="inventory-api, payments-api" /></label>
        <label className="text-sm font-semibold sm:col-span-2 xl:col-span-1 2xl:col-span-2">Repository URL<input type="url" className="field mt-2" value={draft.repositoryUrl} onChange={(e) => setDraft({ ...draft, repositoryUrl: e.target.value })} placeholder="https://github.com/org/repository" /></label>
        <label className="text-sm font-semibold sm:col-span-2 xl:col-span-1 2xl:col-span-2">Runbook URL<input type="url" className="field mt-2" value={draft.runbookUrl} onChange={(e) => setDraft({ ...draft, runbookUrl: e.target.value })} placeholder="https://docs.example.com/runbooks/checkout" /></label>
      </div>
      {save.error && <p role="alert" className="mt-4 rounded-control bg-danger/10 p-3 text-sm text-danger">{save.error.message}</p>}
      <button className="control-primary mt-5 inline-flex w-full items-center justify-center gap-2" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Save service</button>
    </form>
    <section className="surface-lined overflow-hidden" aria-labelledby="catalog-title">
      <div className="px-5 py-5 sm:px-6"><h2 id="catalog-title" className="section-title">Dependency-aware catalog</h2><p className="mt-1 text-sm text-muted">Used by incident grouping, ownership, and mitigation review.</p></div>
      <div className="divide-y divide-line border-t border-line">
        {services.isLoading && <p className="p-6 text-sm text-muted">Loading service context…</p>}
        {services.data?.map((service) => <article key={service.id} className="px-5 py-4 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="measurement-number text-sm font-semibold">{service.name}</span><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize", service.tier === "critical" ? "bg-danger/10 text-danger" : service.tier === "standard" ? "bg-info/10 text-info" : "bg-elevated text-muted")}>{service.tier}</span></div><p className="mt-1 text-sm text-muted">Owned by {service.ownerTeam}</p></div>{service.repositoryUrl && <a className="control-quiet inline-flex !min-h-9 items-center gap-2" href={service.repositoryUrl} target="_blank" rel="noreferrer"><GitBranch className="h-4 w-4" />Repository</a>}</div><div className="mt-3 flex flex-wrap gap-2">{service.dependencies.length ? service.dependencies.map((dependency) => <span key={dependency} className="measurement-number rounded-full bg-elevated px-2.5 py-1 text-xs text-muted">calls {dependency}</span>) : <span className="text-xs text-faint">No dependencies recorded</span>}</div></article>)}
        {services.data && !services.data.length && <div className="px-6 py-12 text-center"><Boxes className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No services registered</p><p className="mt-1 text-sm text-muted">Add the first production service and its owner.</p></div>}
      </div>
    </section>
  </div>;
}

function IntakePolicyPanel() {
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: ["incident-policy"], queryFn: api.incidentPolicy });
  const [draft, setDraft] = useState<Omit<IncidentPolicy, "updatedAt">>({ incidentThreshold: 65, groupingWindowMinutes: 120, suppressLowSeverity: true, maintenanceMode: false });
  useEffect(() => { if (policy.data) setDraft(policy.data); }, [policy.data]);
  const save = useMutation({ mutationFn: () => api.updateIncidentPolicy(draft), onSuccess: (value) => queryClient.setQueryData(["incident-policy"], value) });
  return <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]">
    <section className="surface-lined p-5 sm:p-6"><h2 className="section-title">Decide when evidence becomes an incident</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">These deterministic controls run before AI. They prevent noisy signals from creating low-value investigations and group related evidence into one response window.</p>
      <label className="mt-7 block text-sm font-semibold">Incident threshold <span className="measurement-number float-right text-muted">{draft.incidentThreshold}/100</span><input className="mt-3 h-2 w-full cursor-pointer accent-[oklch(var(--accent))]" type="range" min="30" max="95" value={draft.incidentThreshold} onChange={(e) => setDraft({ ...draft, incidentThreshold: Number(e.target.value) })} /></label>
      <label className="mt-6 block text-sm font-semibold">Grouping window <span className="measurement-number float-right text-muted">{draft.groupingWindowMinutes} minutes</span><input className="mt-3 h-2 w-full cursor-pointer accent-[oklch(var(--accent))]" type="range" min="15" max="360" step="15" value={draft.groupingWindowMinutes} onChange={(e) => setDraft({ ...draft, groupingWindowMinutes: Number(e.target.value) })} /></label>
      <div className="mt-7 divide-y divide-line border-y border-line">
        <label className="flex min-h-16 cursor-pointer items-center justify-between gap-5 py-3"><span><span className="block text-sm font-semibold">Suppress low-severity signals</span><span className="mt-1 block text-xs text-muted">Retain them as evidence without opening an incident.</span></span><input type="checkbox" className="h-5 w-5 accent-[oklch(var(--accent))]" checked={draft.suppressLowSeverity} onChange={(e) => setDraft({ ...draft, suppressLowSeverity: e.target.checked })} /></label>
        <label className="flex min-h-16 cursor-pointer items-center justify-between gap-5 py-3"><span><span className="block text-sm font-semibold">Maintenance mode</span><span className="mt-1 block text-xs text-muted">Buffer all incoming evidence and suspend automatic incident creation.</span></span><input type="checkbox" className="h-5 w-5 accent-[oklch(var(--accent))]" checked={draft.maintenanceMode} onChange={(e) => setDraft({ ...draft, maintenanceMode: e.target.checked })} /></label>
      </div>
      {save.error && <p role="alert" className="mt-4 text-sm text-danger">{save.error.message}</p>}
      <button className="control-primary mt-5" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving policy…" : "Save intake policy"}</button>
    </section>
    <aside className="surface-lined p-5 sm:p-6"><ShieldCheck className="h-6 w-6 text-success" /><h2 className="mt-4 section-title">Current decision boundary</h2><p className="mt-3 text-sm leading-6 text-muted">A signal opens an incident at <strong className="text-ink">{draft.incidentThreshold} impact</strong> unless maintenance mode or low-severity suppression applies. Matching service, trace, release, or correlation evidence joins an open incident within <strong className="text-ink">{draft.groupingWindowMinutes} minutes</strong>.</p><p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-muted">This policy is auditable and affects future ingestion only. Existing incidents are never silently regrouped.</p></aside>
  </div>;
}

function TeamAccess() {
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers });
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: api.invitations, enabled: workspace.data?.role === "admin" });
  const [email, setEmail] = useState(""); const [role, setRole] = useState<WorkspaceRole>("responder"); const [inviteLink, setInviteLink] = useState("");
  const invite = useMutation({ mutationFn: () => api.createInvitation(email, role), onSuccess: (value) => { setInviteLink(`${window.location.origin}/accept-invite?token=${value.inviteToken}`); setEmail(""); void queryClient.invalidateQueries({ queryKey: ["invitations"] }); } });
  const updateRole = useMutation({ mutationFn: ({ id, value }: { id: string; value: WorkspaceRole }) => api.updateMemberRole(id, value), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["team-members"] }) });
  return <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]"><section className="surface-lined overflow-hidden"><div className="px-5 py-5 sm:px-6"><h2 className="section-title">Workspace members</h2><p className="mt-1 text-sm text-muted">Roles are enforced by the API, not only by the interface.</p></div><div className="divide-y divide-line border-t border-line">{members.data?.map((member) => <div key={member.userId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div><p className="font-semibold">{member.displayName}</p><p className="mt-1 text-xs text-muted">{member.email} · joined {formatRelative(member.joinedAt)}</p></div><select aria-label={`Role for ${member.email}`} className="field w-full sm:w-40" value={member.role} disabled={workspace.data?.role !== "admin" || updateRole.isPending} onChange={(e) => updateRole.mutate({ id: member.userId, value: e.target.value as WorkspaceRole })}><option value="admin">Admin</option><option value="responder">Responder</option><option value="viewer">Viewer</option></select></div>)}</div></section>
    <div className="space-y-6"><form className="surface-lined p-5 sm:p-6" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}><UserPlus className="h-6 w-6 text-accent" /><h2 className="mt-4 section-title">Invite a teammate</h2><p className="mt-2 text-sm leading-6 text-muted">ReplayOps creates a seven-day invite link. Share it through your approved channel.</p><label className="mt-5 block text-sm font-semibold">Email<input type="email" className="field mt-2" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label className="mt-4 block text-sm font-semibold">Role<select className="field mt-2" value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}><option value="responder">Responder</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><button className="control-primary mt-4 w-full" disabled={invite.isPending || workspace.data?.role !== "admin"}>Create invite link</button>{inviteLink && <div className="mt-4 rounded-control bg-elevated p-3"><p className="text-xs text-muted">Link shown once</p><button type="button" className="mt-2 flex w-full items-center gap-2 text-left text-xs font-semibold" onClick={() => void navigator.clipboard.writeText(inviteLink)}><Copy className="h-4 w-4 shrink-0" /><span className="truncate">{inviteLink}</span></button></div>}{invite.error && <p className="mt-3 text-sm text-danger">{invite.error.message}</p>}</form>
      {invitations.data?.length ? <section className="surface-lined p-5"><h3 className="font-semibold">Pending invitations</h3><div className="mt-3 space-y-3">{invitations.data.slice(0, 4).map((item) => <div key={item.id} className="text-sm"><p className="font-semibold">{item.email}</p><p className="mt-1 text-xs text-muted">{item.role} · {item.status}</p></div>)}</div></section> : null}
    </div></div>;
}

function AuditTrail() { const audit = useQuery({ queryKey: ["audit"], queryFn: api.audit }); return <section className="surface-lined overflow-hidden"><div className="px-5 py-5 sm:px-6"><h2 className="section-title">Immutable operations trail</h2><p className="mt-1 text-sm text-muted">Successful mutations and governed actions are recorded with actor, target, and time.</p></div><div className="divide-y divide-line border-t border-line">{audit.data?.map((entry) => <article key={entry.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[170px_minmax(0,1fr)_auto] sm:items-start sm:px-6"><span className="measurement-number text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</span><div><p className="text-sm font-semibold">{entry.action}</p><p className="mt-1 text-xs text-muted">{entry.actor} · {entry.targetType}{entry.targetId ? ` · ${entry.targetId.slice(0, 12)}` : ""}</p></div><ShieldCheck className="h-4 w-4 text-success" /></article>)}{audit.data && !audit.data.length && <div className="px-6 py-12 text-center"><Activity className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No governed changes yet</p></div>}</div></section>; }

function QueueHealth() { const queryClient = useQueryClient(); const queue = useQuery({ queryKey: ["queue"], queryFn: api.queue, refetchInterval: 15_000 }); const retry = useMutation({ mutationFn: api.retryQueueJob, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["queue"] }) }); const counts = queue.data?.reduce<Record<string, number>>((map, item) => ({ ...map, [item.status]: (map[item.status] ?? 0) + 1 }), {}) ?? {}; return <div className="space-y-5"><div className="surface-lined grid divide-y divide-line sm:grid-cols-4 sm:divide-x sm:divide-y-0">{[["Completed", counts.completed ?? 0],["Waiting", (counts.queued ?? 0)+(counts.retrying ?? 0)],["Processing", counts.processing ?? 0],["Dead letter", counts.dead_letter ?? 0]].map(([label,value]) => <div key={String(label)} className="p-5"><p className="text-xs text-muted">{label}</p><p className="measurement-number mt-2 text-2xl font-semibold">{value}</p></div>)}</div><section className="surface-lined overflow-hidden"><div className="px-5 py-5 sm:px-6"><h2 className="section-title">Durable delivery queue</h2><p className="mt-1 text-sm text-muted">Normalized deliveries persist before processing. Temporary failures back off; five failed attempts enter dead-letter review.</p></div><div className="divide-y divide-line border-t border-line">{queue.data?.map((job) => <div key={job.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_110px_80px_auto] sm:items-center sm:px-6"><div className="min-w-0"><p className="measurement-number truncate text-xs font-semibold">{job.externalId}</p><p className="mt-1 text-xs text-muted">{formatRelative(job.createdAt)}{job.lastError ? ` · ${job.lastError}` : ""}</p></div><span className={cn("w-fit rounded-full px-2.5 py-1 text-xs font-semibold capitalize", job.status === "completed" ? "bg-success/12 text-success" : job.status === "dead_letter" ? "bg-danger/10 text-danger" : "bg-warning/12 text-warning")}>{job.status.replace("_", " ")}</span><span className="measurement-number text-xs text-muted">{job.attempts} tries</span>{["retrying","dead_letter"].includes(job.status) ? <button className="control-secondary !min-h-9 inline-flex items-center gap-2" onClick={() => retry.mutate(job.id)}><RotateCcw className="h-4 w-4" />Retry</button> : <CheckCircle2 className="h-4 w-4 text-success" />}</div>)}</div></section></div>; }

export function WorkspacePage() {
  const [mode, setMode] = useState<Mode>("services");
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  return <div className="space-y-6"><header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Operational workspace</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Define what ReplayOps observes, how it groups evidence, who can act, and how every change is reviewed.</p></div><span className="measurement-number w-fit rounded-full bg-elevated px-3 py-1.5 text-xs text-muted">{workspace.data?.organizationName ?? "Loading workspace"} · {workspace.data?.role ?? "member"}</span></header>
    <div className="overflow-x-auto"><div className="inline-flex min-w-full gap-1 rounded-panel bg-rail p-1 sm:min-w-0" role="tablist" aria-label="Workspace controls">{modes.map((item) => <button key={item.id} role="tab" aria-selected={mode === item.id} className={cn("flex min-h-11 items-center gap-2 whitespace-nowrap rounded-control px-3 text-sm font-semibold transition-colors", mode === item.id ? "bg-ink text-panel" : "text-muted hover:bg-elevated hover:text-ink")} onClick={() => setMode(item.id)}><item.icon className="h-4 w-4" />{item.label}</button>)}</div></div>
    {workspace.error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger"><TriangleAlert className="mr-2 inline h-4 w-4" />{workspace.error.message}</p>}
    <AnimatePresence mode="wait"><motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>{mode === "services" ? <ServiceMap /> : mode === "intake" ? <IntakePolicyPanel /> : mode === "team" ? <TeamAccess /> : mode === "audit" ? <AuditTrail /> : <QueueHealth />}</motion.div></AnimatePresence>
  </div>;
}
