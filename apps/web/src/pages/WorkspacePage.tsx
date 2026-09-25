import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, BookOpenCheck, Boxes, CheckCircle2, Copy, DatabaseZap, GitBranch, LoaderCircle, LockKeyhole, MailCheck, Plus, RotateCcw, Send, ShieldCheck, TriangleAlert, UserPlus, UsersRound, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { presentAuditEntry } from "../lib/audit";
import { cn, formatRelative } from "../lib/utils";
import type { IncidentPolicy, PrivacySettings, ServiceDefinition, TeamInvitation, WorkspaceRole } from "../types";

type Mode = "services" | "intake" | "privacy" | "team" | "audit" | "queue";
const modes = [
  { id: "services" as const, label: "Service map", icon: Boxes },
  { id: "intake" as const, label: "Intake policy", icon: Wrench },
  { id: "privacy" as const, label: "Privacy & AI", icon: LockKeyhole },
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
  const incidents=useQuery({queryKey:["incidents"],queryFn:api.incidents});
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
    <aside className="surface-lined p-5 sm:p-6"><ShieldCheck className="h-6 w-6 text-success" /><h2 className="mt-4 section-title">Policy dry run</h2><p className="mt-3 text-sm leading-6 text-muted">Across retained investigation evidence, <strong className="text-ink">{incidents.data?.flatMap((item)=>item.events).filter((event)=>event.impactScore>=draft.incidentThreshold).length??0} events</strong> meet the proposed opening threshold and <strong className="text-ink">{incidents.data?.flatMap((item)=>item.events).filter((event)=>event.impactScore<draft.incidentThreshold).length??0}</strong> would remain buffered or supporting-only.</p><p className="mt-4 text-sm leading-6 text-muted">Related evidence may join an open incident within <strong className="text-ink">{draft.groupingWindowMinutes} minutes</strong>, but only within the same environment and related service identity.</p><p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-muted">Historical preview only. Saving affects future ingestion and never silently rewrites existing investigations.</p></aside>
  </div>;
}

function PrivacyPanel(){const client=useQueryClient();const settings=useQuery({queryKey:["privacy-settings"],queryFn:api.privacySettings});const outcomes=useQuery({queryKey:["product-outcomes"],queryFn:api.productOutcomes});const [draft,setDraft]=useState<Omit<PrivacySettings,"updatedAt">>({externalAiEnabled:true,captureRequestBodies:false,productAnalyticsEnabled:true});useEffect(()=>{if(settings.data)setDraft(settings.data);},[settings.data]);const save=useMutation({mutationFn:()=>api.updatePrivacySettings(draft),onSuccess:(value)=>client.setQueryData(["privacy-settings"],value)});const exportOutcomes=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(outcomes.data??[],null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download="replayops-product-outcomes.json";link.click();URL.revokeObjectURL(url);};return <div className="grid gap-6 lg:grid-cols-[1fr_.72fr]"><section className="surface-lined p-5 sm:p-6"><h2 className="section-title">Provider and capture controls</h2><p className="mt-2 text-sm leading-6 text-muted">Secrets, credentials, emails, IP addresses, and sensitive metadata are redacted before chat, embeddings, or evidence-bundle export.</p><div className="mt-6 divide-y divide-line border-y border-line"><label className="flex min-h-20 cursor-pointer items-center justify-between gap-5 py-3"><span><span className="block text-sm font-semibold">External AI assistance</span><span className="mt-1 block text-xs leading-5 text-muted">When disabled, search and investigation assistance use deterministic local analysis only.</span></span><input type="checkbox" className="h-5 w-5 accent-[oklch(var(--accent))]" checked={draft.externalAiEnabled} onChange={(event)=>setDraft({...draft,externalAiEnabled:event.target.checked})}/></label><label className="flex min-h-20 cursor-pointer items-center justify-between gap-5 py-3"><span><span className="block text-sm font-semibold">Capture request bodies</span><span className="mt-1 block text-xs leading-5 text-muted">Off by default. HTTP replay bodies must be explicitly redacted before capture.</span></span><input type="checkbox" className="h-5 w-5 accent-[oklch(var(--accent))]" checked={draft.captureRequestBodies} onChange={(event)=>setDraft({...draft,captureRequestBodies:event.target.checked})}/></label><label className="flex min-h-20 cursor-pointer items-center justify-between gap-5 py-3"><span><span className="block text-sm font-semibold">Useful-outcome instrumentation</span><span className="mt-1 block text-xs leading-5 text-muted">Measures time-to-evidence, completed tests, corrected grouping, replay execution, and verified recovery—not prompt volume.</span></span><input type="checkbox" className="h-5 w-5 accent-[oklch(var(--accent))]" checked={draft.productAnalyticsEnabled} onChange={(event)=>setDraft({...draft,productAnalyticsEnabled:event.target.checked})}/></label></div><button className="control-primary mt-5" onClick={()=>save.mutate()} disabled={save.isPending}>Save privacy controls</button>{save.error&&<p className="mt-3 text-sm text-danger">{save.error.message}</p>}</section><aside className="surface-lined p-5 sm:p-6"><LockKeyhole className="h-6 w-6 text-info"/><h2 className="mt-4 section-title">Outcome telemetry</h2><p className="mt-2 text-sm leading-6 text-muted">{outcomes.data?.length??0} privacy-aware outcome events are currently retained in the audited workspace log.</p><button className="control-secondary mt-5 w-full" onClick={exportOutcomes}>Export outcome events</button><ul className="mt-5 space-y-2 text-xs leading-5 text-muted"><li>• No prompt text or generated-answer count.</li><li>• No request body or provider credential.</li><li>• Disable collection at any time.</li></ul></aside></div>;}

