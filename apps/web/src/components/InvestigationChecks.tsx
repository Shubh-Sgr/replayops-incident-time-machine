import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleHelp, LoaderCircle, Play, TriangleAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { usePersistentDraft } from "../lib/usePersistentDraft";
import { useOwnerName } from "../lib/useOwnerName";
import { cn, formatRelative } from "../lib/utils";
import type { DiagnosticHypothesis, HypothesisTest, Incident, InvestigationCheck, SuggestedCheck } from "../types";

type Outcome = "supported" | "disproved" | "inconclusive";

/** One check, whether it came from an explanation's next test or from the suggested-check list. */
type UnifiedCheck = {
  key: string;
  source: "test" | "check";
  id: string;
  title: string;
  instruction: string;
  assignee: string;
  status: HypothesisTest["status"];
  result: string;
  updatedAt: string;
  needsRecheck: boolean;
  evidenceIds: string[];
  hypothesisId?: string;
};

const fromTest = (test: HypothesisTest): UnifiedCheck => ({ key: `test-${test.id}`, source: "test", id: test.id, title: test.title.replace(/^Test: /, ""), instruction: test.instruction, assignee: test.assignee, status: test.status, result: test.result, updatedAt: test.updatedAt, needsRecheck: false, evidenceIds: [], hypothesisId: test.hypothesisId });
const fromCheck = (check: InvestigationCheck): UnifiedCheck => ({ key: `check-${check.id}`, source: "check", id: check.id, title: check.title, instruction: `${check.question} ${check.method}`, assignee: check.assignee, status: check.status, result: check.result, updatedAt: check.updatedAt, needsRecheck: check.conclusionState === "needs_recheck", evidenceIds: check.evidenceIds });
const isOpen = (item: UnifiedCheck) => item.status === "planned" || item.status === "running";

const outcomeLabel: Record<Outcome, string> = { supported: "Confirms it", disproved: "Rules it out", inconclusive: "Unclear" };
const outcomeStyle: Record<Outcome, string> = { supported: "bg-success/12 text-success", disproved: "bg-danger/10 text-danger", inconclusive: "bg-warning/12 text-warning" };

function OpenCheckCard({ item, incident }: { item: UnifiedCheck; incident: Incident }) {
  const client = useQueryClient();
  const ownerName = useOwnerName();
  const draft = usePersistentDraft(`replayops:${incident.id}:${item.key}`, item.result);
  const record = useMutation({
    mutationFn: async (status: Outcome) => { if (item.source === "test") await api.updateHypothesisTest(item.id, status, draft.value.trim()); else await api.updateCheck(incident.id, item.id, { status, result: draft.value.trim(), evidenceIds: item.evidenceIds }); },
    onSuccess: (_value, status) => {
      draft.clear();
      void client.invalidateQueries({ queryKey: ["hypothesis-tests", incident.id] });
      void client.invalidateQueries({ queryKey: ["casework", incident.id] });
      void client.invalidateQueries({ queryKey: ["diagnosis", incident.id] });
      if (item.source === "test") void api.recordProductOutcome("test_completed", { incidentId: incident.id, testId: item.id, status });
    }
  });
  const ready = draft.value.trim().length >= 8;
  return <article id={item.source === "test" ? `test-${item.id}` : `check-${item.id}`} className="scroll-mt-24 rounded-control border border-info/25 bg-panel p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-semibold">{item.title}</p><span className="rounded-full bg-info/10 px-2.5 py-1 text-xs font-semibold text-info">In progress · {ownerName(item.assignee)}</span></div>
    <p className="mt-1 text-sm leading-6 text-muted">{item.instruction}</p>
    <label className="mt-3 block text-xs font-semibold text-muted">What did you see?
      <textarea className="field mt-1.5 min-h-20 resize-y py-3 text-sm font-normal text-ink" value={draft.value} onChange={(event) => draft.setValue(event.target.value)} placeholder="e.g. The 20 slowest requests all waited over 3 s on the inventory replica; healthy requests did not." />
    </label>
    <p className="mt-2 text-xs text-muted">Then say what it means for the current explanation:</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button className="control-secondary inline-flex !min-h-9 items-center" disabled={!ready || record.isPending} onClick={() => record.mutate("supported")}><CheckCircle2 className="mr-1.5 h-4 w-4 text-success" />Confirms it</button>
      <button className="control-secondary inline-flex !min-h-9 items-center" disabled={!ready || record.isPending} onClick={() => record.mutate("disproved")}><XCircle className="mr-1.5 h-4 w-4 text-danger" />Rules it out</button>
      <button className="control-quiet inline-flex !min-h-9 items-center" disabled={!ready || record.isPending} onClick={() => record.mutate("inconclusive")}><CircleHelp className="mr-1.5 h-4 w-4" />Unclear</button>
    </div>
    {!ready && <p className="mt-2 text-xs text-faint">Write at least a short sentence about what you saw to record a result.</p>}
    {record.isPending && <p className="mt-2 inline-flex items-center gap-2 text-xs text-info"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving…</p>}
    {record.error && <p role="alert" className="mt-2 text-xs text-danger">{record.error.message}</p>}
    {draft.savedAt && draft.value.trim() && <p className="mt-2 text-xs text-faint">Draft saved {formatRelative(draft.savedAt)}</p>}
  </article>;
}

