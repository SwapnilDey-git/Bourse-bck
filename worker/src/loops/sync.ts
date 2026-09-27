// Loop 2 · Sync — the userFills poller. The budget-dominating loop. Thin
// wrapper around the shared runSyncTick (src/lib/wallets/ingest.ts, re-exported
// via ../core): claim a due batch (multi-instance-safe via a DB lease), drain
// each wallet's userFillsByTime forward from its watermark with bounded
// concurrency, and persist success/failure — a failing wallet backs off via
// next_attempt_at instead of sitting at the front of the claim queue forever.

import { config } from "../config";
import { runSyncTick } from "../core";
import { db } from "../db";
import { reportTick } from "../health";

let running = false;

async function tick() {
  if (running) return; // never overlap ticks
  running = true;
  let tickError: string | undefined;
  try {
    const { totalInserted, walletsProcessed } = await runSyncTick(
      db,
      {
        dex: config.dex,
        maxPages: config.syncMaxPagesPerWallet,
        backfillDays: config.backfillDays,
        batchSize: config.syncBatchSize,
        concurrency: config.syncConcurrency,
        leaseMs: config.syncLeaseMs,
      },
      (address, result) => {
        if ("error" in result) console.error(`[sync] ${address} failed:`, result.error);
      },
    );
    if (totalInserted) console.log(`[sync] +${totalInserted} fills across ${walletsProcessed} wallets`);
  } catch (err) {
    tickError = (err as Error).message;
    console.error("[sync] tick failed:", tickError);
  } finally {
    running = false;
    reportTick("sync", config.syncIntervalMs, tickError);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startSync() {
  timer = setInterval(tick, config.syncIntervalMs);
  void tick();
}
export function stopSync() {
  if (timer) clearInterval(timer);
}