function TeamAccess() {
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers });
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: api.invitations, enabled: workspace.data?.role === "admin" });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("responder");
  const [inviteResult, setInviteResult] = useState<TeamInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const inviteLink = inviteResult?.inviteToken ? `${window.location.origin}/accept-invite?token=${encodeURIComponent(inviteResult.inviteToken)}` : "";
  const invite = useMutation({
    mutationFn: () => api.createInvitation(email, role),
    onSuccess: (value) => {
      setInviteResult(value);
      setCopied(false);
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
    }
  });
  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const updateRole = useMutation({ mutationFn: ({ id, value }: { id: string; value: WorkspaceRole }) => api.updateMemberRole(id, value), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["team-members"] }) });
  return <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
    <section className="surface-lined overflow-hidden">
      <div className="px-5 py-5 sm:px-6"><h2 className="section-title">Workspace members</h2><p className="mt-1 text-sm text-muted">Roles are enforced by the API, not only by the interface.</p></div>
      <div className="divide-y divide-line border-t border-line">{members.data?.map((member) => <div key={member.userId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="min-w-0"><p className="truncate font-semibold">{member.displayName}</p><p className="mt-1 break-all text-xs text-muted">{member.email} · joined {formatRelative(member.joinedAt)}</p></div><select aria-label={`Role for ${member.email}`} className="field w-full sm:w-40" value={member.role} disabled={workspace.data?.role !== "admin" || updateRole.isPending} onChange={(e) => updateRole.mutate({ id: member.userId, value: e.target.value as WorkspaceRole })}><option value="admin">Admin</option><option value="responder">Responder</option><option value="viewer">Viewer</option></select></div>)}</div>
    </section>
    <div className="space-y-6">
      <form className="surface-lined p-5 sm:p-6" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
        <UserPlus className="h-6 w-6 text-accent" />
        <h2 className="mt-4 section-title">Send a secure invitation</h2>
        <p className="mt-2 text-sm leading-6 text-muted">ReplayOps emails a seven-day, email-bound link when delivery is configured. A copyable fallback is always generated.</p>
        <label className="mt-5 block text-sm font-semibold">Email<input type="email" className="field mt-2" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required /></label>
        <label className="mt-4 block text-sm font-semibold">Role<select className="field mt-2" value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}><option value="responder">Responder</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
        <button className="control-primary mt-4 inline-flex w-full items-center justify-center gap-2" disabled={invite.isPending || workspace.data?.role !== "admin"}>{invite.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{invite.isPending ? "Sending invitation…" : "Send invitation"}</button>
        {inviteResult && inviteLink && <div className={cn("mt-4 rounded-control p-4", inviteResult.emailDeliveryStatus === "sent" ? "bg-success/10" : inviteResult.emailDeliveryStatus === "failed" ? "bg-danger/10" : "bg-warning/12")} aria-live="polite">
          <div className="flex items-start gap-3">
            {inviteResult.emailDeliveryStatus === "sent" ? <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" /> : <TriangleAlert className={cn("mt-0.5 h-5 w-5 shrink-0", inviteResult.emailDeliveryStatus === "failed" ? "text-danger" : "text-warning")} />}
            <div className="min-w-0"><p className="text-sm font-semibold">{inviteResult.emailDeliveryStatus === "sent" ? "Invitation accepted for email delivery" : inviteResult.emailDeliveryStatus === "failed" ? "Email delivery failed" : "Email delivery is not configured"}</p><p className="mt-1 text-xs leading-5 text-muted">{inviteResult.emailDeliveryStatus === "sent" ? `The provider accepted the message for ${inviteResult.email}. Keep the link below as a fallback.` : inviteResult.emailLastError ?? "The invitation is valid, but no email was sent. Copy and share this link through a trusted channel."}</p></div>
          </div>
          <button type="button" className="control-secondary mt-3 inline-flex w-full items-center justify-center gap-2 !min-h-10" onClick={() => void copyInviteLink()}><Copy className="h-4 w-4" />{copied ? "Link copied" : "Copy invitation link"}</button>
        </div>}
        {invite.error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">Invitation was not created. {invite.error.message}</p>}
      </form>
      {invitations.data?.length ? <section className="surface-lined p-5"><h3 className="font-semibold">Recent invitations</h3><div className="mt-3 divide-y divide-line">{invitations.data.slice(0, 6).map((item) => <div key={item.id} className="py-3 first:pt-0 last:pb-0"><p className="break-all text-sm font-semibold">{item.email}</p><p className="mt-1 text-xs text-muted"><span className="capitalize">{item.role}</span> · {item.status} · {item.emailDeliveryStatus === "sent" ? "email sent" : item.emailDeliveryStatus === "failed" ? "delivery failed" : "link only"}</p></div>)}</div></section> : null}
    </div>
  </div>;
}

function AuditTrail() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.audit });
  return <section className="surface-lined overflow-hidden">
    <div className="px-5 py-5 sm:px-6"><h2 className="section-title">Workspace activity</h2><p className="mt-1 text-sm text-muted">A human-readable history of completed operational and governance events.</p></div>
    <div className="divide-y divide-line border-t border-line">
      {audit.isLoading && <p className="px-5 py-8 text-sm text-muted sm:px-6">Loading workspace activity…</p>}
      {audit.error && <p role="alert" className="px-5 py-8 text-sm text-danger sm:px-6">Workspace activity could not be loaded. {audit.error.message}</p>}
      {audit.data?.map((entry) => { const event = presentAuditEntry(entry); return <article key={entry.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[170px_minmax(0,1fr)_auto] sm:items-start sm:px-6">
        <time className="measurement-number text-xs text-muted" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
        <div><p className="text-sm font-semibold">{event.title}</p><p className="mt-1 text-xs leading-5 text-muted">{event.description}</p><p className="mt-1 text-xs text-faint">Performed by {entry.actor}</p></div>
        <ShieldCheck className="h-4 w-4 text-success" aria-label="Recorded successfully" />
      </article>; })}
      {audit.data && !audit.data.length && <div className="px-6 py-12 text-center"><Activity className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No workspace activity yet</p><p className="mt-1 text-sm text-muted">Completed operational changes will appear here.</p></div>}
    </div>
  </section>;
}

