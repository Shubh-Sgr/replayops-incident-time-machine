import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCircle2,
  ClipboardCopy,
  Download,
  Eye,
  FileCheck2,
  Gauge,
  GitBranch,
  Gavel,
  Bot,
  LoaderCircle,
  MessageSquareText,
  ScanSearch,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  XCircle
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { cn, formatClock, formatRelative } from "../lib/utils";
import type { AssistantResponse, DecisionKind, DecisionStatus, Incident, IncidentDecision, IncidentDiagnosis, MitigationRequest, ReplayConfig, ReplayResult } from "../types";
import { useAuth } from "../providers/AuthProvider";

type ConsoleMode = "diagnose" | "decisions" | "replay" | "handoff";

const modeItems = [
  { id: "diagnose" as const, label: "Diagnose", icon: ScanSearch },
  { id: "decisions" as const, label: "Decisions", icon: Gavel },
  { id: "replay" as const, label: "Replay", icon: RotateCcw },
  { id: "handoff" as const, label: "Handoff", icon: FileCheck2 }
];

function DiagnosisPanel({ incident }: { incident: Incident }) {
  const diagnosis = useQuery({ queryKey: ["diagnosis", incident.id, incident.updatedAt], queryFn: () => api.diagnosis(incident.id) });
  const [selectedId, setSelectedId] = useState("");
  const [reviewedHypothesisId, setReviewedHypothesisId] = useState("");
  const aiReview = useMutation({
    mutationFn: (input: { hypothesisId: string; question: string }) => api.ask(input.question, incident.id),
    onSuccess: (_response, input) => setReviewedHypothesisId(input.hypothesisId)
  });

  if (diagnosis.isLoading) return <div className="flex min-h-[460px] items-center justify-center text-sm text-muted"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Building the diagnostic proof loop</div>;
  if (diagnosis.error) return <div className="px-6 py-14 text-center"><TriangleAlert className="mx-auto h-6 w-6 text-danger" /><h3 className="mt-3 font-semibold">Diagnosis could not be generated</h3><p className="mt-1 text-sm text-muted">{diagnosis.error instanceof Error ? diagnosis.error.message : "The evidence service is unavailable."}</p><button className="control-secondary mt-4" onClick={() => void diagnosis.refetch()}>Retry diagnosis</button></div>;

  const data = diagnosis.data as IncidentDiagnosis;
  if (!data.hypotheses.length) return <div className="px-6 py-14 text-center"><ScanSearch className="mx-auto h-7 w-7 text-faint" /><h3 className="mt-3 font-semibold">Evidence required before diagnosis</h3><p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted">Add timestamped signals or changes. ReplayOps will not invent a root cause from an empty incident.</p></div>;

  const selected = data.hypotheses.find((hypothesis) => hypothesis.id === selectedId) ?? data.hypotheses[0]!;
  const challenge = () => aiReview.mutate({
    hypothesisId: selected.id,
    question: `Act as an adversarial SRE reviewer. Challenge this hypothesis: "${selected.claim}". Using only ${incident.code} evidence, identify the strongest disconfirming evidence, the cheapest safe test that could falsify it, and what observation would change your mind. Do not restate the incident summary.`
  });
  const aiResponse = reviewedHypothesisId === selected.id ? aiReview.data : undefined;

  return (
    <div>
      <div className="bg-ink px-5 py-5 text-panel sm:px-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-panel/60"><GitBranch className="h-4 w-4" /> Likely propagation origin</div><div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="font-heading text-2xl font-semibold">{data.originService}</span><span className="measurement-number text-xs text-panel/60">{data.confidence}% evidence coverage</span></div><div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-panel/70">{data.servicePath.map((service, index) => <span key={service} className="inline-flex items-center gap-2"><span className={cn("rounded-full px-2.5 py-1", index === 0 ? "bg-panel/15 text-panel" : "bg-panel/8")}>{service}</span>{index < data.servicePath.length - 1 ? <span aria-hidden>→</span> : null}</span>)}</div></div>
          <div className="max-w-sm text-xs leading-5 text-panel/65">Ranked from event order, signal change, and propagation—not alert loudness. Every claim remains a hypothesis until its test passes.</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
        <div className="border-b border-line bg-rail lg:border-b-0 lg:border-r">
          <div className="px-5 py-4 sm:px-6"><h3 className="section-title">Competing hypotheses</h3><p className="mt-1 text-xs text-muted">Choose one to inspect its proof and falsification test.</p></div>
          <div className="border-t border-line">
            {data.hypotheses.map((hypothesis) => (
              <button key={hypothesis.id} type="button" className={cn("block w-full border-b border-line px-5 py-4 text-left transition-colors last:border-b-0 sm:px-6", selected.id === hypothesis.id ? "bg-panel" : "hover:bg-elevated")} onClick={() => setSelectedId(hypothesis.id)}>
                <div className="flex items-start gap-3"><span className={cn("measurement-number mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", selected.id === hypothesis.id ? "bg-ink text-panel" : "bg-elevated text-muted")}>{hypothesis.rank}</span><div className="min-w-0"><p className="text-sm font-semibold leading-5">{hypothesis.title}</p><div className="mt-2 flex items-center gap-2"><span className="measurement-number text-xs text-muted">{hypothesis.confidence}% confidence</span><span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-accent" style={{ width: `${hypothesis.confidence}%` }} /></span></div></div></div>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="measurement-number text-xs uppercase tracking-[0.14em] text-muted">Hypothesis {selected.rank} · unverified</p><h3 className="mt-2 max-w-3xl font-heading text-xl font-semibold tracking-[-0.02em]">{selected.claim}</h3></div><span className="measurement-number rounded-full bg-warning/12 px-2.5 py-1 text-xs font-semibold text-warning">{selected.confidence}%</span></div>

          <div className="mt-6 grid gap-5 xl:grid-cols-2">
            <div><h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Supports</h4><ul className="mt-3 space-y-2">{selected.supportingEvidence.map((item) => <li key={item} className="flex gap-2 text-sm leading-6"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-success" />{item}</li>)}</ul></div>
            <div><h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Could disprove it</h4><ul className="mt-3 space-y-2">{selected.conflictingEvidence.map((item) => <li key={item} className="flex gap-2 text-sm leading-6"><Eye className="mt-1 h-4 w-4 shrink-0 text-warning" />{item}</li>)}</ul></div>
          </div>

          <div className="mt-6 border-y border-line py-5">
            <div className="grid gap-5 xl:grid-cols-[1fr_0.8fr]"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Next falsification test</p><p className="mt-2 text-sm font-semibold leading-6">{selected.nextTest}</p></div><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Reversible guardrail</p><p className="mt-2 text-sm leading-6 text-muted">{selected.safeAction}</p></div></div>
            <button type="button" className="control-secondary mt-4 inline-flex items-center gap-2" onClick={challenge} disabled={aiReview.isPending}>{aiReview.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}{aiReview.isPending ? "AI is challenging the claim" : "Ask AI to challenge this hypothesis"}</button>
            {aiReview.error && <p role="alert" className="mt-3 text-sm text-danger">{aiReview.error instanceof Error ? aiReview.error.message : "The adversarial review failed."}</p>}
            {aiResponse && <div className="mt-4 rounded-control bg-info/8 p-4"><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold uppercase tracking-[0.12em] text-info">Adversarial review</span><span className="measurement-number text-xs text-muted">{Math.round(aiResponse.confidence * 100)}% · {aiResponse.mode}</span></div><p className="mt-2 text-sm leading-6">{aiResponse.answer}</p><div className="mt-3 flex flex-wrap gap-2">{aiResponse.citations.map((citation) => <span key={citation.incidentId} title={citation.excerpt} className="rounded-full bg-panel px-2.5 py-1 text-xs font-semibold text-info">{citation.code} · {citation.eventIds.length} cited</span>)}</div><p className="mt-2 text-xs text-muted">{aiResponse.evidenceBoundary}{aiResponse.redactions ? ` · ${aiResponse.redactions} sensitive values redacted` : ""}. Review aid only; AI cannot approve or close a hypothesis.</p></div>}
          </div>
        </div>
      </div>

      <div className="grid border-t border-line xl:grid-cols-3">
        <section className="border-b border-line p-5 sm:p-6 xl:border-b-0 xl:border-r"><h3 className="section-title">Trigger candidates</h3><p className="mt-1 text-xs text-muted">Changes and conditions nearest the first high-impact symptom.</p><ol className="mt-4 space-y-3">{data.changeCandidates.slice(0, 3).map((candidate, index) => <li key={candidate.eventId} className="grid grid-cols-[auto_1fr_auto] gap-3 text-sm"><span className="measurement-number text-xs text-muted">0{index + 1}</span><div><p className="font-semibold leading-5">{candidate.title}</p><p className="mt-1 text-xs leading-5 text-muted">{candidate.service} · {candidate.reason}</p></div><span className="measurement-number text-xs font-semibold">{candidate.score}</span></li>)}</ol></section>
        <section className="border-b border-line p-5 sm:p-6 xl:border-b-0 xl:border-r"><h3 className="section-title">Failure-window delta</h3><p className="mt-1 text-xs text-muted">Signals most overrepresented after the first high-impact symptom.</p><div className="mt-4 space-y-3">{data.signalDeltas.slice(0, 4).map((delta) => <div key={`${delta.dimension}-${delta.value}`}><div className="flex items-center justify-between gap-3 text-xs"><span><strong className="text-ink">{delta.value}</strong> <span className="text-muted">· {delta.dimension}</span></span><span className={cn("measurement-number font-semibold", delta.change >= 0 ? "text-danger" : "text-success")}>{delta.change >= 0 ? "+" : ""}{delta.change}</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-danger" style={{ width: `${Math.max(4, delta.score)}%` }} /></div></div>)}</div></section>
        <section className="p-5 sm:p-6"><h3 className="section-title">Confidence blockers</h3><p className="mt-1 text-xs text-muted">Add these signals before treating the leading hypothesis as root cause.</p>{data.evidenceGaps.length ? <ul className="mt-4 space-y-3">{data.evidenceGaps.map((gap) => <li key={gap} className="flex gap-2 text-sm leading-5 text-muted"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />{gap}</li>)}</ul> : <p className="mt-4 flex items-center gap-2 text-sm text-success"><ShieldCheck className="h-4 w-4" /> Core correlation evidence is present.</p>}</section>
      </div>
    </div>
  );
}

const decisionTone: Record<DecisionStatus, string> = {
  proposed: "bg-warning/12 text-warning",
  approved: "bg-success/12 text-success",
  rejected: "bg-danger/10 text-danger"
};

function DecisionMark({ status }: { status: DecisionStatus }) {
  const Icon = status === "approved" ? CheckCircle2 : status === "rejected" ? XCircle : MessageSquareText;
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize", decisionTone[status])}><Icon className="h-3.5 w-3.5" />{status}</span>;
}

function DecisionLog({ incident }: { incident: Incident }) {
  const incidentId = incident.id;
  const queryClient = useQueryClient();
  const decisions = useQuery({ queryKey: ["decisions", incidentId], queryFn: () => api.decisions(incidentId) });
  const [kind, setKind] = useState<DecisionKind>("mitigation");
  const [status, setStatus] = useState<DecisionStatus>("proposed");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [aiSource, setAiSource] = useState<AssistantResponse | null>(null);
  const createDecision = useMutation({
    mutationFn: () => api.createDecision(incidentId, { kind, status, title: title.trim(), detail: detail.trim() }),
    onSuccess: (decision) => {
      queryClient.setQueryData<IncidentDecision[]>(["decisions", incidentId], (current) => [decision, ...(current ?? [])]);
      setTitle("");
      setDetail("");
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] })
  });
  const draftDecision = useMutation({
    mutationFn: () => api.ask(`Using only ${incident.code} evidence, identify the strongest causal hypothesis and propose one reversible mitigation. Separate observation from hypothesis and state uncertainty.`, incident.id),
    onSuccess: (response) => {
      const peak = incident.events.reduce<Incident["events"][number] | undefined>((current, event) => !current || event.impactScore > current.impactScore ? event : current, undefined);
      setKind("hypothesis");
      setStatus("proposed");
      setTitle((peak ? `Validate ${peak.title}` : `Review ${incident.service} propagation`).slice(0, 120));
      setDetail(response.answer.slice(0, 800));
      setAiSource(response);
    }
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createDecision.mutate();
  }

  return (
    <div className="grid min-h-[330px] lg:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.28fr)]">
      <form className="border-b border-line bg-rail p-5 sm:p-6 lg:border-b-0 lg:border-r" onSubmit={submit}>
        <h3 className="section-title">Record the reason, not only the action</h3>
        <p className="mt-1 max-w-xl text-sm leading-6 text-muted">Decisions stay attached to this incident so the next responder can audit what changed and why.</p>
        <button type="button" className="control-secondary mt-4 inline-flex w-full items-center justify-center gap-2" onClick={() => draftDecision.mutate()} disabled={draftDecision.isPending || incident.events.length === 0}>{draftDecision.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}{draftDecision.isPending ? "Synthesizing evidence" : "Draft from evidence with AI"}</button>
        {aiSource && <div className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" /><p>Drafted in <strong className="text-ink">{aiSource.mode === "provider" ? "model" : "deterministic fallback"}</strong> mode at <span className="measurement-number">{Math.round(aiSource.confidence * 100)}%</span> confidence. Review and edit before recording.</p></div>}
        {draftDecision.error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">{draftDecision.error instanceof Error ? draftDecision.error.message : "Evidence synthesis failed. Write the decision manually or try again."}</p>}
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <label className="text-sm font-semibold">Decision type<select className="field mt-2" value={kind} onChange={(event) => setKind(event.target.value as DecisionKind)}><option value="hypothesis">Hypothesis</option><option value="mitigation">Mitigation</option><option value="communication">Communication</option></select></label>
          <label className="text-sm font-semibold">Disposition<select className="field mt-2" value={status} onChange={(event) => setStatus(event.target.value as DecisionStatus)}><option value="proposed">Proposed</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
        </div>
        <label className="mt-4 block text-sm font-semibold">Decision title<input className="field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Reduce checkout retries to one" minLength={4} maxLength={120} required /></label>
        <label className="mt-4 block text-sm font-semibold">Evidence and rationale<textarea className="field mt-2 min-h-24 resize-y py-3" value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="Replica lag preceded retry amplification; reducing retries protects payments while the replica recovers." minLength={8} maxLength={800} required /></label>
        {createDecision.error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">{createDecision.error instanceof Error ? createDecision.error.message : "The decision could not be recorded. Try again."}</p>}
        <button className="control-primary mt-4 inline-flex w-full items-center justify-center gap-2" disabled={createDecision.isPending}>{createDecision.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Gavel className="h-4 w-4" />}{createDecision.isPending ? "Recording decision" : "Record decision"}</button>
      </form>

      <div className="min-w-0">
        <div className="flex items-center justify-between px-5 py-4 sm:px-6"><div><h3 className="section-title">Incident decisions</h3><p className="mt-1 text-xs text-muted">Newest first · auditable in the operations ledger</p></div><span className="measurement-number text-xs text-muted">{decisions.data?.length ?? 0} records</span></div>
        <div className="border-t border-line">
          {decisions.isLoading && <div className="flex min-h-52 items-center justify-center text-sm text-muted"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Loading decisions</div>}
          {decisions.error && <div className="px-6 py-10 text-center"><TriangleAlert className="mx-auto h-5 w-5 text-danger" /><p className="mt-2 text-sm font-semibold">Decision history is unavailable</p><button className="control-secondary mt-4" onClick={() => void decisions.refetch()}>Retry</button></div>}
          {decisions.data?.map((decision) => (
            <article key={decision.id} className="border-b border-line px-5 py-4 last:border-b-0 sm:px-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{decision.title}</span><span className="measurement-number text-xs uppercase text-muted">{decision.kind}</span></div><p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{decision.detail}</p></div><DecisionMark status={decision.status} /></div>
              <p className="mt-3 text-xs text-faint">{decision.actor} · {formatRelative(decision.timestamp)}</p>
            </article>
          ))}
          {decisions.data && !decisions.data.length && <div className="px-6 py-12 text-center"><Gavel className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">No decisions recorded yet</p><p className="mt-1 text-sm text-muted">Capture the first hypothesis or mitigation before the incident changes hands.</p></div>}
        </div>
      </div>
    </div>
  );
}

function ImpactRail({ label, value, tone }: { label: string; value: number; tone: "baseline" | "projected" }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs"><span className="font-semibold text-muted">{label}</span><span className="measurement-number font-semibold">{value}/100</span></div>
      <div className="relative h-3 overflow-hidden rounded-full bg-line/55" aria-label={`${label}: ${value} out of 100`}>
        <motion.div className={cn("absolute inset-y-0 left-0 rounded-full", tone === "baseline" ? "bg-danger" : value <= 60 ? "bg-success" : value <= 78 ? "bg-warning" : "bg-danger")} initial={{ width: 0 }} animate={{ width: `${value}%` }} transition={{ type: "spring", stiffness: 150, damping: 24 }} />
      </div>
    </div>
  );
}

function ReplayLab({ incident, onResult }: { incident: Incident; onResult(result: ReplayResult): void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [config, setConfig] = useState<ReplayConfig>({ retryCeiling: 1, concurrencyCap: 18, timeoutMs: 1800 });
  const [result, setResult] = useState<ReplayResult | null>(null);
  const approvals = useQuery({ queryKey: ["mitigations", incident.id], queryFn: () => api.mitigations(incident.id) });
  const replay = useMutation({
    mutationFn: () => api.runReplay(incident.id, config),
    onSuccess: (value) => { setResult(value); onResult(value); },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] })
  });
  const requestApproval = useMutation({
    mutationFn: () => api.requestMitigation(incident.id, {
      title: `Apply bounded mitigation for ${incident.service}`,
      action: `Set retry ceiling to ${config.retryCeiling}, concurrency cap to ${config.concurrencyCap}, and downstream timeout to ${config.timeoutMs}ms for a bounded observation window.`,
      rollbackPlan: "Restore the previous retry, concurrency, and timeout values immediately if error rate or projected impact worsens."
    }),
    onSuccess: (value) => queryClient.setQueryData<MitigationRequest[]>(["mitigations", incident.id], (current) => [value, ...(current ?? [])])
  });
  const reviewApproval = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "approved" | "rejected" }) => api.reviewMitigation(id, status),
    onSuccess: (value) => queryClient.setQueryData<MitigationRequest[]>(["mitigations", incident.id], (current) => (current ?? []).map((item) => item.id === value.id ? value : item))
  });
  const baselinePeak = Math.max(0, ...incident.events.map((event) => event.impactScore));

  return (
    <div className="grid min-h-[330px] xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.3fr)]">
      <div className="border-b border-line bg-rail p-5 sm:p-6 xl:border-b-0 xl:border-r">
        <h3 className="section-title">Counterfactual controls</h3>
        <p className="mt-1 max-w-xl text-sm leading-6 text-muted">Change one mitigation profile and replay it against the recorded event sequence. No production systems are touched.</p>
        <label className="mt-5 block text-sm font-semibold">Retry ceiling <span className="measurement-number float-right text-muted">{config.retryCeiling}</span><input className="mt-3 h-2 w-full cursor-pointer accent-[oklch(var(--accent))]" type="range" min="1" max="4" value={config.retryCeiling} onChange={(event) => setConfig((current) => ({ ...current, retryCeiling: Number(event.target.value) }))} /></label>
        <label className="mt-5 block text-sm font-semibold">Concurrency cap <span className="measurement-number float-right text-muted">{config.concurrencyCap} workers</span><input className="mt-3 h-2 w-full cursor-pointer accent-[oklch(var(--accent))]" type="range" min="5" max="50" step="1" value={config.concurrencyCap} onChange={(event) => setConfig((current) => ({ ...current, concurrencyCap: Number(event.target.value) }))} /></label>
        <label className="mt-5 block text-sm font-semibold">Downstream timeout <span className="measurement-number float-right text-muted">{config.timeoutMs}ms</span><input className="mt-3 h-2 w-full cursor-pointer accent-[oklch(var(--accent))]" type="range" min="500" max="5000" step="100" value={config.timeoutMs} onChange={(event) => setConfig((current) => ({ ...current, timeoutMs: Number(event.target.value) }))} /></label>
        {replay.error && <p role="alert" className="mt-4 rounded-control bg-danger/10 p-3 text-sm text-danger">{replay.error instanceof Error ? replay.error.message : "The replay could not be completed. Review the controls and try again."}</p>}
        <button className="control-primary mt-6 inline-flex w-full items-center justify-center gap-2" disabled={replay.isPending || incident.events.length === 0} onClick={() => replay.mutate()}>{replay.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{replay.isPending ? "Replaying recorded sequence" : "Run mitigation replay"}</button>
        {!incident.events.length && <p className="mt-2 text-xs text-muted">Add at least one evidence event before running a replay.</p>}
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="section-title">Projected propagation</h3><p className="mt-1 text-sm text-muted">A deterministic estimate from {incident.events.length} recorded evidence events.</p></div><span className="measurement-number rounded-full bg-elevated px-2.5 py-1 text-xs text-muted">SYNTHETIC MODEL</span></div>
        <div className="mt-7 space-y-5">
          <ImpactRail label="Recorded peak" value={result?.projection.baselinePeak ?? baselinePeak} tone="baseline" />
          <ImpactRail label="Projected peak" value={result?.projection.projectedPeak ?? baselinePeak} tone="projected" />
        </div>
        <AnimatePresence mode="wait">
          {result ? (
            <motion.div key={result.id} className="mt-7" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="flex flex-wrap items-center gap-2"><span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize", result.projection.state === "contained" ? "bg-success/12 text-success" : result.projection.state === "degraded" ? "bg-warning/12 text-warning" : "bg-danger/10 text-danger")}><ShieldCheck className="h-3.5 w-3.5" />{result.projection.state}</span><span className="measurement-number text-xs text-muted">{result.projection.confidence}% evidence confidence</span></div>
              <p className="mt-3 max-w-3xl text-sm leading-6">{result.projection.summary}</p>
              <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 border-y border-line py-4 sm:grid-cols-3">
                <div><dt className="text-xs text-muted">Peak reduction</dt><dd className="measurement-number mt-1 text-lg font-semibold">-{result.projection.baselinePeak - result.projection.projectedPeak}</dd></div>
                <div><dt className="text-xs text-muted">Events avoided</dt><dd className="measurement-number mt-1 text-lg font-semibold">{result.projection.avoidedHighImpactEvents}</dd></div>
                <div><dt className="text-xs text-muted">Recovery gain</dt><dd className="measurement-number mt-1 text-lg font-semibold">{result.projection.recoveryGainMinutes}m</dd></div>
              </dl>
              <ul className="mt-4 grid gap-2 text-xs text-muted sm:grid-cols-3">{result.projection.signals.map((signal) => <li key={signal} className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />{signal}</li>)}</ul>
              <div className="mt-6 border-t border-line pt-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-semibold">Production approval boundary</h4><p className="mt-1 max-w-2xl text-xs leading-5 text-muted">ReplayOps records the exact proposed action and rollback plan. A separate administrator must approve it; this application does not execute infrastructure commands.</p></div><button className="control-primary" disabled={requestApproval.isPending} onClick={() => requestApproval.mutate()}><ShieldCheck className="mr-2 h-4 w-4" />{requestApproval.isPending ? "Requesting…" : "Request approval"}</button></div>{requestApproval.error && <p className="mt-3 text-sm text-danger">{requestApproval.error.message}</p>}</div>
            </motion.div>
          ) : (
            <div className="mt-7 flex min-h-36 items-center justify-center border-y border-line text-center"><div><Gauge className="mx-auto h-6 w-6 text-faint" /><p className="mt-3 font-semibold">Ready to test a mitigation</p><p className="mt-1 max-w-md text-sm leading-6 text-muted">Run the current controls to compare the recorded peak with a reproducible counterfactual.</p></div></div>
          )}
        </AnimatePresence>
        {approvals.data?.length ? <div className="mt-6 border-t border-line pt-5"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">Mitigation approvals</h4><span className="measurement-number text-xs text-muted">{approvals.data.length} requests</span></div><div className="mt-3 space-y-3">{approvals.data.slice(0, 4).map((approval) => { const selfReview = approval.requestedBy === user?.email; return <article key={approval.id} className="rounded-control bg-elevated p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold">{approval.title}</p><p className="mt-1 text-xs leading-5 text-muted">{approval.action}</p><p className="mt-2 text-xs leading-5"><strong>Rollback:</strong> {approval.rollbackPlan}</p></div><span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold capitalize", approval.status === "approved" ? "bg-success/12 text-success" : approval.status === "rejected" ? "bg-danger/10 text-danger" : "bg-warning/12 text-warning")}>{approval.status}</span></div>{approval.status === "pending" && <div className="mt-3 flex gap-2"><button className="control-secondary !min-h-9" disabled={selfReview} title={selfReview ? "A different administrator must approve this request." : undefined} onClick={() => reviewApproval.mutate({ id: approval.id, status: "approved" })}>Approve</button><button className="control-quiet !min-h-9 text-danger" disabled={selfReview} title={selfReview ? "A different administrator must review this request." : undefined} onClick={() => reviewApproval.mutate({ id: approval.id, status: "rejected" })}>Reject</button></div>}<p className="mt-3 text-xs text-faint">Requested by {approval.requestedBy}{approval.reviewedBy ? ` · reviewed by ${approval.reviewedBy}` : selfReview ? " · waiting for another administrator" : " · independent review required"}</p></article>; })}</div>{reviewApproval.error && <p className="mt-3 text-sm text-danger">{reviewApproval.error.message}</p>}</div> : null}
      </div>
    </div>
  );
}

