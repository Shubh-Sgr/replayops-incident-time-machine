import { describe, expect, it } from "vitest";
import { policyWarnings, recommendedPolicy } from "./policy";

describe("intake policy warnings", () => {
  it("accepts the recommended policy", () => expect(policyWarnings(recommendedPolicy)).toEqual([]));
  it("flags a noisy threshold and a short grouping window", () => {
    const warnings = policyWarnings({ incidentThreshold: 30, groupingWindowMinutes: 15, suppressLowSeverity: false, maintenanceMode: false });
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toContain("15-minute");
  });
});
