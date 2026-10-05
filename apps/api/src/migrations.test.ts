import { describe, expect, it } from "vitest";
import { planMigrations, readMigrations, type MigrationFile } from "./migrations.js";

const file = (name: string, checksum = name): MigrationFile => ({ name, sql: "select 1", checksum });

describe("schema migrations", () => {
  it("baselines pre-existing files on first run and applies only new ones", () => {
    const plan = planMigrations([file("006_final_casework_flow.sql"), file("007_active_workspace.sql")], new Map(), true);
    expect(plan.baseline.map((item) => item.name)).toEqual(["006_final_casework_flow.sql"]);
    expect(plan.pending.map((item) => item.name)).toEqual(["007_active_workspace.sql"]);
  });

  it("skips applied files and reports ones edited after they ran", () => {
    const plan = planMigrations([file("007_active_workspace.sql", "new"), file("008_api_tokens.sql")], new Map([["007_active_workspace.sql", "old"]]), false);
    expect(plan.pending.map((item) => item.name)).toEqual(["008_api_tokens.sql"]);
    expect(plan.changed).toEqual(["007_active_workspace.sql"]);
  });

  it("ships the migration files in name order", async () => {
    const names = (await readMigrations()).map((item) => item.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["007_active_workspace.sql", "008_api_tokens.sql", "009_exception_fingerprints.sql"]));
  });
});
