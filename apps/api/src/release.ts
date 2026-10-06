/**
 * The release model: how a real team's code reaches users. Pure functions only, so every rule here is
 * unit-tested and shared by the in-memory and Postgres repositories.
 *
 *   feature branch → PR (CI) → main → dev/QA → staging → production
 *
 * A commit never breaks production by itself; a deployment of it to an environment can, possibly days
 * later. So environments are first-class (with aliases and tiers), repositories and monorepo paths map to
 * services, and only release branches can open delivery incidents.
 */
export type EnvironmentTier = "production" | "preprod" | "dev";
export interface EnvironmentConfig { name: string; aliases: string[]; tier: EnvironmentTier; opensIncidents: boolean }

export const defaultEnvironments: EnvironmentConfig[] = [
  { name: "production", aliases: ["prod", "prd", "live"], tier: "production", opensIncidents: true },
  { name: "staging", aliases: ["stage", "stg", "preprod", "pre-prod", "uat"], tier: "preprod", opensIncidents: false },
  { name: "qa", aliases: ["test", "testing", "qa-env"], tier: "preprod", opensIncidents: false },
  { name: "development", aliases: ["dev", "develop", "local", "preview", "sandbox"], tier: "dev", opensIncidents: false }
];
export const defaultReleaseBranches = ["main", "master", "release/*", "hotfix/*"];

const key = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-");

export interface ResolvedEnvironment { name: string; tier: EnvironmentTier | "unknown"; opensIncidents: boolean }

/**
 * Maps whatever a tool calls an environment ("Production", "prd", "Preview") to the workspace's name for it.
 * Missing environments stay "unknown" and may open incidents: a CI run on main has no environment but its
 * failure still matters. Unrecognised names are kept as-is and treated as non-production.
 */
export function resolveEnvironment(raw: unknown, environments: EnvironmentConfig[] = defaultEnvironments): ResolvedEnvironment {
  const value = typeof raw === "string" ? key(raw) : "";
  if (!value || value === "unknown") return { name: "unknown", tier: "unknown", opensIncidents: true };
  const match = environments.find((item) => key(item.name) === value || item.aliases.some((alias) => key(alias) === value))
    // "production-eu", "staging-2": a known name followed by a region or index suffix.
    ?? environments.find((item) => [item.name, ...item.aliases].some((name) => value.startsWith(`${key(name)}-`)));
  return match ? { name: match.name, tier: match.tier, opensIncidents: match.opensIncidents } : { name: value, tier: "dev", opensIncidents: false };
}

