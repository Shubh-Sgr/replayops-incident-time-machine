import { useQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, Rocket, ToggleRight, Undo2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { cn, formatRelative } from "../lib/utils";
import type { ChangeRecord } from "../types";

const label = (change: ChangeRecord) => change.version ?? change.sha?.slice(0, 7) ?? "—";
const kindIcon = (change: ChangeRecord) => change.kind === "feature_flag" || change.kind === "config" ? ToggleRight : change.kind === "rollback" ? Undo2 : Rocket;

/** What is running where, and everything that changed recently: the first place to look when something breaks. */
export function ReleasesPage() {
  const releases = useQuery({ queryKey: ["releases"], queryFn: api.releases, refetchInterval: 30_000 });
  const data = releases.data;
  return <div className="space-y-6">
    <header><h1 className="font-heading text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Releases</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted">What each service is running in every environment, and every deploy, rollback, flag and config change ReplayOps has recorded. Incidents link to these automatically.</p></header>
    {releases.error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger">{releases.error.message}</p>}
    {data && !data.recent.length && <section className="surface-lined p-6 text-sm leading-6 text-muted"><Rocket className="mb-3 h-6 w-6 text-accent" /><p className="font-semibold text-ink">No releases recorded yet.</p><p className="mt-1">Turn on <strong>Deployments</strong> and <strong>Deployment statuses</strong> in your GitHub webhook (Vercel and GitHub Actions deployments report there), or add one curl to your deploy script from <Link className="underline" to="/integrations">Sources → Generic webhook</Link>. Map repositories to services in <Link className="underline" to="/workspace">Settings → Service map</Link>.</p></section>}
    {data && data.services.length > 0 && <section className="surface-lined overflow-x-auto" aria-labelledby="running-title">
      <div className="px-5 py-4 sm:px-6"><h2 id="running-title" className="section-title">Running now</h2></div>
      <table className="w-full min-w-[560px] border-t border-line text-sm"><thead><tr className="text-left text-xs text-muted"><th className="px-5 py-2 font-semibold sm:px-6">Service</th>{data.environments.map((environment) => <th key={environment} className="px-3 py-2 font-semibold capitalize">{environment}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{data.services.map((row) => <tr key={row.service}><td className="measurement-number px-5 py-3 font-semibold sm:px-6">{row.service}</td>{data.environments.map((environment) => { const change = row.releases[environment]; return <td key={environment} className="px-3 py-3 align-top">{change ? <div><p className="measurement-number font-semibold">{label(change)}</p><p className="text-xs text-muted">{formatRelative(change.occurredAt)}{change.author ? ` · ${change.author}` : ""}</p>{change.kind === "rollback" && <p className="text-xs font-semibold text-warning">rolled back</p>}</div> : <span className="text-xs text-faint">—</span>}</td>; })}</tr>)}</tbody></table>
    </section>}
    {data && data.recent.length > 0 && <section className="surface-lined overflow-hidden" aria-labelledby="recent-title">
      <div className="px-5 py-4 sm:px-6"><h2 id="recent-title" className="section-title">Recent changes</h2></div>
      <ul className="divide-y divide-line border-t border-line">{data.recent.map((change) => { const Icon = kindIcon(change); return <li key={change.id} className="px-5 py-3 sm:px-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <p className="flex min-w-0 items-start gap-2 text-sm font-semibold"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span className={cn("break-words", change.status === "failure" && "text-danger")}>{change.title}</span></p>
          <p className="shrink-0 text-xs text-muted">{formatRelative(change.occurredAt)}{change.author ? ` · ${change.author}` : ""}</p>
        </div>
        {change.commits.length > 0 && <p className="ml-6 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"><GitCommitHorizontal className="h-3.5 w-3.5" />{change.commits.slice(0, 3).map((commit) => <span key={commit.sha}><span className="measurement-number">{commit.sha.slice(0, 7)}</span> {commit.message}</span>)}{change.commits.length > 3 ? <span>+{change.commits.length - 3} more</span> : null}</p>}
      </li>; })}</ul>
    </section>}
  </div>;
}
