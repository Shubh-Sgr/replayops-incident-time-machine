import { AnimatePresence, motion } from "framer-motion";
import { Bot, CornerDownLeft, ExternalLink, LoaderCircle, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { AssistantResponse } from "../types";

interface Message {
  role: "user" | "assistant";
  content: string;
  result?: AssistantResponse;
}

export function AssistantDrawer({ open, incidentId, onClose }: { open: boolean; incidentId?: string; onClose(): void }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 220);
  }, [open]);

  async function submit() {
    const value = question.trim();
    if (value.length < 4 || loading) return;
    setMessages((current) => [...current, { role: "user", content: value }]);
    setQuestion("");
    setLoading(true);
    setError("");
    try {
      const result = await api.ask(value, incidentId);
      setMessages((current) => [...current, { role: "assistant", content: result.answer, result }]);
    } catch (assistantError) {
      setError(assistantError instanceof Error ? assistantError.message : "The assistant could not respond.");
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.button className="fixed inset-0 z-40 cursor-default bg-ink/18" aria-label="Close assistant" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.aside
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-panel shadow-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="assistant-title"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 34, mass: 0.9 }}
          >
            <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-control bg-accent/14 text-accent"><Sparkles className="h-5 w-5" /></span>
                <div>
                  <h2 id="assistant-title" className="font-heading text-lg font-semibold">Evidence assistant</h2>
                  <p className="text-xs text-muted">Grounded in incident records</p>
                </div>
              </div>
              <button className="control-quiet !px-3" onClick={onClose} aria-label="Close assistant"><X className="h-4 w-4" /></button>
            </header>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-6">
              {!messages.length && (
                <div className="surface-lined p-5">
                  <Bot className="h-6 w-6 text-accent" />
                  <p className="mt-4 font-semibold">Ask for a defensible hypothesis</p>
                  <p className="mt-2 text-sm leading-6 text-muted">The assistant searches recorded incidents, separates observation from inference, and links every answer to visible evidence. It cannot prove root cause.</p>
                  <div className="mt-4 flex items-start gap-2 text-xs text-muted"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Consequential actions always require operator confirmation.</div>
                </div>
              )}

              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={message.role === "user" ? "ml-8 rounded-panel bg-elevated p-4" : "mr-3"}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{message.role === "user" ? "You" : "ReplayOps"}</p>
                  <p className="whitespace-pre-wrap text-sm leading-7 text-ink">{message.content}</p>
                  {message.result && (
                    <div className="mt-4 border-t border-line pt-3">
                      <div className="flex items-center justify-between text-xs text-muted">
                        <span>{message.result.mode === "deterministic" ? "Deterministic fallback" : "Provider-assisted analysis"}</span>
                        <span className="measurement-number">Confidence {Math.round(message.result.confidence * 100)}%</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted">Evidence boundary: {message.result.evidenceBoundary}{message.result.redactions ? ` · ${message.result.redactions} sensitive value${message.result.redactions === 1 ? "" : "s"} redacted before analysis` : " · no sensitive values detected"}.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {message.result.citations.map((citation) => (
                          <Link key={citation.incidentId} to={`/incidents/${citation.incidentId}`} onClick={onClose} title={citation.excerpt} className="inline-flex items-center gap-1.5 rounded-full bg-info/11 px-2.5 py-1 text-xs font-semibold text-info hover:bg-info/18">
                            {citation.code} · {citation.eventIds.length} events<ExternalLink className="h-3 w-3" />
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {loading && <div className="flex items-center gap-2 text-sm text-muted"><LoaderCircle className="h-4 w-4 animate-spin" /> Correlating evidence…</div>}
              {error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger">{error} Your question is preserved above; retry when the service is available.</p>}
            </div>

            <form className="border-t border-line bg-rail p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <label htmlFor="assistant-question" className="sr-only">Question for evidence assistant</label>
              <div className="relative">
                <textarea
                  id="assistant-question"
                  ref={inputRef}
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
                  }}
                  rows={3}
                  className="field min-h-24 resize-none pb-11 pr-12"
                  placeholder="What evidence points to the initiating event?"
                />
                <button type="submit" disabled={question.trim().length < 4 || loading} className="absolute bottom-2.5 right-2.5 flex h-9 w-9 items-center justify-center rounded-control bg-accent text-accent-ink transition-colors hover:bg-accent/90 disabled:opacity-40" aria-label="Send question">
                  <CornerDownLeft className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">Enter to send · Shift + Enter for a new line</p>
            </form>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