/** The recommended next check for the selected explanation, started with one click. */
export function RecommendedCheck({ incident, hypothesis }: { incident: Incident; hypothesis: DiagnosticHypothesis }) {
  const client = useQueryClient();
  const tests = useQuery({ queryKey: ["hypothesis-tests", incident.id], queryFn: () => api.hypothesisTests(incident.id) });
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers });
  const [assignee, setAssignee] = useState(incident.owner);
  const open = tests.data?.find((test) => test.hypothesisId === hypothesis.id && (test.status === "planned" || test.status === "running") && test.instruction === hypothesis.nextTest);
  const start = useMutation({
    mutationFn: () => api.createHypothesisTest(incident.id, { hypothesisId: hypothesis.id, title: hypothesis.title, instruction: hypothesis.nextTest, assignee: assignee || incident.owner }),
    onSuccess: (value) => { client.setQueryData<HypothesisTest[]>(["hypothesis-tests", incident.id], (current) => [value, ...(current ?? [])]); void api.recordProductOutcome("test_started", { incidentId: incident.id, testId: value.id }); }
  });
  if (open) return <div className="mt-6"><p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">Check in progress</p><div className="mt-2"><OpenCheckCard item={fromTest(open)} incident={incident} /></div></div>;
  return <div className="mt-6 rounded-control bg-elevated p-4">
    <p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">Recommended next check</p>
    <p className="mt-2 text-sm font-semibold leading-6">{hypothesis.nextTest}</p>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <button className="inline-flex items-center control-primary" onClick={() => start.mutate()} disabled={start.isPending || hypothesis.state === "disproved"}><Play className="mr-2 h-4 w-4" />Start this check</button>
      <label className="flex items-center gap-2 text-xs text-muted">Owner
        <select className="field !min-h-9 max-w-56 text-sm" value={assignee} onChange={(event) => setAssignee(event.target.value)}>{members.data?.map((member) => <option key={member.userId} value={member.email}>{member.displayName}</option>)}{!members.data?.some((member) => member.email === assignee) && <option value={assignee}>{assignee}</option>}</select>
      </label>
    </div>
    {start.error && <p role="alert" className="mt-2 text-xs text-danger">{start.error.message}</p>}
  </div>;
}

