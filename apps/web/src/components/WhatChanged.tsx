import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitCommitHorizontal, History, Rocket, ToggleRight, Undo2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { cn, formatRelative } from "../lib/utils";
import type { CommitSummary, Incident, IncidentEvent } from "../types";

const kindLabel: Record<string, string> = { deploy: "Deploy", rollback: "Rollback", feature_flag: "Feature flag", config: "Config", migration: "Migration", infra: "Infrastructure" };
const span = (from: string, to: string) => {
  const minutes = Math.max(1, Math.round(Math.abs(Date.parse(to) - Date.parse(from)) / 60_000));
  return minutes < 90 ? `${minutes} min` : minutes < 2_880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1_440)} days`;
};
const text = (value: unknown) => typeof value === "string" && value ? value : undefined;

function compareUrl(event: IncidentEvent) {
  const meta = event.metadata ?? {};
  const repository = text(meta.repository), sha = text(meta.sha), previous = text(meta.previousSha);
  if (meta.provider !== "github" || !repository || !sha) return text(meta.sourceUrl);
  return previous ? `https://github.com/${repository}/compare/${previous}...${sha}` : `https://github.com/${repository}/commit/${sha}`;
}

/**
 * What changed in this environment before (and during) the incident: the release that was running, plus
 * recent deploys, flags and config. Each change shows its commits and why ReplayOps does or doesn't suspect it.
 */
