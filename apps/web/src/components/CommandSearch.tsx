import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Command, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { SearchResult } from "../types";
import { SeverityMark } from "./StatusMark";

export function CommandSearch({ open, onClose }: { open: boolean; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 40);
    else { setQuery(""); setSubmitted(""); setResults([]); setError(""); }
  }, [open]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [onClose, open]);

  async function search() {
    if (query.trim().length < 2) return;
    setLoading(true);
    setSubmitted(query.trim());
    setError("");
    try {
      setResults(await api.search(query.trim()));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 bg-ink/24 p-3 pt-[8vh] backdrop-blur-[2px] sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="search-title"
            className="mx-auto max-w-3xl overflow-hidden rounded-panel bg-panel shadow-drawer"
            initial={{ opacity: 0, y: -16, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.99 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="search-title" className="sr-only">Search incident evidence</h2>
            <form className="flex items-center gap-3 border-b border-line p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); void search(); }}>
              <Search aria-hidden="true" className="h-5 w-5 shrink-0 text-muted" />
              <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-faint" placeholder="Search failure patterns, services, or symptoms" aria-label="Semantic incident search" />
              {loading ? <LoaderCircle className="h-5 w-5 animate-spin text-muted" /> : <button type="submit" className="control-primary !min-h-9 !px-3" disabled={query.trim().length < 2}>Search</button>}
              <button type="button" className="control-quiet !min-h-9 !px-2.5" onClick={onClose} aria-label="Close search"><X className="h-4 w-4" /></button>
            </form>

            <div className="max-h-[62vh] overflow-y-auto p-3 sm:p-4">
              {!submitted && !results.length && (
                <div className="py-10 text-center">
                  <Command className="mx-auto h-7 w-7 text-faint" />
                  <p className="mt-3 text-sm font-semibold">Search the evidence, not just titles</p>
                  <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted">Search a symptom, service, incident code, trace ID, source event ID, or exact evidence ID. Semantic search uses vectors only when a provider is configured.</p>
                </div>
              )}
              {error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger">{error} Try again or use a shorter query.</p>}
              {!loading && submitted && !error && results.length === 0 && (
                <div className="py-10 text-center">
                  <p className="font-semibold">No matching evidence</p>
                  <p className="mt-1 text-sm text-muted">Nothing matched “{submitted}”. Try a service, symptom, incident code, or exact trace ID.</p>
                </div>
              )}
              <div className="divide-y divide-line">
                {results.map((result) => (
                  <button
                    key={result.incident.id}
                    className="group flex w-full items-start gap-4 px-2 py-4 text-left transition-colors hover:bg-elevated"
                    onClick={() => { navigate(`/incidents/${result.incident.id}?area=investigate${result.matchedEventId ? `&event=${result.matchedEventId}` : ""}${result.matchedEventId ? `#event-${result.matchedEventId}` : ""}`); onClose(); }}
                  >
                    <span className="measurement-number mt-0.5 text-xs text-muted">{result.incident.code}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ink">{result.incident.title}</span>
                        <SeverityMark value={result.incident.severity} />
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-muted">{result.matchReason}</span>
                    </span>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-1 group-hover:text-ink" />
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
