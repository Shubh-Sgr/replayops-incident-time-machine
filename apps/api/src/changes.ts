import { branchMatches, changeTouchesService, resolveEnvironment, servicesForChange, type EnvironmentConfig, type ServiceMapping } from "./release.js";

/**
 * The change log. Deploys, rollbacks, feature flags, config edits, migrations and infrastructure changes
 * are recorded per service and environment, and linked to an incident by relevance (what is live, what
 * touched the failing service) rather than by being close in time. Pure functions; storage lives in the
 * repositories.
 */
export type ChangeKind = "deploy" | "rollback" | "feature_flag" | "config" | "migration" | "infra";
export type ChangeStatus = "success" | "failure" | "in_progress";
export interface CommitRecord { repository: string; sha: string; branch?: string; message: string; author?: string; url?: string; files: string[]; committedAt?: string; pushBefore?: string; pushAfter?: string; position: number }
export interface CommitSummary { sha: string; message: string; author?: string; url?: string; files: string[] }
export interface ChangeInput {
  kind: ChangeKind; status: ChangeStatus; service?: string; environment?: string; title?: string;
  version?: string; previousVersion?: string; sha?: string; previousSha?: string; repository?: string; author?: string; url?: string;
  occurredAt: string; source: string; externalId: string; metadata: Record<string, unknown>;
}
export interface ChangeRecord extends Omit<ChangeInput, "service" | "environment" | "title"> {
  id: string; service: string; environment: string; title: string; commits: CommitSummary[]; files: string[];
}
export interface ExtractedDelivery { commits: CommitRecord[]; changes: ChangeInput[] }

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;
const time = (value: unknown, fallback: string) => { const parsed = Date.parse(String(value ?? "")); return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString(); };
const ZERO = /^0+$/;

