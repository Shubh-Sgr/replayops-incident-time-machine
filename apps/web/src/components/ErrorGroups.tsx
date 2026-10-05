import { useQuery } from "@tanstack/react-query";
import { Bug, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { cn, formatRelative } from "../lib/utils";
import type { Incident } from "../types";

/** Exceptions in this incident, grouped by fingerprint. Errors that are new since a change are listed first. */
export function ErrorGroups({ incident, onSelectEvent }: { incident: Incident; onSelectEvent(eventId: string): void }) {
  const groups = useQuery({ queryKey: ["incident-errors", incident.id, incident.evidenceRevision], queryFn: () => api.incidentErrors(incident.id) });
  if (!groups.data?.length) return null;
  const fresh = groups.data.filter((group) => group.newSince).length;
  return <section className="surface-lined overflow-hidden" aria-labelledby="error-groups-title">
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
      <div><h2 id="error-groups-title" className="section-title flex items-center gap-2"><Bug className="h-5 w-5 text-danger" />Errors in this incident</h2>
        <p className="mt-1 text-sm text-muted">{groups.data.length} distinct error{groups.data.length === 1 ? "" : "s"}, grouped by type and code location.{fresh ? ` ${fresh} never happened before a recent change. Start there.` : " None are new since a change."}</p></div>
    </div>
    <ul className="divide-y divide-line border-t border-line">{groups.data.map((group) => <li key={group.fingerprint} className="px-5 py-4 sm:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <button type="button" className="min-w-0 text-left" onClick={() => onSelectEvent(group.sampleEventId)}>
          <p className="flex flex-wrap items-center gap-2 font-semibold"><span className="break-all">{group.type}</span>
            {group.newSince ? <span className="inline-flex items-center gap-1 rounded-full bg-danger/12 px-2 py-0.5 text-xs font-semibold text-danger"><Sparkles className="h-3 w-3" />New after “{group.newSince.title}”</span>
              : <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-muted">Seen since {formatRelative(group.firstSeenInWorkspace)}</span>}
          </p>
          {group.message && <p className="mt-1 break-words text-sm text-muted">{group.message}</p>}
          {group.topFrame && <p className="measurement-number mt-1 break-all text-xs text-muted">at {group.topFrame}</p>}
        </button>
        <div className="shrink-0 text-right text-xs text-muted sm:min-w-32"><p className={cn("measurement-number text-lg font-semibold", group.newSince ? "text-danger" : "text-ink")}>{group.count}×</p><p>first {formatRelative(group.firstSeen)}</p><p>last {formatRelative(group.lastSeen)}</p><p className="mt-1 break-words">{group.services.join(", ")}</p></div>
      </div>
      {group.stack && <details className="mt-2 text-xs"><summary className="cursor-pointer font-semibold text-muted">Stack trace</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-control bg-ink p-3 leading-5 text-panel/90">{group.stack}</pre></details>}
    </li>)}</ul>
  </section>;
}
