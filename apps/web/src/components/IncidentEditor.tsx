import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { Incident, Severity } from "../types";
import { api } from "../lib/api";
import { cn, toLocalDateTimeInput } from "../lib/utils";
import { useAuth } from "../providers/AuthProvider";

/** What the form saves. Status is never part of it: Fixed, Resolved and Reopen are actions on the incident. */
export type IncidentDraft = Pick<Incident, "title" | "summary" | "service" | "environment" | "customerImpact" | "severity" | "owner" | "startedAt"> & { intakeLink?: string };

const severities: Array<{ value: Severity; label: string }> = [
  { value: "critical", label: "Critical" }, { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }
];

export function IncidentEditor({ open, incident, saving, error, onClose, onSave }: {
  open: boolean;
  incident?: Incident | null;
  saving?: boolean;
  error?: string;
  onClose(): void;
  onSave(value: IncidentDraft): void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [service, setService] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [customerImpact, setCustomerImpact] = useState("");
  const [severity, setSeverity] = useState<Severity>("high");
  const [owner, setOwner] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [intakeLink, setIntakeLink] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers, enabled: open });

  useEffect(() => {
    if (!open) return;
    setTitle(incident?.title ?? "");
    setSummary(incident?.summary ?? "");
    setService(incident?.service ?? "");
    setEnvironment(incident?.environment && incident.environment !== "unknown" ? incident.environment : "production");
    setCustomerImpact(incident?.customerImpact && !/^unknown/i.test(incident.customerImpact) ? incident.customerImpact : "");
    setSeverity(incident?.severity ?? "high");
    setOwner(incident?.owner && incident.owner !== "Automation" ? incident.owner : user?.email ?? "");
    setStartedAt(toLocalDateTimeInput(incident?.startedAt ?? new Date().toISOString()));
    setIntakeLink("");
    setMoreOpen(false);
  }, [incident, open, user?.email]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const cleanTitle = title.trim();
    onSave({
      title: cleanTitle,
      summary: summary.trim().length >= 12 ? summary.trim() : summary.trim() ? `${summary.trim()} — ${cleanTitle}`.slice(0, 800) : `Reported by a responder: ${cleanTitle}`,
      service: service.trim(),
      environment: environment.trim() || "production",
      customerImpact: customerImpact.trim() || "Unknown until measured",
      severity,
      owner: owner.trim() || user?.email || "Unassigned",
      startedAt: new Date(startedAt).toISOString(),
      intakeLink: intakeLink.trim() || undefined
    });
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.form role="dialog" aria-modal="true" aria-labelledby="incident-editor-title"
            className="max-h-[94dvh] w-full max-w-xl overflow-y-auto rounded-t-panel bg-panel p-5 shadow-drawer sm:rounded-panel sm:p-6"
            initial={{ y: 24, opacity: 0.6 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={{ type: "spring", stiffness: 390, damping: 34 }}
            onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="incident-editor-title" className="font-heading text-xl font-semibold">{incident ? `Edit ${incident.code}` : "New incident"}</h2>
                <p className="mt-1 text-sm text-muted">{incident ? "Change the details. Use the buttons on the incident to mark it fixed or resolved." : "Just the basics. You can add details and evidence later."}</p>
              </div>
              <button type="button" className="control-quiet !px-3" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
            </div>

            <div className="mt-6 space-y-4">
              <label className="block text-sm font-semibold">What's broken?<input className="field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} required autoFocus placeholder="Checkout is failing for some users" /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold">Service<input className="field mt-2" value={service} onChange={(event) => setService(event.target.value)} minLength={2} maxLength={80} required placeholder="checkout-api" /></label>
                <label className="block text-sm font-semibold">Environment<input className="field mt-2" list="incident-environments" value={environment} onChange={(event) => setEnvironment(event.target.value)} minLength={2} maxLength={80} required /><datalist id="incident-environments"><option value="production" /><option value="staging" /><option value="development" /></datalist></label>
              </div>
              <fieldset><legend className="text-sm font-semibold">Severity</legend><div className="mt-2 grid grid-cols-4 gap-1 rounded-control bg-rail p-1">{severities.map((item) => <button key={item.value} type="button" aria-pressed={severity === item.value} className={cn("min-h-9 rounded-[8px] text-sm font-semibold", severity === item.value ? "bg-ink text-panel" : "text-muted hover:bg-elevated")} onClick={() => setSeverity(item.value)}>{item.label}</button>)}</div></fieldset>
              <label className="block text-sm font-semibold">What's happening? <span className="font-normal text-muted">(optional)</span><textarea className="field mt-2 min-h-20 resize-y py-3" value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={800} placeholder="What you're seeing, and since when" /></label>
              {!incident && <label className="block text-sm font-semibold">Link to the alert, dashboard or trace <span className="font-normal text-muted">(optional)</span><input type="url" className="field mt-2" value={intakeLink} onChange={(event) => setIntakeLink(event.target.value)} placeholder="https://…" /></label>}

              <button type="button" className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}><ChevronDown className={cn("h-4 w-4 transition-transform", moreOpen && "rotate-180")} />More details</button>
              {moreOpen && <div className="space-y-4 rounded-control bg-elevated p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-semibold">Started at<input type="datetime-local" className="field mt-2" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} required /></label>
                  <label className="block text-sm font-semibold">Owner<select className="field mt-2" value={owner} onChange={(event) => setOwner(event.target.value)}>{members.data?.map((member) => <option key={member.userId} value={member.email}>{member.displayName}</option>)}{owner && !members.data?.some((member) => member.email === owner) && <option value={owner}>{owner}</option>}</select></label>
                </div>
                <label className="block text-sm font-semibold">Who is affected, and how much? <span className="font-normal text-muted">(optional)</span><textarea className="field mt-2 min-h-16 resize-y py-3" value={customerImpact} onChange={(event) => setCustomerImpact(event.target.value)} maxLength={800} placeholder="e.g. about 2% of checkouts in EU fail" /></label>
              </div>}
            </div>

            {error && <p role="alert" className="mt-5 rounded-control bg-danger/10 p-3 text-sm text-danger">{error}</p>}

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" className="control-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="control-primary min-w-36" disabled={saving}>{saving ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />Saving</span> : incident ? "Save changes" : "Create incident"}</button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