const changeKinds: Record<string, ChangeKind> = {
  deploy: "deploy", deployment: "deploy", release: "deploy", rollback: "rollback", revert: "rollback",
  feature_flag: "feature_flag", flag: "feature_flag", "feature-flag": "feature_flag", config: "config", configuration: "config",
  migration: "migration", schema: "migration", infra: "infra", infrastructure: "infra", terraform: "infra"
};
export const changeKindOf = (value: unknown): ChangeKind | undefined => changeKinds[String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_")];

/** Pulls commits and changes out of a delivery. GitHub pushes become commits; deployments, and generic change events, become changes. */
export function extractDelivery(provider: string, payload: Json, eventName: string, deliveryId: string, receivedAt = new Date().toISOString()): ExtractedDelivery {
  if (provider === "github") {
    const repository = text(object(payload.repository).full_name)?.toLowerCase();
    if (!repository) return { commits: [], changes: [] };
    if (eventName === "push") {
      const ref = text(payload.ref) ?? "";
      if (!ref.startsWith("refs/heads/")) return { commits: [], changes: [] };
      const branch = ref.slice("refs/heads/".length);
      const commits = array(payload.commits).map(object).map((commit, position): CommitRecord => ({
        repository, sha: text(commit.id) ?? "", branch, message: (text(commit.message) ?? "").split("\n")[0]!.slice(0, 300),
        author: text(object(commit.author).username) ?? text(object(commit.author).name), url: text(commit.url),
        files: [...new Set([...array(commit.added), ...array(commit.modified), ...array(commit.removed)].map(String))].slice(0, 300),
        committedAt: time(commit.timestamp, receivedAt), pushBefore: text(payload.before), pushAfter: text(payload.after), position
      })).filter((commit) => commit.sha);
      return { commits, changes: [] };
    }
    if (eventName === "deployment_status") {
      const deployment = object(payload.deployment);
      const status = object(payload.deployment_status);
      const state = (text(status.state) ?? "").toLowerCase();
      const changeStatus: ChangeStatus | undefined = state === "success" ? "success" : ["failure", "error"].includes(state) ? "failure" : undefined;
      if (!changeStatus) return { commits: [], changes: [] };
      const sha = text(deployment.sha);
      return { commits: [], changes: [{
        kind: "deploy", status: changeStatus, environment: text(deployment.environment) ?? text(status.environment), sha, repository,
        author: text(object(deployment.creator).login) ?? text(object(payload.sender).login), url: text(status.log_url) ?? text(status.target_url) ?? text(status.environment_url),
        version: text(object(deployment.payload).version), occurredAt: time(status.created_at, receivedAt), source: "github",
        externalId: `github:deployment:${text(deployment.id) ?? deliveryId}:${state}`, metadata: { ref: text(deployment.ref), deploymentId: deployment.id }
      }] };
    }
    return { commits: [], changes: [] };
  }
  if (provider !== "generic") return { commits: [], changes: [] };
  const source = Array.isArray(payload.events) ? payload.events.map(object) : [payload];
  const changes = source.flatMap((input, index): ChangeInput[] => {
    const rawKind = text(input.kind)?.toLowerCase();
    const kind = changeKindOf(input.changeType ?? input.change_type) ?? (rawKind === "change" ? "deploy" : changeKindOf(rawKind));
    if (!kind || (rawKind && rawKind !== "change" && !changeKindOf(rawKind))) return [];
    const status = (text(input.status)?.toLowerCase() ?? "success");
    return [{
      kind, status: status === "failure" || status === "failed" ? "failure" : status === "in_progress" || status === "started" ? "in_progress" : "success",
      service: text(input.service), environment: text(input.environment), title: text(input.title),
      version: text(input.version ?? input.release), previousVersion: text(input.previousVersion ?? input.previous_version),
      sha: text(input.sha ?? input.commit), previousSha: text(input.previousSha ?? input.previous_sha), repository: text(input.repository)?.toLowerCase(),
      author: text(input.author ?? input.actor ?? input.user), url: text(input.url ?? input.sourceUrl),
      occurredAt: time(input.timestamp ?? input.occurredAt, receivedAt), source: "generic",
      externalId: `generic:${text(input.eventId ?? input.event_id ?? input.id) ?? `${deliveryId}:${index}`}`,
      metadata: { flagKey: text(input.flag ?? input.flagKey ?? input.key ?? input.setting), previousValue: input.previousValue ?? input.from, newValue: input.newValue ?? input.to ?? input.value, branch: text(input.branch) }
    }];
  });
  return { commits: [], changes };
}

/** True when a generic payload is only change events, so it should not also become incident signals. */
export const isChangeEvent = (input: Json) => {
  const rawKind = text(input.kind)?.toLowerCase();
  return Boolean(changeKindOf(input.changeType ?? input.change_type) ?? (rawKind === "change" ? "deploy" : changeKindOf(rawKind))) && (!rawKind || rawKind === "change" || Boolean(changeKindOf(rawKind)));
};

/**
 * Commits between two deployed SHAs, from the pushes ReplayOps has seen. Walks push → previous push via
 * `before`, so a deploy of v1.4.2 lists exactly the commits since v1.4.1 even if they were pushed days apart.
 */
export function commitRange(commits: CommitRecord[], sha: string | undefined, previousSha: string | undefined, maxPushes = 50) {
  if (!sha) return { commits: [] as CommitSummary[], complete: false };
  const byPush = new Map<string, CommitRecord[]>();
  for (const commit of commits) if (commit.pushAfter) byPush.set(commit.pushAfter, [...(byPush.get(commit.pushAfter) ?? []), commit]);
  const matches = (full: string | undefined, short: string | undefined) => Boolean(full && short && (full === short || full.startsWith(short) || short.startsWith(full)));
  const result: CommitRecord[] = [];
  let cursor: string | undefined = sha;
  let complete = false;
  for (let step = 0; cursor && step < maxPushes; step += 1) {
    if (matches(cursor, previousSha)) { complete = true; break; }
    const pushKey: string | undefined = [...byPush.keys()].find((key) => matches(key, cursor)) ?? commits.find((commit) => matches(commit.sha, cursor))?.pushAfter;
    const push: CommitRecord[] = pushKey ? [...(byPush.get(pushKey) ?? [])].sort((a, b) => a.position - b.position) : [];
    if (!push.length) break;
    // A deploy of a commit in the middle of a push includes only the commits up to it.
    const upTo = push.findIndex((commit) => matches(commit.sha, cursor));
    const included = upTo >= 0 ? push.slice(0, upTo + 1) : push;
    const stopAt = previousSha ? included.findIndex((commit) => matches(commit.sha, previousSha)) : -1;
    result.push(...(stopAt >= 0 ? included.slice(stopAt + 1) : included).reverse());
    if (stopAt >= 0) { complete = true; break; }
    const before: string | undefined = push[0]!.pushBefore;
    cursor = before && !ZERO.test(before) ? before : undefined;
    if (!cursor) complete = !previousSha;
  }
  const unique = [...new Map(result.map((commit) => [commit.sha, commit])).values()];
  return { commits: unique.slice(0, 100).map(({ sha: id, message, author, url, files }) => ({ sha: id, message, author, url, files })), complete };
}

export interface ResolveChangeContext { environments: EnvironmentConfig[]; services: ServiceMapping[]; releaseBranches: string[]; repositoryCommits: CommitRecord[]; previousDeploy?: { sha?: string; version?: string } }

const kindTitle: Record<ChangeKind, string> = { deploy: "Deployed", rollback: "Rolled back", feature_flag: "Feature flag", config: "Config change", migration: "Migration", infra: "Infrastructure change" };

/** Completes a change: canonical environment, commit range, affected services (one record per service in a monorepo), and a readable title. */
export function resolveChange(input: ChangeInput, context: ResolveChangeContext): Array<Omit<ChangeRecord, "id">> {
  const environment = resolveEnvironment(input.environment, context.environments).name;
  // Only code releases replace a previous release; a flag or config change has its own before/after values.
  const release = input.kind === "deploy" || input.kind === "rollback";
  const previousSha = input.previousSha ?? (release ? context.previousDeploy?.sha : undefined);
  const previousVersion = input.previousVersion ?? (release ? context.previousDeploy?.version : undefined);
  const range = input.repository ? commitRange(context.repositoryCommits, input.sha, previousSha) : { commits: [], complete: false };
  const files = [...new Set(range.commits.flatMap((commit) => commit.files))];
  const affected = input.service ? [input.service] : servicesForChange(input.repository, files, context.services);
  const services = affected.length ? affected : [input.repository ?? "unknown-service"];
  return services.map((service) => {
    const label = input.version ?? (input.sha ? input.sha.slice(0, 7) : undefined);
    const flag = typeof input.metadata.flagKey === "string" ? input.metadata.flagKey : undefined;
    const title = input.title
      ?? (input.kind === "feature_flag" || input.kind === "config" ? `${kindTitle[input.kind]} ${flag ?? ""}${input.metadata.newValue !== undefined ? ` set to ${String(input.metadata.newValue)}` : ""} on ${service}`.replace(/\s+/g, " ")
        : `${kindTitle[input.kind]} ${service}${label ? ` ${label}` : ""} to ${environment}${input.status === "failure" ? " (failed)" : ""}`);
    return {
      ...input, service, environment, title, previousSha, previousVersion, commits: range.commits, files,
      externalId: services.length > 1 ? `${input.externalId}:${service}` : input.externalId,
      metadata: { ...input.metadata, commitRangeComplete: range.complete }
    };
  });
}

export interface IncidentScope { service: string; relatedServices: string[]; environment: string; startedAt: string }

/**
 * Which changes belong in an incident's "what changed": the release that was live in that environment
 * when it started (however old), plus every change to the affected services in the day before. Changes
 * from another environment, or after the incident began, are never suspects.
 */
export function selectChangesForIncident(changes: ChangeRecord[], scope: IncidentScope, lookbackHours = 24) {
  if (!scope.environment || scope.environment === "unknown") return [];
  const start = Date.parse(scope.startedAt);
  const relevant = changes.filter((change) => change.environment === scope.environment && scope.relatedServices.includes(change.service) && Date.parse(change.occurredAt) <= start && change.status !== "failure");
  const live = new Map<string, ChangeRecord>();
  for (const change of [...relevant].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) if (change.kind === "deploy" || change.kind === "rollback") live.set(change.service, change);
  const recent = relevant.filter((change) => start - Date.parse(change.occurredAt) <= lookbackHours * 3_600_000);
  return [...new Map([...live.values(), ...recent].map((change) => [change.id, change])).values()]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 12)
    .map((change) => ({ change, liveRelease: live.get(change.service)?.id === change.id }));
}

