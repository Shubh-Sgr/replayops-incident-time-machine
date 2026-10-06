import type { EnvironmentConfig, IncidentPolicy } from "../types";

export const recommendedPolicy = { incidentThreshold: 65, groupingWindowMinutes: 120, suppressLowSeverity: true, maintenanceMode: false } as const;
export const defaultEnvironments: EnvironmentConfig[] = [
  { name: "production", aliases: ["prod", "prd", "live"], tier: "production", opensIncidents: true },
  { name: "staging", aliases: ["stage", "stg", "preprod", "pre-prod", "uat"], tier: "preprod", opensIncidents: false },
  { name: "qa", aliases: ["test", "testing", "qa-env"], tier: "preprod", opensIncidents: false },
  { name: "development", aliases: ["dev", "develop", "local", "preview", "sandbox"], tier: "dev", opensIncidents: false }
];
export const defaultReleaseBranches = ["main", "master", "release/*", "hotfix/*"];

/** Plain-language problems with an intake policy that would page people for noise or split one problem into many incidents. */
export function policyWarnings(policy: Pick<IncidentPolicy, "incidentThreshold" | "groupingWindowMinutes" | "suppressLowSeverity" | "maintenanceMode">) {
  const warnings: string[] = [];
  if (policy.incidentThreshold < 50) warnings.push(`A threshold of ${policy.incidentThreshold} lets low-impact warnings open incidents and send alerts.`);
  if (!policy.suppressLowSeverity && policy.incidentThreshold < 65) warnings.push("Low-severity signals can open incidents on their own.");
  if (policy.groupingWindowMinutes < 30) warnings.push(`A ${policy.groupingWindowMinutes}-minute grouping window splits one problem into several incidents when its signals arrive further apart.`);
  if (policy.maintenanceMode) warnings.push("Maintenance mode is on: no incidents open automatically and nobody is alerted.");
  return warnings;
}
