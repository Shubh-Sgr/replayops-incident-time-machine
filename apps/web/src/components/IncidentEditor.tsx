import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { Incident, IncidentStatus, Severity } from "../types";
import { api } from "../lib/api";
import { toLocalDateTimeInput } from "../lib/utils";

export type IncidentDraft = Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events"> & { intakeLink?: string };

export function IncidentEditor({
  open,
  incident,
  saving,
  error,
  onClose,
  onSave
}: {
  open: boolean;
  incident?: Incident | null;
  saving?: boolean;
  error?: string;
  onClose(): void;
  onSave(value: IncidentDraft): void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [service, setService] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [customerImpact, setCustomerImpact] = useState("");
  const [severity, setSeverity] = useState<Severity>("high");
  const [status, setStatus] = useState<IncidentStatus>("investigating");
  const [owner, setOwner] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [intakeLink,setIntakeLink]=useState("");
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers, enabled: open });

  useEffect(() => {
    if (!open) return;
    setTitle(incident?.title ?? "");
    setSummary(incident?.summary ?? "");
    setService(incident?.service ?? "");
    setEnvironment(incident?.environment ?? "production");
    setCustomerImpact(incident?.customerImpact ?? "");
    setSeverity(incident?.severity ?? "high");
    setStatus(incident?.status ?? "investigating");
    setOwner(incident?.owner ?? "");
    setStartedAt(toLocalDateTimeInput(incident?.startedAt ?? new Date().toISOString()));
    setIntakeLink("");
  }, [incident, open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      title: title.trim(),
      summary: summary.trim(),
      service: service.trim(),
      environment: environment.trim(),
      customerImpact: customerImpact.trim() || "Unknown until measured",
      severity,
      status,
      owner: owner.trim(),
      startedAt: new Date(startedAt).toISOString(),
      resolvedAt: status === "resolved" ? incident?.resolvedAt ?? new Date().toISOString() : null,
      intakeLink: intakeLink.trim() || undefined
    });
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/22 p-0 sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.form
            role="dialog"
            aria-modal="true"
            aria-labelledby="incident-editor-title"
            className="max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-t-panel bg-panel p-5 shadow-drawer sm:rounded-panel sm:p-6"
            initial={{ y: 32, opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 390, damping: 34 }}
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={submit}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="incident-editor-title" className="font-heading text-xl font-semibold">{incident ? `Edit ${incident.code}` : "Create incident"}</h2>
                <p className="mt-1 text-sm text-muted">Record the operational facts first. Causal conclusions belong in the timeline.</p>
              </div>
              <button type="button" className="control-quiet !px-3" onClick={onClose} aria-label="Close incident editor"><X className="h-4 w-4" /></button>
            </div>

            <div className="mt-6 space-y-5">
              {!incident && <label className="block text-sm font-semibold">Alert or trace link <span className="font-normal text-muted">(optional)</span><input type="url" className="field mt-2" value={intakeLink} onChange={(event) => setIntakeLink(event.target.value)} onBlur={() => { if (!intakeLink) return; try { const url = new URL(intakeLink); const inferred = url.hostname.split(".")[0] || "unknown-service"; if (!service) setService(inferred); if (!title) setTitle(`Investigate alert from ${inferred}`); if (!summary) setSummary(`Alert or trace evidence was imported from ${url.hostname}. The observed symptom and affected requests still need confirmation.`); } catch { /* Native URL validation reports the error. */ } }} placeholder="https://grafana.example/alerting/... or trace URL" /><span className="mt-1 block text-xs leading-5 text-muted">Paste first, then tab away to prefill a minimal investigation. ReplayOps attaches the source as the first evidence item.</span></label>}
              <label className="block text-sm font-semibold">Incident title<input className="field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} required placeholder="Describe the failure and its effect" /></label>
              <label className="block text-sm font-semibold">Evidence summary<textarea className="field mt-2 min-h-28 resize-y py-3" value={summary} onChange={(event) => setSummary(event.target.value)} minLength={12} maxLength={800} required placeholder="State what is observed without over-claiming root cause" /></label>
              <label className="block text-sm font-semibold">Customer symptom / impact<textarea className="field mt-2 min-h-20 resize-y py-3" value={customerImpact} onChange={(event) => setCustomerImpact(event.target.value)} maxLength={800} placeholder="Known: 47 of 2,140 checkout attempts failed in eu-west. Unknown: mobile-only denominator." /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold">Primary service<input className="field mt-2" value={service} onChange={(event) => setService(event.target.value)} required placeholder="checkout-api" /></label>
                <label className="block text-sm font-semibold">Environment<input className="field mt-2" value={environment} onChange={(event) => setEnvironment(event.target.value)} required placeholder="production" /></label>
                <label className="block text-sm font-semibold">Owner<select className="field mt-2" value={owner} onChange={(event) => setOwner(event.target.value)} required><option value="" disabled>Select a responder</option>{members.data?.map((member) => <option key={member.userId} value={member.email}>{member.displayName} · {member.role}</option>)}{owner && !members.data?.some((member) => member.email === owner) && <option value={owner}>{owner}</option>}</select></label>
                <label className="block text-sm font-semibold">Severity<select className="field mt-2" value={severity} onChange={(event) => setSeverity(event.target.value as Severity)}><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
                <label className="block text-sm font-semibold">Status<select className="field mt-2" value={status} onChange={(event) => setStatus(event.target.value as IncidentStatus)}><option value="investigating">Investigating</option><option value="identified">Identified</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select></label>
              </div>
              <label className="block text-sm font-semibold">Started at<input type="datetime-local" className="field mt-2" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} required /></label>
            </div>

            {error && <p role="alert" className="mt-5 rounded-control bg-danger/10 p-3 text-sm text-danger">{error} Review the fields and try again.</p>}

            <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" className="control-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="control-primary min-w-36" disabled={saving}>{saving ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" /> Saving</span> : incident ? "Save changes" : "Create incident"}</button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
