import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { RecoveryEvaluation } from "../types";

export type LifecycleAction = "start_monitoring" | "resolve" | "reopen";

const copy: Record<LifecycleAction, { title: string; prompt: string; placeholder: string; submit: string }> = {
  start_monitoring: { title: "Mark as fixed", prompt: "What did you do to fix it?", placeholder: "Rolled back to v2.3.1", submit: "Mark fixed" },
  resolve: { title: "Resolve incident", prompt: "How do you know it's fixed?", placeholder: "Error rate back to normal for 30 minutes in Grafana", submit: "Resolve" },
  reopen: { title: "Reopen incident", prompt: "What happened?", placeholder: "Errors came back after the fix", submit: "Reopen" }
};

/**
 * One small dialog for every status change. Resolving is one click when the source already confirmed recovery;
 * otherwise the responder confirms it themselves and says how, which goes into the audit trail.
 */
export function LifecycleDialog({ action, recovery, saving, error, onClose, onSubmit }: {
  action: LifecycleAction | null;
  recovery?: RecoveryEvaluation;
  saving: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: { reason: string; confirmed?: boolean }): void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (action) setReason(""); }, [action]);
  const sourceConfirmed = action === "resolve" && recovery?.state === "verified";
  const text = action ? copy[action] : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    const note = reason.trim();
    onSubmit(sourceConfirmed
      ? { reason: note.length >= 8 ? note : `Recovery confirmed by the source: ${recovery?.reason ?? "verified"}`.slice(0, 2000) }
      : { reason: note, ...(action === "resolve" ? { confirmed: true } : {}) });
  }

  return createPortal(<AnimatePresence>{action && text && <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
    <motion.form role="dialog" aria-modal="true" aria-labelledby="lifecycle-title" className="w-full max-w-md rounded-t-panel bg-panel p-5 shadow-drawer sm:rounded-panel sm:p-6" initial={{ y: 20, opacity: .6 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
      <div className="flex items-start justify-between gap-4"><h2 id="lifecycle-title" className="font-heading text-xl font-semibold">{text.title}</h2><button type="button" className="control-quiet !px-3" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button></div>
      {sourceConfirmed && <p className="mt-4 flex gap-2 rounded-control bg-success/10 p-3 text-sm text-success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{recovery?.reason}</p>}
      {action === "resolve" && !sourceConfirmed && recovery && <p className="mt-4 rounded-control bg-elevated p-3 text-sm text-muted">{recovery.state === "failed" ? `${recovery.reason} ` : "Your sources haven't confirmed recovery yet. "}You can still resolve it if you've checked yourself.</p>}
      <label className="mt-4 block text-sm font-semibold">{text.prompt}{sourceConfirmed && <span className="font-normal text-muted"> (optional)</span>}
        <textarea className="field mt-2 min-h-24 resize-y py-3" value={reason} onChange={(event) => setReason(event.target.value)} minLength={sourceConfirmed ? undefined : 8} maxLength={2000} required={!sourceConfirmed} autoFocus placeholder={text.placeholder} />
      </label>
      {error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" className="control-secondary" onClick={onClose}>Cancel</button><button type="submit" className="control-primary min-w-32" disabled={saving}>{saving ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />Saving</span> : text.submit}</button></div>
    </motion.form>
  </motion.div>}</AnimatePresence>, document.body);
}
