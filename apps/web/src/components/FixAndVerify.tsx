import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDot, Clock3, FileCheck2, GitBranch, LoaderCircle, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { usePersistentDraft } from "../lib/usePersistentDraft";
import { useOwnerName } from "../lib/useOwnerName";
import { cn, formatRelative } from "../lib/utils";
import type { CaseworkSnapshot, Incident, RecoveryCriterion } from "../types";
import { useAuth } from "../providers/AuthProvider";

type StepState = "done" | "current" | "waiting" | "optional" | "blocked";
type FixDraft = { title: string; change: string; rollbackPlan: string; versionIdentity: string; targetService: string; targetEnvironment: string };
type CheckDraft = { name: string; unit: string; comparison: "lte" | "gte"; targetValue: string; source: string; query: string; windows: string; observation: string; freshness: string };

const presets: Array<Pick<CheckDraft, "name" | "unit" | "comparison" | "targetValue">> = [
  { name: "Error rate", unit: "%", comparison: "lte", targetValue: "1" },
  { name: "p95 latency", unit: "ms", comparison: "lte", targetValue: "500" },
  { name: "Success rate", unit: "%", comparison: "gte", targetValue: "99" },
  { name: "Queue backlog", unit: "items", comparison: "lte", targetValue: "100" }
];
const symbol = (comparison: "lte" | "gte") => comparison === "lte" ? "≤" : "≥";
const passes = (criterion: RecoveryCriterion, value: number | null) => value !== null && (criterion.comparison === "lte" ? value <= criterion.targetValue : value >= criterion.targetValue);

function Saving({ pending, error }: { pending?: boolean; error?: Error | null }) {
  if (pending) return <p className="mt-2 inline-flex items-center gap-2 text-xs text-info"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving…</p>;
  if (error) return <p role="alert" className="mt-2 text-xs text-danger">{error.message}</p>;
  return null;
}

function Step({ number, title, state, summary, children }: { number: number; title: string; state: StepState; summary: string; children: ReactNode }) {
  return <section className={cn("border-t border-line p-5 sm:p-6", state === "current" && "bg-info/5")}>
    <div className="flex items-start gap-3">
      <span className={cn("measurement-number flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", state === "done" ? "bg-success/15 text-success" : state === "current" ? "bg-ink text-panel" : "bg-elevated text-muted")}>{state === "done" ? <CheckCircle2 className="h-4 w-4" /> : number}</span>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="section-title">{title}</h3>{state === "optional" && <span className="rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">optional</span>}{state === "waiting" && <span className="rounded-full bg-warning/12 px-2 py-0.5 text-xs font-semibold text-warning">waiting</span>}</div><p className="mt-1 text-sm leading-6 text-muted">{summary}</p><div className="mt-4">{children}</div></div>
    </div>
  </section>;
}

