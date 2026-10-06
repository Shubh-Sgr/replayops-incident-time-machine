import { describe, expect, it } from "vitest";
import { branchMatches, changeTouchesService, repositoryName, resolveEnvironment, serviceForRepository, servicesForChange, type ServiceMapping } from "./release.js";

describe("environments", () => {
  it("maps the names tools use onto the workspace's environments", () => {
    expect(resolveEnvironment("Production")).toMatchObject({ name: "production", tier: "production", opensIncidents: true });
    expect(resolveEnvironment("prd").name).toBe("production");
    expect(resolveEnvironment("production-eu-west").name).toBe("production");
    expect(resolveEnvironment("Preview")).toMatchObject({ name: "development", opensIncidents: false });
    expect(resolveEnvironment("UAT")).toMatchObject({ name: "staging", tier: "preprod", opensIncidents: false });
  });

  it("keeps missing environments open (CI on main) and treats unknown names as non-production", () => {
    expect(resolveEnvironment(undefined)).toMatchObject({ name: "unknown", opensIncidents: true });
    expect(resolveEnvironment("pr-1234")).toMatchObject({ name: "pr-1234", opensIncidents: false });
  });
});

describe("branches", () => {
  it("matches release branches and patterns, not feature branches", () => {
    expect(branchMatches("main")).toBe(true);
    expect(branchMatches("refs/heads/release/2.3")).toBe(true);
    expect(branchMatches("hotfix/payout-iban")).toBe(true);
    expect(branchMatches("feature/new-checkout")).toBe(false);
    expect(branchMatches(undefined)).toBe(false);
  });
});

describe("services and repositories", () => {
  const services: ServiceMapping[] = [
    { name: "payouts-api", repositories: ["acme/platform"], paths: ["services/payouts"] },
    { name: "web", repositories: ["acme/platform"], paths: ["apps/web/"] },
    { name: "billing-api", repositories: [], paths: [], repositoryUrl: "https://github.com/Acme/billing.git" }
  ];

  it("normalizes repository references", () => {
    expect(repositoryName("https://github.com/Acme/Billing.git")).toBe("acme/billing");
    expect(repositoryName("git@github.com:acme/api.git")).toBe("acme/api");
    expect(repositoryName("acme/api")).toBe("acme/api");
  });

  it("decides affected services in a monorepo from changed files", () => {
    expect(servicesForChange("acme/platform", ["apps/web/src/App.tsx", "README.md"], services)).toEqual(["web"]);
    expect(servicesForChange("acme/platform", ["services/payouts/build.ts", "apps/web/x.ts"], services)).toEqual(["payouts-api", "web"]);
    expect(servicesForChange("acme/platform", [], services)).toEqual(["payouts-api", "web"]);
    expect(servicesForChange("acme/billing", [], services)).toEqual(["billing-api"]);
  });

  it("gives a whole-repo service only the code no path-scoped service owns, never CI or docs alone", () => {
    const shared: ServiceMapping[] = [
      { name: "drill-payouts", repositories: ["acme/shop"], paths: ["drill/payouts-api"] },
      { name: "shop", repositories: ["acme/shop"], paths: [] }
    ];
    expect(servicesForChange("acme/shop", [".github/workflows/drill.yml", "drill/payouts-api/release.txt"], shared)).toEqual(["drill-payouts"]);
    expect(servicesForChange("acme/shop", ["apps/web/a.tsx", "drill/payouts-api/release.txt"], shared)).toEqual(["drill-payouts", "shop"]);
    expect(servicesForChange("acme/shop", ["README.md", ".github/workflows/ci.yml"], shared)).toEqual(["shop"]);
    expect(serviceForRepository("acme/shop", shared, ["drill/payouts-api/release.txt"])).toBe("drill-payouts");
    expect(serviceForRepository("acme/shop", shared)).toBeUndefined();
    expect(serviceForRepository("acme/shop", shared, [], "shop")).toBe("shop");
  });

  it("says whether a change touched a service's code, or that it can't tell", () => {
    expect(changeTouchesService("payouts-api", ["docs/runbook.md"], services)).toBe(false);
    expect(changeTouchesService("payouts-api", ["services/payouts/build.ts"], services)).toBe(true);
    expect(changeTouchesService("billing-api", ["src/a.ts"], services)).toBeNull();
  });

  it("names a repository's service only when the mapping is unambiguous", () => {
    expect(serviceForRepository("acme/billing", services)).toBe("billing-api");
    expect(serviceForRepository("acme/platform", services)).toBeUndefined();
  });
});