function shortDeliveryReference(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function QueueHealth() {
  const queryClient = useQueryClient();
  const queue = useQuery({ queryKey: ["ingestion-queue"], queryFn: api.queue, refetchInterval: 15_000 });
  const retry = useMutation({
    mutationFn: api.retryQueueJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ingestion-queue"] })
  });
  const counts = queue.data?.reduce<Record<string, number>>((map, item) => ({ ...map, [item.status]: (map[item.status] ?? 0) + 1 }), {}) ?? {};

  return <div className="space-y-5">
    <div className="surface-lined grid divide-y divide-line sm:grid-cols-4 sm:divide-x sm:divide-y-0">
      {[["Completed", counts.completed ?? 0], ["Waiting", (counts.queued ?? 0) + (counts.retrying ?? 0)], ["Processing", counts.processing ?? 0], ["Dead letter", counts.dead_letter ?? 0]].map(([label, value]) => <div key={String(label)} className="p-5"><p className="text-xs text-muted">{label}</p><p className="measurement-number mt-2 text-2xl font-semibold">{value}</p></div>)}
    </div>
    <section className="surface-lined overflow-hidden">
      <div className="px-5 py-5 sm:px-6">
        <h2 className="section-title">Durable delivery queue</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">Every accepted source delivery is saved before correlation begins. Temporary failures retry with increasing delays; after five failed attempts, the event waits here for an operator.</p>
      </div>
      {retry.error && <p role="alert" className="border-t border-line bg-danger/10 px-5 py-3 text-sm text-danger sm:px-6">The event could not be queued again. {retry.error.message}</p>}
      <div className="divide-y divide-line border-t border-line">
        {queue.isLoading && <p className="px-5 py-8 text-sm text-muted sm:px-6">Loading delivery events…</p>}
        {queue.error && <p role="alert" className="px-5 py-8 text-sm text-danger sm:px-6">Delivery events could not be loaded. {queue.error.message}</p>}
        {queue.data?.map((job) => <div key={job.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_110px_80px_auto] sm:items-center sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" title={job.eventName}>{job.eventName}</p>
            <p className="mt-1 truncate text-xs text-muted">{job.sourceName} · {job.signalCount} signal{job.signalCount === 1 ? "" : "s"} · received {formatRelative(job.createdAt)}</p>
            <p className="measurement-number mt-1 truncate text-xs text-faint" title={job.externalId}>Provider reference {shortDeliveryReference(job.externalId)}</p>
            {job.lastError && <p className="mt-2 text-xs leading-5 text-danger">Last attempt failed: {job.lastError}</p>}
          </div>
          <span className={cn("w-fit rounded-full px-2.5 py-1 text-xs font-semibold capitalize", job.status === "completed" ? "bg-success/12 text-success" : job.status === "dead_letter" ? "bg-danger/10 text-danger" : "bg-warning/12 text-warning")}>{job.status.replace("_", " ")}</span>
          <span className="measurement-number text-xs text-muted">{job.attempts} {job.attempts === 1 ? "try" : "tries"}</span>
          {["retrying", "dead_letter"].includes(job.status) ? <button className="control-secondary inline-flex !min-h-9 items-center gap-2" disabled={retry.isPending} onClick={() => retry.mutate(job.id)}><RotateCcw className={cn("h-4 w-4", retry.isPending && "animate-spin")} />Queue again</button> : <CheckCircle2 className="h-4 w-4 text-success" aria-label="Processing completed" />}
        </div>)}
        {queue.data && queue.data.length === 0 && <div className="px-6 py-12 text-center"><DatabaseZap className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No delivery events yet</p><p className="mt-1 text-sm text-muted">Connect a source or run its labeled end-to-end test.</p></div>}
      </div>
    </section>
  </div>;
}

export function WorkspacePage() {
  const [mode, setMode] = useState<Mode>("services");
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  return <div className="space-y-6"><header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Operational workspace</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Define what ReplayOps observes, how it groups evidence, who can act, and how every change is reviewed.</p></div><span className="measurement-number w-fit rounded-full bg-elevated px-3 py-1.5 text-xs text-muted">{workspace.data?.organizationName ?? "Loading workspace"} · {workspace.data?.role ?? "member"}</span></header>
    <div className="overflow-x-auto"><div className="inline-flex min-w-full gap-1 rounded-panel bg-rail p-1 sm:min-w-0" role="tablist" aria-label="Workspace controls">{modes.map((item) => <button key={item.id} role="tab" aria-selected={mode === item.id} className={cn("flex min-h-11 items-center gap-2 whitespace-nowrap rounded-control px-3 text-sm font-semibold transition-colors", mode === item.id ? "bg-ink text-panel" : "text-muted hover:bg-elevated hover:text-ink")} onClick={() => setMode(item.id)}><item.icon className="h-4 w-4" />{item.label}</button>)}</div></div>
    {workspace.error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger"><TriangleAlert className="mr-2 inline h-4 w-4" />{workspace.error.message}</p>}
    <AnimatePresence mode="wait"><motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>{mode === "services" ? <ServiceMap /> : mode === "intake" ? <IntakePolicyPanel /> : mode === "privacy" ? <PrivacyPanel/> : mode === "team" ? <TeamAccess /> : mode === "audit" ? <AuditTrail /> : <QueueHealth />}</motion.div></AnimatePresence>
  </div>;
}