function buildHandoff(incident: Incident, decisions: IncidentDecision[], replay: ReplayResult | null) {
  const peak = incident.events.reduce<Incident["events"][number] | undefined>((current, event) => !current || event.impactScore > current.impactScore ? event : current, undefined);
  const approved = decisions.filter((decision) => decision.status === "approved");
  return `# ${incident.code} shift handoff — ${incident.title}

Status: ${incident.status} · Severity: ${incident.severity} · Owner: ${incident.owner}
Primary service: ${incident.service} · Evidence events: ${incident.events.length}

## Current situation
${incident.summary}

## Evidence checkpoint
${peak ? `Highest-impact transition: ${peak.title} (${peak.service}, ${formatClock(peak.timestamp)} UTC, impact ${peak.impactScore}/100).\n${peak.detail}` : "No evidence events have been recorded yet."}

## Approved decisions
${approved.length ? approved.map((decision) => `- ${decision.title}: ${decision.detail}`).join("\n") : "- No approved decisions recorded."}

## Latest mitigation replay
${replay ? `${replay.projection.summary} Recorded peak ${replay.projection.baselinePeak}/100 → projected ${replay.projection.projectedPeak}/100; ${replay.projection.confidence}% evidence confidence.` : "No mitigation replay has been run in this session."}

## Next responder
- Validate the highest-impact transition against source telemetry.
- Confirm approved mitigations remain within service guardrails.
- Record new evidence and rerun the mitigation profile if the propagation path changes.

Generated by ReplayOps from synthetic incident evidence.`;
}