/** Every check for the incident in one place: in progress, already done, and more ideas. */
export function InvestigationChecks({ incident, recommended }: { incident: Incident; recommended?: DiagnosticHypothesis }) {
  const client = useQueryClient();
  const ownerName = useOwnerName();
  const tests = useQuery({ queryKey: ["hypothesis-tests", incident.id], queryFn: () => api.hypothesisTests(incident.id) });
  const casework = useQuery({ queryKey: ["casework", incident.id, incident.evidenceRevision], queryFn: () => api.casework(incident.id) });
  const acknowledge = useMutation({ mutationFn: () => api.acknowledgeEvidence(incident.id), onSuccess: () => void client.invalidateQueries({ queryKey: ["casework", incident.id] }) });
  const create = useMutation({
    mutationFn: (template: SuggestedCheck) => api.createCheck(incident.id, { templateId: template.id, title: template.title, question: template.question, method: template.method, expectedSignal: template.expectedSignal, conditions: `${incident.service} · ${incident.environment ?? "unknown"} · evidence ${incident.evidenceRevision ?? incident.updatedAt}`, assignee: incident.owner, evidenceIds: incident.events.filter((event) => event.evidenceState !== "excluded").slice(-5).map((event) => event.id) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["casework", incident.id] })
  });
  const all = [...(tests.data ?? []).map(fromTest), ...(casework.data?.checks ?? []).map(fromCheck)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  // The recommended check's open card is shown next to its explanation, so don't repeat it here.
  const open = all.filter((item) => isOpen(item) && !(recommended && item.source === "test" && item.hypothesisId === recommended.id && item.instruction === recommended.nextTest));
  const done = all.filter((item) => !isOpen(item));
  const started = new Set(all.map((item) => item.title));
  const suggestions = (casework.data?.suggestedChecks ?? []).filter((item) => item.applicable && !started.has(item.title));
  const changed = casework.data?.evidenceReview.changed;
  return <section className="border-t border-line p-5 sm:p-6">
    <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between"><div><h3 className="section-title">Checks</h3><p className="mt-1 max-w-3xl text-sm leading-6 text-muted">A check is one concrete thing you look at: a log, a diff, a dashboard, a trace. Write what you saw and whether it confirms or rules out the current explanation. ReplayOps updates the explanation and the next step from your answers, and the handoff lists everything that was tried.</p></div></div>
    {changed && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control bg-warning/10 p-3"><p className="text-sm"><strong>New evidence since your last review.</strong> Earlier results stay visible; ones that may be affected are marked "recheck".</p><button className="control-secondary !min-h-9" onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>Mark as reviewed</button></div>}
    {open.length > 0 && <div className="mt-5"><p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">In progress</p><div className="mt-2 grid gap-3 xl:grid-cols-2">{open.map((item) => <OpenCheckCard key={item.key} item={item} incident={incident} />)}</div></div>}
    <div className="mt-5"><p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">Already checked</p>
      {done.length ? <ol className="mt-2 divide-y divide-line rounded-control bg-elevated">{done.map((item) => { const outcome = item.status as Outcome; return <li key={item.key} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="text-sm font-semibold">{item.title}</p><p className="mt-1 text-sm leading-6">{item.result}</p><p className="mt-1 text-xs text-faint">{ownerName(item.assignee)} · {formatRelative(item.updatedAt)}</p></div><div className="flex shrink-0 gap-2">{item.needsRecheck && <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-2.5 py-1 text-xs font-semibold text-warning"><TriangleAlert className="h-3.5 w-3.5" />recheck</span>}<span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", outcomeStyle[outcome])}>{outcomeLabel[outcome]}</span></div></li>; })}</ol>
        : <p className="mt-2 text-sm text-muted">Nothing checked yet. Start the recommended check above, or pick one below.</p>}
    </div>
    {suggestions.length > 0 && <div className="mt-5"><p className="text-xs font-semibold uppercase tracking-[.12em] text-muted">Other useful checks</p><div className="mt-2 flex flex-wrap gap-2">{suggestions.map((item) => <button key={item.id} title={item.question} className="inline-flex items-center control-secondary !min-h-9" onClick={() => create.mutate(item)} disabled={create.isPending}><Play className="mr-2 h-3.5 w-3.5" />{item.title}</button>)}</div>{create.error && <p role="alert" className="mt-2 text-xs text-danger">{create.error.message}</p>}</div>}
  </section>;
}
