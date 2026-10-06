import type { IncidentPolicy } from "../types";

export const recommendedPolicy = { incidentThreshold: 65, groupingWindowMinutes: 120, suppressLowSeverity: true, maintenanceMode: false } as const;

/** Plain-language problems with an intake policy that would page people for noise or split one problem into many incidents. */
export function policyWarnings(policy: Omit<IncidentPolicy, "updatedAt">) {
  const warnings: string[] = [];
  if (policy.incidentThreshold < 50) warnings.push(`A threshold of ${policy.incidentThreshold} lets low-impact warnings open incidents and send alerts.`);
  if (!policy.suppressLowSeverity && policy.incidentThreshold < 65) warnings.push("Low-severity signals can open incidents on their own.");
  if (policy.groupingWindowMinutes < 30) warnings.push(`A ${policy.groupingWindowMinutes}-minute grouping window splits one problem into several incidents when its signals arrive further apart.`);
  if (policy.maintenanceMode) warnings.push("Maintenance mode is on: no incidents open automatically and nobody is alerted.");
  return warnings;
}