export function FixAndVerify({ incident, advancedReplay }: { incident: Incident; advancedReplay?: ReactNode }) {
  const client = useQueryClient();
  const { user } = useAuth();
  const ownerName = useOwnerName();
  const data = useQuery({ queryKey: ["casework", incident.id, incident.evidenceRevision], queryFn: () => api.casework(incident.id) });
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const latestSha = useMemo(() => [...incident.events].reverse().map((event) => event.metadata?.sha).find((sha): sha is string => typeof sha === "string"), [incident.events]);
  const fix = usePersistentDraft<FixDraft>(`replayops:${incident.id}:fix`, { title: "", change: "", rollbackPlan: "", versionIdentity: latestSha ?? "", targetService: incident.service, targetEnvironment: incident.environment ?? "unknown" });
  const check = usePersistentDraft<CheckDraft>(`replayops:${incident.id}:recovery-check`, { ...presets[0]!, source: "", query: "", windows: "2", observation: "10", freshness: "30" });
  const [editingFix, setEditingFix] = useState(false);
  const [describingFix, setDescribingFix] = useState(false);
  const [editingCheck, setEditingCheck] = useState(false);
  const [testedHow, setTestedHow] = useState("");
  const [reading, setReading] = useState("");
  const [readingNote, setReadingNote] = useState("");
  const [reason, setReason] = useState("");
  const refresh = () => void client.invalidateQueries({ queryKey: ["casework", incident.id] });

  const snapshot = data.data as (CaseworkSnapshot | undefined);
  const proposal = snapshot?.proposals[0];
  const validations = snapshot?.validations.filter((item) => item.proposalId === proposal?.id) ?? [];
  const tested = validations.some((item) => item.status === "passed");
  const review = snapshot?.reviews.find((item) => item.proposalId === proposal?.id);
  const approved = review?.status === "approved";
  const criterion = snapshot?.criteria[0];
  const delivery = snapshot?.caseKind === "delivery";
  const recovery = snapshot?.recovery;
  const verified = recovery?.state === "verified";
  // Grafana/Alertmanager alerts confirm recovery themselves unless someone set their own check.
  const fromAlerts = !delivery && !criterion && recovery?.automatic === "alerts";
  const [ownCheck, setOwnCheck] = useState(false);
  const canApprove = workspace.data?.role === "admin" && review?.status === "pending" && review.requestedBy.toLowerCase() !== user?.email.toLowerCase();

  const saveFix = useMutation({ mutationFn: () => api.createProposal(incident.id, { title: fix.value.title, change: fix.value.change, rollbackPlan: fix.value.rollbackPlan, target: { service: fix.value.targetService, environment: fix.value.targetEnvironment, versionIdentity: fix.value.versionIdentity } }), onSuccess: () => { fix.clear(); setEditingFix(false); setDescribingFix(false); refresh(); } });
  const saveTested = useMutation({ mutationFn: () => { if (!proposal) throw new Error("Describe the fix first."); return api.addValidation(incident.id, { proposalId: proposal.id, kind: "manual", status: "passed", summary: testedHow, provenance: { label: "operator-reported", operatorConfirmed: true } }); }, onSuccess: () => { setTestedHow(""); refresh(); } });
  const askApproval = useMutation({ mutationFn: () => { if (!proposal) throw new Error("Describe the fix first."); return api.requestProposalReview(incident.id, proposal.id); }, onSuccess: refresh });
  const decide = useMutation({ mutationFn: (status: "approved" | "rejected") => api.reviewProposal(incident.id, review!.id, { status, reason: status === "approved" ? "Reviewed the exact change, how it was tested, and the rollback plan." : "The change, its testing, or its rollback plan is not safe enough yet." }), onSuccess: refresh });
  const saveCheck = useMutation({ mutationFn: () => api.createRecoveryCriterion(incident.id, { kind: "runtime", name: check.value.name, source: check.value.source, query: check.value.query, unit: check.value.unit, comparison: check.value.comparison, targetValue: Number(check.value.targetValue), minConsecutiveWindows: Number(check.value.windows), maxAgeMinutes: Number(check.value.freshness), observationMinutes: Number(check.value.observation), deliveryIdentity: null }), onSuccess: () => { setEditingCheck(false); refresh(); } });
  const saveReading = useMutation({
    mutationFn: () => {
      if (!criterion) throw new Error("Choose how you'll know it's fixed first.");
      const now = new Date();
      // A reading describes the last five minutes, ending now.
      return api.addMeasurement(incident.id, { criterionId: criterion.id, value: Number(reading), unit: criterion.unit, source: criterion.source, query: criterion.query, windowStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(), windowEndedAt: now.toISOString(), observedAt: now.toISOString(), state: "valid", note: readingNote });
    },
    onSuccess: () => { setReading(""); setReadingNote(""); refresh(); }
  });
  const lifecycle = useMutation({
    mutationFn: async (action: "start_monitoring" | "resolve" | "reopen" | "monitor_and_resolve") => {
      const revision = incident.evidenceRevision ?? incident.updatedAt;
      const text = (fallback: string) => reason.trim().length >= 8 ? reason.trim() : fallback;
      if (action === "monitor_and_resolve") {
        // The API only resolves from Monitoring; when recovery is already confirmed, do both in one click.
        const monitored = await api.transitionIncident(incident.id, { action: "start_monitoring", reason: "The fix is live and recovery is already confirmed.", expectedEvidenceRevision: revision });
        return api.transitionIncident(incident.id, { action: "resolve", reason: reason.trim(), expectedEvidenceRevision: monitored.evidenceRevision ?? monitored.updatedAt });
      }
      return api.transitionIncident(incident.id, { action, reason: text(action === "start_monitoring" ? "The fix is live; watching for recovery." : action === "reopen" ? "Reopened after new evidence or a regression." : ""), expectedEvidenceRevision: revision });
    },
    onSuccess: (value) => { client.setQueryData(["incident", incident.id], value); refresh(); }
  });

  if (data.isLoading) return <div className="min-h-72 p-6 text-sm text-muted">Loading fix and recovery status…</div>;
  if (data.error || !snapshot || !recovery) return <div className="p-6 text-sm text-danger">{data.error?.message ?? "Fix and recovery status is unavailable."}</div>;

  const resolved = incident.status === "resolved";
  const monitoring = incident.status === "monitoring";
  const approvalBlocks = Boolean(proposal && !approved);
  const blockers = [!verified && "recovery is not confirmed yet", approvalBlocks && "the recorded fix still needs a teammate's approval", !monitoring && !resolved && "the incident is not in Monitoring yet"].filter(Boolean) as string[];

  const now: { text: string; tone: "info" | "success" | "warning" } = resolved
    ? { text: "Resolved. Capture what you learned and any follow-ups in Activity & handoff.", tone: "success" }
    : approvalBlocks && !tested ? { text: "Add a line about how you tested the fix, then ask a teammate to approve it.", tone: "info" }
    : approvalBlocks && !review ? { text: "Ask a teammate to approve the fix.", tone: "info" }
    : approvalBlocks && review?.status === "pending" ? { text: canApprove ? "A teammate asked you to approve this fix. Review it below." : "Waiting for another admin to approve the fix. Share this page with them.", tone: "warning" }
    : approvalBlocks && review?.status === "rejected" ? { text: "The fix was rejected. Update it below; that creates a new version to approve.", tone: "warning" }
    : !verified && (delivery || fromAlerts) ? { text: recovery.reason, tone: "info" }
    : !verified && !criterion ? { text: "Pick the one number that tells you it's fixed (for example error rate ≤ 1%).", tone: "info" }
    : !verified ? { text: `${recovery.reason} Record another reading below.`, tone: "info" }
    : !monitoring ? { text: "Recovery is confirmed. Add a one-line reason and resolve.", tone: "success" }
    : { text: "Everything checks out. Add a short reason and resolve the incident.", tone: "success" };

  const fixState: StepState = proposal ? (approved ? "done" : "current") : "optional";
  const confirmState: StepState = verified ? "done" : "current";
  const resolveState: StepState = resolved ? "done" : blockers.filter((item) => !item.startsWith("the incident is not in Monitoring")).length ? "blocked" : "current";

  return <div>
    <div className="px-5 py-5 sm:px-6">
      <p className="max-w-3xl text-sm leading-6 text-muted">Three steps take an incident from "we think we know the cause" to resolved: optionally record the fix, confirm with real data that things are healthy again, then resolve. ReplayOps won't let an incident be resolved on a hunch.</p>
      <div className={cn("mt-4 flex items-start gap-3 rounded-control p-4", now.tone === "success" ? "bg-success/10" : now.tone === "warning" ? "bg-warning/10" : "bg-info/10")}>
        {now.tone === "success" ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" /> : now.tone === "warning" ? <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-warning" /> : <CircleDot className="mt-0.5 h-5 w-5 shrink-0 text-info" />}
        <div><p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">What to do now</p><p className="mt-1 text-sm font-semibold leading-6">{now.text}</p></div>
      </div>
    </div>

    <Step number={1} title="Record the fix" state={fixState} summary={proposal ? `Version ${proposal.version}${approved ? ", approved." : review?.status === "pending" ? ", waiting for approval." : review?.status === "rejected" ? ", rejected." : "."}` : delivery ? "Optional. For GitHub incidents, pushing a fix or redeploying the last good commit is enough; recovery is detected automatically. Record the fix here if you want it reviewed and in the handoff." : "Optional. Write down the exact change and how to undo it, so a teammate can review it and the handoff shows what was done. A recorded fix must be approved by a teammate before you can resolve."}>
      {proposal && !editingFix ? <div className="space-y-4">
        <article className="rounded-control bg-elevated p-4"><p className="text-sm font-semibold">{proposal.title}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{proposal.change}</p><p className="mt-2 text-xs text-muted"><strong>Undo:</strong> {proposal.rollbackPlan}</p>{Boolean(proposal.target.versionIdentity) && <p className="mt-1 text-xs text-muted"><strong>Version:</strong> {String(proposal.target.versionIdentity)}</p>}<button className="control-quiet mt-2 !min-h-8 !px-0 text-xs" onClick={() => { fix.setValue({ title: proposal.title, change: proposal.change, rollbackPlan: proposal.rollbackPlan, versionIdentity: String(proposal.target.versionIdentity ?? ""), targetService: String(proposal.target.service ?? incident.service), targetEnvironment: String(proposal.target.environment ?? incident.environment ?? "unknown") }); setEditingFix(true); }}>Change the fix (creates version {proposal.version + 1})</button></article>
        <div className="rounded-control border border-line p-4"><p className="text-sm font-semibold">How was it tested?</p>
          {validations.map((item) => <p key={item.id} className="mt-2 flex gap-2 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />{item.summary}<span className="shrink-0 text-xs text-faint">· {formatRelative(item.createdAt)}</span></p>)}
          {!tested && <><textarea className="field mt-2 min-h-16 resize-y py-2 text-sm" value={testedHow} onChange={(event) => setTestedHow(event.target.value)} placeholder="e.g. Ran the checkout suite on staging with the fix; all 42 tests pass." /><button className="control-secondary mt-2 !min-h-9" disabled={testedHow.trim().length < 8 || saveTested.isPending} onClick={() => saveTested.mutate()}>Save</button><Saving pending={saveTested.isPending} error={saveTested.error} /></>}
        </div>
        <div className="rounded-control border border-line p-4"><p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-info" />Teammate approval</p>
          {!review && <><p className="mt-1 text-xs text-muted">Another admin checks the change, how it was tested, and the undo plan.{!tested && " Say how it was tested first."}</p><button className="control-primary mt-3 !min-h-9" disabled={!tested || askApproval.isPending} onClick={() => askApproval.mutate()}>Ask a teammate to approve</button></>}
          {review?.status === "pending" && (canApprove ? <div className="mt-2"><p className="text-sm">{ownerName(review.requestedBy)} asked for approval.</p><div className="mt-2 flex gap-2"><button className="control-primary !min-h-9" onClick={() => decide.mutate("approved")} disabled={decide.isPending}>Approve</button><button className="control-quiet !min-h-9 text-danger" onClick={() => decide.mutate("rejected")} disabled={decide.isPending}>Reject</button></div></div> : <p className="mt-1 text-sm text-muted">Requested by {ownerName(review.requestedBy)}. Another admin needs to approve it; you can't approve your own request.</p>)}
          {review && review.status !== "pending" && <p className={cn("mt-1 text-sm font-semibold", approved ? "text-success" : "text-danger")}>{approved ? "Approved" : "Rejected"}{review.reviewedBy ? ` by ${ownerName(review.reviewedBy)}` : ""}.</p>}
          <Saving pending={askApproval.isPending || decide.isPending} error={(askApproval.error ?? decide.error) as Error | null} />
        </div>
      </div>
      : !proposal && !describingFix ? <button className="control-secondary" onClick={() => setDescribingFix(true)}>Describe the fix</button>
      : <form className="grid gap-3 lg:max-w-3xl" onSubmit={(event) => { event.preventDefault(); saveFix.mutate(); }}>
        <label className="text-sm font-semibold">The fix in one line<input className="field mt-1.5" value={fix.value.title} onChange={(event) => fix.setValue((value) => ({ ...value, title: event.target.value }))} placeholder="Lower checkout retry attempts from 4 to 1" required minLength={4} /></label>
        <label className="text-sm font-semibold">What exactly changes<textarea className="field mt-1.5 min-h-20 resize-y py-3" value={fix.value.change} onChange={(event) => fix.setValue((value) => ({ ...value, change: event.target.value }))} placeholder="Set CHECKOUT_MAX_RETRIES=1 in the production config and redeploy checkout-api." required minLength={12} /></label>
        <label className="text-sm font-semibold">How to undo it<textarea className="field mt-1.5 min-h-16 resize-y py-3" value={fix.value.rollbackPlan} onChange={(event) => fix.setValue((value) => ({ ...value, rollbackPlan: event.target.value }))} placeholder="Set CHECKOUT_MAX_RETRIES back to 4 and redeploy." required minLength={12} /></label>
        <label className="text-sm font-semibold">Commit, image, or config version<input className="field mt-1.5" value={fix.value.versionIdentity} onChange={(event) => fix.setValue((value) => ({ ...value, versionIdentity: event.target.value }))} placeholder="e.g. 4c1620d" required /></label>
        <details><summary className="cursor-pointer text-xs font-semibold text-muted">Target service and environment</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Service<input className="field mt-1.5" value={fix.value.targetService} onChange={(event) => fix.setValue((value) => ({ ...value, targetService: event.target.value }))} /></label><label className="text-sm font-semibold">Environment<input className="field mt-1.5" value={fix.value.targetEnvironment} onChange={(event) => fix.setValue((value) => ({ ...value, targetEnvironment: event.target.value }))} /></label></div></details>
        <div className="flex flex-wrap gap-2"><button className="control-primary" disabled={saveFix.isPending}>Save the fix</button><button type="button" className="control-quiet" onClick={() => { setEditingFix(false); setDescribingFix(false); }}>Cancel</button></div>
        <Saving pending={saveFix.isPending} error={saveFix.error} />
      </form>}
    </Step>

    <Step number={2} title="Confirm it's fixed" state={confirmState} summary={delivery ? "Checked automatically from GitHub: a successful deploy or workflow run after the failure confirms recovery. A newer failure cancels it." : fromAlerts ? "Checked automatically from your alerts: when every Grafana alert in this incident reports resolved and stays quiet for 5 minutes, recovery is confirmed. New errors or the alert firing again cancel it." : "Pick the one number that shows users are OK again, then record a reading or two after the fix is live. Recovery is confirmed when enough recent readings meet the target."}>
      <div className={cn("flex items-start gap-3 rounded-control p-4", verified ? "bg-success/10" : recovery.state === "failed" ? "bg-danger/10" : "bg-elevated")}>
        {verified ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" /> : recovery.state === "failed" ? <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" /> : delivery ? <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-info" /> : <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-muted" />}
        <div><p className="text-sm font-semibold">{verified ? "Recovery confirmed" : recovery.state === "failed" ? "Still failing" : recovery.state === "stale" ? "Reading too old" : "Not confirmed yet"}</p><p className="mt-1 text-sm leading-6 text-muted">{recovery.reason}</p></div>
      </div>
      {!delivery && criterion && !editingCheck && <div className="mt-4">
        <p className="text-sm">Healthy when <strong>{criterion.name} {symbol(criterion.comparison)} {criterion.targetValue} {criterion.unit}</strong>, read from {criterion.source}{criterion.query && <> (<span className="break-all text-muted">{criterion.query}</span>)</>}. Needs {criterion.minConsecutiveWindows} passing reading{criterion.minConsecutiveWindows === 1 ? "" : "s"} in a row covering at least {criterion.observationMinutes} minutes; the newest must be under {criterion.maxAgeMinutes} minutes old. <button className="control-quiet !min-h-7 !px-1 text-xs" onClick={() => { check.setValue({ name: criterion.name, unit: criterion.unit, comparison: criterion.comparison, targetValue: String(criterion.targetValue), source: criterion.source, query: criterion.query, windows: String(criterion.minConsecutiveWindows), observation: String(criterion.observationMinutes), freshness: String(criterion.maxAgeMinutes) }); setEditingCheck(true); }}>Change</button></p>
        {!verified && !resolved && <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); saveReading.mutate(); }}>
          <label className="text-sm font-semibold">Current {criterion.name.toLowerCase()} ({criterion.unit})<input className="field mt-1.5 sm:w-40" type="number" step="any" value={reading} onChange={(event) => setReading(event.target.value)} required /></label>
          <label className="flex-1 text-sm font-semibold">Note <span className="font-normal text-faint">(optional)</span><input className="field mt-1.5" value={readingNote} onChange={(event) => setReadingNote(event.target.value)} placeholder="e.g. after redeploy, all regions" /></label>
          <button className="control-primary" disabled={reading === "" || saveReading.isPending}>Record reading</button>
        </form>}
        {!verified && <p className="mt-2 text-xs text-faint">Each reading covers the last 5 minutes. Record one now and another a few minutes later.</p>}
        <Saving pending={saveReading.isPending} error={saveReading.error} />
        {snapshot.measurements.filter((item) => item.criterionId === criterion.id).length > 0 && <ol className="mt-3 divide-y divide-line rounded-control bg-elevated">{snapshot.measurements.filter((item) => item.criterionId === criterion.id).map((item) => <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"><span><strong className="measurement-number">{item.value ?? "—"} {item.unit}</strong>{item.note && <span className="text-muted"> · {item.note}</span>}</span><span className="flex items-center gap-2 text-xs text-faint">{formatRelative(item.observedAt)}<span className={cn("rounded-full px-2 py-0.5 font-semibold", passes(criterion, item.value) ? "bg-success/12 text-success" : "bg-danger/10 text-danger")}>{passes(criterion, item.value) ? "healthy" : "not yet"}</span></span></li>)}</ol>}
      </div>}
      {fromAlerts && !resolved && !ownCheck && <button className="control-quiet mt-3 !px-0 text-xs" onClick={() => setOwnCheck(true)}>Track a number yourself instead</button>}
      {!delivery && (!criterion || editingCheck) && !resolved && (!fromAlerts || ownCheck) && <form className="mt-4 grid gap-3 lg:max-w-3xl" onSubmit={(event) => { event.preventDefault(); saveCheck.mutate(); }}>
        <div><p className="text-sm font-semibold">What number shows it's fixed?</p><div className="mt-2 flex flex-wrap gap-2">{presets.map((preset) => <button type="button" key={preset.name} className={cn("rounded-full px-3 py-1.5 text-xs font-semibold", check.value.name === preset.name ? "bg-ink text-panel" : "bg-elevated text-muted hover:text-ink")} onClick={() => check.setValue((value) => ({ ...value, ...preset }))}>{preset.name}</button>)}</div></div>
        <div className="grid gap-3 sm:grid-cols-[1fr_120px_110px_100px]">
          <label className="text-sm font-semibold">Name<input className="field mt-1.5" value={check.value.name} onChange={(event) => check.setValue((value) => ({ ...value, name: event.target.value }))} required minLength={3} /></label>
          <label className="text-sm font-semibold">Healthy when<select className="field mt-1.5" value={check.value.comparison} onChange={(event) => check.setValue((value) => ({ ...value, comparison: event.target.value as "lte" | "gte" }))}><option value="lte">at or below</option><option value="gte">at or above</option></select></label>
          <label className="text-sm font-semibold">Target<input className="field mt-1.5" type="number" step="any" value={check.value.targetValue} onChange={(event) => check.setValue((value) => ({ ...value, targetValue: event.target.value }))} required /></label>
          <label className="text-sm font-semibold">Unit<input className="field mt-1.5" value={check.value.unit} onChange={(event) => check.setValue((value) => ({ ...value, unit: event.target.value }))} required /></label>
        </div>
        <label className="text-sm font-semibold">Where do you read it?<input className="field mt-1.5" value={check.value.source} onChange={(event) => check.setValue((value) => ({ ...value, source: event.target.value }))} placeholder="e.g. Grafana › Checkout overview" required minLength={2} /></label>
        <label className="text-sm font-semibold">Dashboard link or query <span className="font-normal text-faint">(optional)</span><input className="field mt-1.5" value={check.value.query} onChange={(event) => check.setValue((value) => ({ ...value, query: event.target.value }))} placeholder="https://grafana.example/d/checkout" /></label>
        <details><summary className="cursor-pointer text-xs font-semibold text-muted">How strict: {check.value.windows} readings over {check.value.observation} min, newest under {check.value.freshness} min old</summary><div className="mt-2 grid gap-3 sm:grid-cols-3"><label className="text-sm font-semibold">Passing readings in a row<input className="field mt-1.5" type="number" min="1" max="20" value={check.value.windows} onChange={(event) => check.setValue((value) => ({ ...value, windows: event.target.value }))} /></label><label className="text-sm font-semibold">Covering at least (min)<input className="field mt-1.5" type="number" min="1" value={check.value.observation} onChange={(event) => check.setValue((value) => ({ ...value, observation: event.target.value }))} /></label><label className="text-sm font-semibold">Newest reading under (min)<input className="field mt-1.5" type="number" min="1" value={check.value.freshness} onChange={(event) => check.setValue((value) => ({ ...value, freshness: event.target.value }))} /></label></div></details>
        <div className="flex flex-wrap gap-2"><button className="control-primary" disabled={saveCheck.isPending}>Save recovery check</button>{editingCheck && <button type="button" className="control-quiet" onClick={() => setEditingCheck(false)}>Cancel</button>}</div>
        <Saving pending={saveCheck.isPending} error={saveCheck.error} />
      </form>}
    </Step>

    <Step number={3} title="Resolve" state={resolveState} summary={resolved ? "This incident is resolved." : monitoring ? "The incident is in Monitoring. Resolve it once recovery is confirmed." : verified && !approvalBlocks ? "Recovery is already confirmed, so you can resolve now. Or start monitoring to keep watching first." : "Start monitoring once the fix is live, so the team knows you're watching for recovery."}>
      {!resolved && <label className="block text-sm font-semibold lg:max-w-3xl">{monitoring || (verified && !approvalBlocks) ? "Why is it resolved?" : "Note"} <span className="font-normal text-faint">{monitoring || (verified && !approvalBlocks) ? "(one line, required to resolve)" : "(optional)"}</span><input className="field mt-1.5" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={monitoring ? "e.g. Redeployed 25171f6; error rate back under 1% for 15 minutes." : "e.g. Rollback deployed at 14:05"} /></label>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!monitoring && !resolved && verified && !approvalBlocks && <button className="inline-flex items-center control-primary" disabled={reason.trim().length < 8 || lifecycle.isPending} onClick={() => lifecycle.mutate("monitor_and_resolve")}><CheckCircle2 className="mr-2 h-4 w-4" />Resolve incident</button>}
        {!monitoring && !resolved && <button className={cn("inline-flex items-center", verified && !approvalBlocks ? "control-quiet" : "control-primary")} onClick={() => lifecycle.mutate("start_monitoring")} disabled={lifecycle.isPending}><Clock3 className="mr-2 h-4 w-4" />Start monitoring</button>}
        {monitoring && <button className="inline-flex items-center control-primary" disabled={!verified || approvalBlocks || reason.trim().length < 8 || lifecycle.isPending} onClick={() => lifecycle.mutate("resolve")}><CheckCircle2 className="mr-2 h-4 w-4" />Resolve incident</button>}
        {resolved && <button className="inline-flex items-center control-secondary" onClick={() => lifecycle.mutate("reopen")} disabled={lifecycle.isPending}><RotateCcw className="mr-2 h-4 w-4" />Reopen</button>}
      </div>
      {monitoring && blockers.length > 0 && <p className="mt-2 text-xs text-warning">Can't resolve yet: {blockers.join("; ")}.</p>}
      {monitoring && !blockers.length && reason.trim().length < 8 && <p className="mt-2 text-xs text-muted">Add a one-line reason to resolve.</p>}
      <Saving pending={lifecycle.isPending} error={lifecycle.error && /Evidence changed/i.test(lifecycle.error.message) ? new Error("New evidence arrived just before your click, so nothing changed. Review it and try again.") : lifecycle.error} />
    </Step>

    {advancedReplay && <details className="border-t border-line"><summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold sm:px-6"><span className="inline-flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-info" />Advanced: replay one HTTP request against a candidate build</span><span className="ml-2 text-xs font-normal text-muted">For reproducible HTTP failures in a local or CI environment</span></summary>{advancedReplay}</details>}
  </div>;
}
