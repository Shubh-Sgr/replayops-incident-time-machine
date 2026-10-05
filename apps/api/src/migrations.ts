import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

/**
 * Versioned schema migrations. Each `db/migrations/*.sql` file runs once, in name order, inside its own
 * transaction, and is recorded in `replayops_schema_migrations` with a checksum. An advisory lock keeps
 * two API instances from migrating at the same time.
 *
 * Files that existed before this runner were applied by hand (or are mirrored by idempotent startup DDL),
 * so on first run they are recorded as a baseline instead of being executed again.
 */
export const LEGACY_MIGRATIONS = new Set([
  "002_automated_ingestion.sql", "003_real_user_readiness.sql", "004_invitation_email_delivery.sql",
  "005_investigation_proof_loop.sql", "006_final_casework_flow.sql", "20260925_replayops_redesign.sql"
]);
const LOCK_KEY = 7_340_211_905;
export const migrationsDirectory = new URL("../db/migrations/", import.meta.url);

export interface MigrationFile { name: string; sql: string; checksum: string }

export async function readMigrations(directory: URL = migrationsDirectory): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

/** Which files to run and which to baseline, given what is already recorded. Pure for testing. */
export function planMigrations(files: MigrationFile[], applied: Map<string, string>, firstRun: boolean) {
  const baseline = firstRun ? files.filter((file) => LEGACY_MIGRATIONS.has(file.name)) : [];
  const pending = files.filter((file) => !applied.has(file.name) && !baseline.includes(file));
  const changed = files.filter((file) => applied.has(file.name) && applied.get(file.name) !== file.checksum && !LEGACY_MIGRATIONS.has(file.name)).map((file) => file.name);
  return { baseline, pending, changed };
}

export async function runMigrations(pool: Pool, files?: MigrationFile[]) {
  const migrations = files ?? await readMigrations();
  const client = await pool.connect();
  // One transaction with a transaction-scoped lock: safe behind Supabase's transaction pooler, and a
  // failing migration rolls back the whole batch so the schema is never left half-upgraded.
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await client.query(`create table if not exists replayops_schema_migrations (
      name text primary key, checksum text not null, baseline boolean not null default false, applied_at timestamptz not null default now()
    )`);
    await client.query("alter table replayops_schema_migrations enable row level security");
    const rows = (await client.query("select name, checksum from replayops_schema_migrations")).rows as Array<{ name: string; checksum: string }>;
    const plan = planMigrations(migrations, new Map(rows.map((row) => [row.name, row.checksum])), rows.length === 0);
    if (plan.changed.length) console.warn(`Applied migrations were edited after running: ${plan.changed.join(", ")}. Add a new migration instead.`);
    for (const file of plan.baseline) {
      await client.query("insert into replayops_schema_migrations(name, checksum, baseline) values ($1, $2, true) on conflict do nothing", [file.name, file.checksum]);
    }
    for (const file of plan.pending) {
      try {
        await client.query(file.sql);
      } catch (error) {
        throw new Error(`Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await client.query("insert into replayops_schema_migrations(name, checksum) values ($1, $2)", [file.name, file.checksum]);
    }
    await client.query("commit");
    for (const file of plan.pending) console.log(`Applied migration ${file.name}`);
    return { applied: plan.pending.map((file) => file.name), baselined: plan.baseline.map((file) => file.name) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
