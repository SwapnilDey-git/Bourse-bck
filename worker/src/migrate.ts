// Schema migration runner. The baseline schema (db/schema.sql, internally
// labeled "migration 0001"/"migration 0002") is still applied by hand once
// per fresh database (worker/README.md — `npm run db:apply`; it's idempotent,
// CREATE TABLE IF NOT EXISTS throughout). This runner owns everything AFTER
// that baseline: every *.sql file under db/migrations/, applied in filename
// order, each wrapped in its own transaction, recorded in schema_migrations
// so re-running is a no-op (review finding: "no database migration system").
//
//   cd worker && npm run migrate

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "db", "migrations");

async function main() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const appliedRows = await pool.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(appliedRows.rows.map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[migrate] applying ${file}…`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] ${file} failed:`, (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(ran ? `[migrate] applied ${ran} migration(s)` : "[migrate] up to date, nothing to apply");
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] fatal:", err);
  process.exitCode = 1;
});