function HandoffBrief({ incident, latestReplay }: { incident: Incident; latestReplay: ReplayResult | null }) {
  const decisions = useQuery({ queryKey: ["decisions", incident.id], queryFn: () => api.decisions(incident.id) });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const brief = useMemo(() => buildHandoff(incident, decisions.data ?? [], latestReplay), [incident, decisions.data, latestReplay]);

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(brief);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  }

  function downloadBrief() {
    const url = URL.createObjectURL(new Blob([brief], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${incident.code.toLowerCase()}-handoff.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid min-h-[330px] lg:grid-cols-[minmax(280px,0.55fr)_minmax(0,1.45fr)]">
      <div className="border-b border-line bg-rail p-5 sm:p-6 lg:border-b-0 lg:border-r">
        <h3 className="section-title">A handoff that preserves reasoning</h3>
        <p className="mt-2 text-sm leading-6 text-muted">The brief assembles incident state, the strongest evidence, approved decisions, and the latest replay result into portable Markdown.</p>
        <div className="mt-5 space-y-3 text-sm"><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /> {incident.events.length} evidence events included</div><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /> {decisions.data?.filter((decision) => decision.status === "approved").length ?? 0} approved decisions included</div><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /> {latestReplay ? "Latest replay attached" : "Replay section reserved"}</div></div>
        <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"><button className="control-primary inline-flex items-center justify-center gap-2" onClick={() => void copyBrief()}><ClipboardCopy className="h-4 w-4" />{copyState === "copied" ? "Copied" : "Copy brief"}</button><button className="control-secondary inline-flex items-center justify-center gap-2" onClick={downloadBrief}><Download className="h-4 w-4" />Download .md</button></div>
        {copyState === "error" && <p role="alert" className="mt-3 text-sm text-danger">Clipboard access was blocked. Download the Markdown brief instead.</p>}
      </div>
      <div className="min-w-0 p-5 sm:p-6"><div className="flex items-center justify-between gap-3"><div><h3 className="section-title">Preview</h3><p className="mt-1 text-xs text-muted">Updates as decisions and replay results change</p></div><span className="measurement-number text-xs text-muted">MARKDOWN</span></div><pre className="measurement-number mt-5 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-control bg-elevated p-4 text-xs leading-6 text-ink">{brief}</pre></div>
    </div>
  );
}

export function ResponseConsole({ incident }: { incident: Incident }) {
  const [mode, setMode] = useState<ConsoleMode>("diagnose");
  const [latestReplay, setLatestReplay] = useState<ReplayResult | null>(null);

  return (
    <section className="surface overflow-hidden" aria-labelledby="response-console-title">
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div><h2 id="response-console-title" className="font-heading text-xl font-semibold tracking-[-0.025em]">Diagnostic proof loop</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Rank the likely cause, try to disprove it, then replay a reversible mitigation before touching production.</p></div>
        <div className="flex overflow-x-auto rounded-control bg-rail p-1" role="tablist" aria-label="Response console modes">
          {modeItems.map((item) => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={cn("flex min-h-10 shrink-0 items-center gap-2 rounded-[8px] px-3 text-xs font-semibold transition-colors sm:text-sm", mode === item.id ? "bg-ink text-panel" : "text-muted hover:bg-elevated hover:text-ink")} onClick={() => setMode(item.id)}><item.icon className="h-4 w-4" />{item.label}{item.id === "replay" && latestReplay ? <span className="status-dot bg-success" /> : null}</button>)}
        </div>
      </div>
      <div className="border-t border-line">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={mode} role="tabpanel" initial={{ opacity: 0.65, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.16 }}>
            {mode === "diagnose" ? <DiagnosisPanel incident={incident} /> : mode === "decisions" ? <DecisionLog incident={incident} /> : mode === "replay" ? <ReplayLab incident={incident} onResult={setLatestReplay} /> : <HandoffBrief incident={incident} latestReplay={latestReplay} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