/** `release/*` matches `release/1.4`; exact names match exactly. */
export function branchMatches(branch: string | undefined, patterns: string[] = defaultReleaseBranches) {
  if (!branch) return false;
  const name = branch.replace(/^refs\/heads\//, "");
  return patterns.some((pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

/** "https://github.com/acme/api(.git)" or "acme/api" → "acme/api". */
export function repositoryName(value: string | null | undefined) {
  if (!value) return undefined;
  const match = /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(value.trim()) ?? /^([\w.-]+\/[\w.-]+)$/.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

export interface ServiceMapping { name: string; repositories: string[]; paths: string[]; repositoryUrl?: string | null }

const pathMatches = (file: string, prefix: string) => {
  const clean = prefix.replace(/^\.?\//, "").replace(/\/\*+$/, "").replace(/\/$/, "");
  return clean === "" || file === clean || file.startsWith(`${clean}/`);
};

/**
 * Repository plumbing: CI workflows, docs, and repo metadata. Changing them ships no service's code, so they
 * never make a whole-repository service "affected" on their own.
 */
const plumbing = /^(\.github\/|\.gitignore$|\.gitattributes$|\.editorconfig$|docs?\/|LICENSE|CODEOWNERS$|[^/]*\.md$)/i;
export const isPlumbingFile = (file: string) => plumbing.test(file);

/**
 * Which services a change in a repository affects. In a monorepo, changed files decide: a service with
 * paths owns the files under them, and a service mapped to the whole repository (no paths) owns only the
 * code no path-specific service claims. Without file information every mapped service is affected.
 */
export function servicesForChange(repository: string | undefined, files: string[], services: ServiceMapping[]) {
  const repo = repositoryName(repository);
  if (!repo) return [];
  const mapped = services.filter((service) => [...service.repositories, service.repositoryUrl ?? ""].map(repositoryName).includes(repo));
  if (!files.length) return mapped.map((service) => service.name);
  const scoped = mapped.filter((service) => service.paths.length);
  const owns = (service: ServiceMapping, file: string) => service.paths.some((path) => pathMatches(file, path));
  const unclaimed = files.filter((file) => !isPlumbingFile(file) && !scoped.some((service) => owns(service, file)));
  const affected = mapped.filter((service) => service.paths.length ? files.some((file) => owns(service, file)) : unclaimed.length > 0);
  // Only plumbing changed (a workflow, the README): it belongs to whoever owns the whole repository.
  return (affected.length ? affected : mapped.filter((service) => !service.paths.length)).map((service) => service.name);
}

/** Whether a change touched code that belongs to a service, when that can be known. */
export function changeTouchesService(service: string, files: string[], services: ServiceMapping[]): boolean | null {
  const mapping = services.find((item) => item.name === service);
  if (!mapping?.paths.length || !files.length) return null;
  return files.some((file) => mapping.paths.some((path) => pathMatches(file, path)));
}

/**
 * The app service a GitHub signal belongs to, so it can meet that service's telemetry: the service the
 * deployment names, or the one its repository maps to. When several services share the repository, the
 * files of the commit it ran on decide; if that is still ambiguous the repository name is kept.
 */
export function serviceForRepository(repository: string | undefined, services: ServiceMapping[], files: string[] = [], named?: string) {
  if (named && services.some((service) => service.name === named)) return named;
  const names = servicesForChange(repository, files, services);
  return names.length === 1 ? names[0] : undefined;
}

export interface IntakeModel { environments: EnvironmentConfig[]; releaseBranches: string[] }
export interface PlacedSignal<T> { signal: T; mayOpen: boolean; holdReason?: string; drop?: boolean; laneOnly?: boolean }

/**
 * Puts an incoming signal into the workspace's model before grouping: canonical environment, the app
 * service a GitHub repository maps to, and whether it is allowed to open an incident at all. Signals that
 * may not open one (staging, QA, previews, feature branches) are still kept as evidence and early warning.
 */
export function placeSignal<T extends { service: string; environment?: string; metadata: Record<string, unknown> }>(signal: T, model: IntakeModel, services: ServiceMapping[], commitFiles: (sha: string) => string[] = () => []): PlacedSignal<T> {
  const meta = signal.metadata ?? {};
  const environment = resolveEnvironment(signal.environment ?? meta.deploymentEnvironment, model.environments);
  const placed = { ...signal, environment: environment.name === "unknown" ? undefined : environment.name, metadata: { ...meta, environmentTier: environment.tier } } as T;
  if (meta.provider === "github") {
    const files = typeof meta.sha === "string" ? commitFiles(meta.sha) : [];
    const service = serviceForRepository(typeof meta.repository === "string" ? meta.repository : undefined, services, files, typeof meta.serviceHint === "string" ? meta.serviceHint : undefined);
    if (service) placed.service = service;
  }
  // Pushes are context for delivery incidents on release branches only; elsewhere their commits are kept in the change log.
  if (meta.provider === "github" && meta.eventType === "push" && !branchMatches(typeof meta.branch === "string" ? meta.branch : undefined, model.releaseBranches)) return { signal: placed, mayOpen: false, drop: true };
  // A successful deploy is recovery evidence for the incident its failure opened, not a reason to join others by time.
  if (meta.laneOnly) return { signal: placed, mayOpen: false, laneOnly: true };
  if (!environment.opensIncidents) return { signal: placed, mayOpen: false, holdReason: `${environment.name} does not open incidents` };
  const branch = typeof meta.branch === "string" ? meta.branch : undefined;
  if (meta.provider === "github" && ["workflow_run", "deployment_status"].includes(String(meta.eventType)) && branch && !/^[0-9a-f]{40}$/i.test(branch) && !branchMatches(branch, model.releaseBranches)) {
    return { signal: placed, mayOpen: false, holdReason: `${branch} is not a release branch` };
  }
  return { signal: placed, mayOpen: true };
}
