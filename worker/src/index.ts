// Bourse Stage-2 worker — the always-on ingestion service (ARCHITECTURE.md · Diagram B).
// Runs the four loops behind one process / one egress IP / one shared hl token bucket:
//   discover (trades WS → wallet universe) · sync (userFills → fill) ·
//   derive (fill → wallet_metrics) · fresh-flag (<30d set).
// The browser and the Vercel Read API never run any of this — they only read the
// Postgres this fills. Schema is applied out-of-band (db/schema.sql); the worker
// assumes the tables exist and fails loudly if DATABASE_URL is missing.

import { config } from "./config";
import { pool } from "./db";
import { startDiscover, stopDiscover } from "./loops/discover";
import { startSync, stopSync } from "./loops/sync";
import { startDerive, stopDerive } from "./loops/derive";
import { startFresh, stopFresh } from "./loops/fresh";
import { startHeartbeatLog, stopHeartbeatLog, startHealthServer, stopHealthServer } from "./health";

async function main() {
  if (!config.databaseUrl) {
    console.error("FATAL: DATABASE_URL is not set — the worker has nowhere to write.");
    process.exit(1);
  }

  // Fail fast if the schema hasn't been applied.
  try {
    await pool.query("SELECT 1 FROM wallet LIMIT 1");
  } catch {
    console.error("FATAL: `wallet` table missing — apply db/schema.sql first (psql \"$DATABASE_URL\" -f db/schema.sql).");
    process.exit(1);
  }

  console.log(`[worker] starting · dex=${config.dex} · sync every ${config.syncIntervalMs}ms (batch ${config.syncBatchSize})`);
  await startDiscover();
  startSync();
  startDerive();
  startFresh();
  startHeartbeatLog();
  if (config.healthPort) startHealthServer(config.healthPort);
  console.log("[worker] all four loops running");
}

async function shutdown(sig: string) {
  console.log(`[worker] ${sig} — draining`);
  stopHealthServer();
  stopHeartbeatLog();
  stopFresh();
  stopDerive();
  stopSync();
  await stopDiscover();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
