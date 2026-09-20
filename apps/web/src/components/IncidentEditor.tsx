import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { Incident, IncidentStatus, Severity } from "../types";

export type IncidentDraft = Omit<Incident, "id" | "code" | "createdAt" | "updatedAt" | "events">;

const dateInputValue = (value?: string | null) => value ? new Date(value).toISOString().slice(0, 16) : "";

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
  const [severity, setSeverity] = useState<Severity>("high");
  const [status, setStatus] = useState<IncidentStatus>("investigating");
  const [owner, setOwner] = useState("");
  const [startedAt, setStartedAt] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(incident?.title ?? "");
    setSummary(incident?.summary ?? "");
    setService(incident?.service ?? "");
    setSeverity(incident?.severity ?? "high");
    setStatus(incident?.status ?? "investigating");
    setOwner(incident?.owner ?? "");
    setStartedAt(dateInputValue(incident?.startedAt ?? new Date().toISOString()));
  }, [incident, open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      title: title.trim(),
      summary: summary.trim(),
      service: service.trim(),
      severity,
      status,
      owner: owner.trim(),
      startedAt: new Date(startedAt).toISOString(),
      resolvedAt: status === "resolved" ? incident?.resolvedAt ?? new Date().toISOString() : null
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
              <label className="block text-sm font-semibold">Incident title<input className="field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} required placeholder="Describe the failure and its effect" /></label>
              <label className="block text-sm font-semibold">Evidence summary<textarea className="field mt-2 min-h-28 resize-y py-3" value={summary} onChange={(event) => setSummary(event.target.value)} minLength={12} maxLength={800} required placeholder="State what is observed without over-claiming root cause" /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold">Primary service<input className="field mt-2" value={service} onChange={(event) => setService(event.target.value)} required placeholder="checkout-api" /></label>
                <label className="block text-sm font-semibold">Owner<input className="field mt-2" value={owner} onChange={(event) => setOwner(event.target.value)} required placeholder="On-call responder" /></label>
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