export function WhatChanged({ incident }: { incident: Incident }) {
  const client = useQueryClient();
  const diagnosis = useQuery({ queryKey: ["diagnosis", incident.id, incident.evidenceRevision, incident.status], queryFn: () => api.diagnosis(incident.id) });
  const setState = useMutation({
    mutationFn: ({ event, excluded }: { event: IncidentEvent; excluded: boolean }) => api.updateEvent(incident.id, event.id, excluded ? { evidenceState: "excluded", correctionReason: "Ruled out from What changed: not related to this incident." } : { evidenceState: "active", correctionReason: null }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["incident", incident.id] }); void client.invalidateQueries({ queryKey: ["diagnosis", incident.id] }); }
  });
  const changes = incident.events.filter((event) => event.metadata?.changeId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const before = changes.filter((event) => !event.metadata?.afterIncidentStart);
  const during = changes.filter((event) => event.metadata?.afterIncidentStart);
  const candidate = (event: IncidentEvent) => diagnosis.data?.changeCandidates.find((item) => item.eventId === event.id);
  const ranked = [...before].sort((a, b) => (candidate(b)?.score ?? 0) - (candidate(a)?.score ?? 0));

  const card = (event: IncidentEvent, response: boolean) => {
    const meta = event.metadata ?? {};
    const commits = (meta.commits as CommitSummary[] | undefined) ?? [];
    const scored = candidate(event);
    const excluded = event.evidenceState === "excluded";
    const link = compareUrl(event);
    const version = text(meta.version) ?? (text(meta.sha)?.slice(0, 7));
    const previous = text(meta.previousVersion) ?? (text(meta.previousSha)?.slice(0, 7));
    const Icon = meta.changeType === "feature_flag" || meta.changeType === "config" ? ToggleRight : meta.changeType === "rollback" ? Undo2 : Rocket;
    return <li key={event.id} className={cn("px-5 py-4 sm:px-6", excluded && "opacity-60")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold"><Icon className="h-4 w-4 shrink-0 text-accent" /><span className={cn("break-words", excluded && "line-through")}>{event.title}</span>
            <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-muted">{kindLabel[String(meta.changeType)] ?? "Change"}</span>
            {meta.liveRelease === true && <span className="rounded-full bg-info/12 px-2 py-0.5 text-xs font-semibold text-info">Live when it started</span>}
            {meta.touchesService === false && <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">Didn't touch {incident.service}</span>}
            {meta.touchesService === true && <span className="rounded-full bg-warning/12 px-2 py-0.5 text-xs font-semibold text-warning">Changed {incident.service}</span>}
            {excluded && <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold text-muted">Ruled out</span>}
          </p>
          <p className="mt-1 text-xs text-muted">{response ? `${span(incident.startedAt, event.timestamp)} after the incident started` : `${span(event.timestamp, incident.startedAt)} before the incident started`} · {formatRelative(event.timestamp)}{text(meta.author) ? ` · by ${text(meta.author)}` : ""}{version ? ` · ${version}` : ""}{previous ? ` (was ${previous})` : ""}</p>
          {meta.changeType === "feature_flag" || meta.changeType === "config" ? <p className="measurement-number mt-1 text-xs text-muted">{text(meta.flagKey) ?? "setting"}: {String(meta.previousValue ?? "?")} → {String(meta.newValue ?? "?")}</p> : null}
          {scored && !response && <p className="mt-2 text-sm leading-6"><span className={cn("measurement-number mr-2 font-semibold", scored.score >= 70 ? "text-danger" : scored.score >= 50 ? "text-warning" : "text-muted")}>{scored.score}/100</span><span className="text-muted">{scored.reason}</span></p>}
          {response && <p className="mt-2 text-sm text-muted">A change made during the incident, usually the fix or rollback. It is not considered a cause.</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {link && <a className="control-quiet inline-flex !min-h-9 items-center gap-1.5" href={link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />{meta.provider === "github" && text(meta.previousSha) ? "Diff" : "Open"}</a>}
          {!response && <button type="button" className="control-quiet !min-h-9" disabled={setState.isPending} onClick={() => setState.mutate({ event, excluded: !excluded })}>{excluded ? "Restore" : "Rule out"}</button>}
        </div>
      </div>
      {commits.length > 0 && <details className="mt-2 text-xs"><summary className="cursor-pointer font-semibold text-muted">{commits.length} commit{commits.length === 1 ? "" : "s"}{(meta.files as string[] | undefined)?.length ? ` · ${(meta.files as string[]).length} files` : ""}</summary>
        <ul className="mt-2 space-y-1.5">{commits.slice(0, 15).map((commit) => <li key={commit.sha} className="flex gap-2"><GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" /><span className="min-w-0"><a className="measurement-number font-semibold hover:underline" href={commit.url ?? (text(meta.repository) ? `https://github.com/${text(meta.repository)}/commit/${commit.sha}` : undefined)} target="_blank" rel="noreferrer">{commit.sha.slice(0, 7)}</a> <span className="break-words">{commit.message}</span>{commit.author ? <span className="text-muted"> · {commit.author}</span> : null}{commit.files.length ? <span className="block break-all text-muted">{commit.files.slice(0, 4).join(", ")}{commit.files.length > 4 ? ` +${commit.files.length - 4}` : ""}</span> : null}</span></li>)}</ul>
        {meta.commitRangeComplete === false && <p className="mt-2 text-muted">Earlier commits in this release weren't seen by ReplayOps (the GitHub webhook was added later), so the list may be incomplete.</p>}
      </details>}
    </li>;
  };

  return <section className="surface-lined overflow-hidden" aria-labelledby="what-changed-title">
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
      <div><h2 id="what-changed-title" className="section-title flex items-center gap-2"><History className="h-5 w-5 text-accent" />What changed</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{incident.environment && incident.environment !== "unknown" ? `Changes to ${incident.service} and its dependencies in ${incident.environment}: the release that was running when this started, and anything changed in the day before.` : "Set the incident's environment to see what changed there."} Ranked by evidence, not just time.</p></div>
      <Link to="/releases" className="control-quiet !min-h-9">All releases</Link>
    </div>
    {ranked.length || during.length ? <ul className="divide-y divide-line border-t border-line">{ranked.map((event) => card(event, false))}{during.map((event) => card(event, true))}</ul>
      : <p className="border-t border-line px-6 py-5 text-sm leading-6 text-muted">No deploys, flags or config changes were recorded for {incident.service}{incident.environment && incident.environment !== "unknown" ? ` in ${incident.environment}` : ""}. If nothing changed, the cause is more likely a dependency, traffic, or data. To record changes, enable GitHub deployment events, or send one curl from your deploy script (Sources → Generic).</p>}
  </section>;
}