/** The incident-evidence form of a linked change, carrying everything the diagnosis needs to judge it. */
export function changeEvidence(change: ChangeRecord, context: { liveRelease: boolean; incidentService: string; services: ServiceMapping[]; afterStart?: boolean }) {
  const touches = changeTouchesService(context.incidentService, change.files, context.services);
  const commitNote = change.commits.length ? `${change.commits.length} commit${change.commits.length === 1 ? "" : "s"}${change.commits[0]?.author ? ` by ${[...new Set(change.commits.map((commit) => commit.author).filter(Boolean))].slice(0, 3).join(", ")}` : ""}: ${change.commits.slice(0, 3).map((commit) => commit.message).join("; ")}${change.commits.length > 3 ? "; …" : ""}.` : "";
  const detail = [
    context.liveRelease ? "This release was running when the incident started." : undefined,
    commitNote || undefined,
    touches === false ? `None of its changed files are in ${context.incidentService}'s paths.` : touches ? `It changed files in ${context.incidentService}.` : undefined,
    change.previousVersion || change.previousSha ? `Previous: ${change.previousVersion ?? change.previousSha!.slice(0, 7)}.` : undefined
  ].filter(Boolean).join(" ") || `${change.title}.`;
  return {
    timestamp: change.occurredAt, service: change.service, kind: "deploy" as const, title: change.title, detail: detail.slice(0, 1200), impactScore: 40,
    metadata: {
      provider: change.source, changeId: change.id, changeType: change.kind === "rollback" ? "rollback" : change.kind, changeStatus: change.status,
      version: change.version, previousVersion: change.previousVersion, sha: change.sha, previousSha: change.previousSha, repository: change.repository,
      author: change.author, sourceUrl: change.url, environment: change.environment, liveRelease: context.liveRelease, touchesService: touches,
      commits: change.commits.slice(0, 20), files: change.files.slice(0, 60), flagKey: change.metadata.flagKey, previousValue: change.metadata.previousValue, newValue: change.metadata.newValue,
      afterIncidentStart: Boolean(context.afterStart)
    }
  };
}

export const shouldKeepPushSignal = (branch: string | undefined, releaseBranches: string[]) => branchMatches(branch, releaseBranches);
