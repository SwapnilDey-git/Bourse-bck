// Loop 3 · Derive — recompute wallet_metrics from `fill` over the 60-day window.
// Pure math lives in the shared metrics module (deriveMetrics), so the numbers
// the worker persists are byte-identical to what the read layer would compute.
// Thin wrapper around the shared runDeriveTick (src/lib/wallets/ingest.ts, via
// ../core), which also fixes the candidate-selection starvation: candidates are
// now ordered least-recently-derived first instead of an unordered DISTINCT.

import { config } from "../config";
import { runDeriveTick, sinceWindow, WINDOW_DAYS } from "../core";
import { db } from "../db";
import { reportTick } from "../health";

let running = false;

async function tick() {
  if (running) return;
  running = true;
  let tickError: string | undefined;
  try {
    const { processed } = await runDeriveTick(
      db,
      {
        sinceMs: sinceWindow(WINDOW_DAYS),
        batchSize: config.deriveBatchSize,
        concurrency: config.deriveConcurrency,
        now: Date.now(),
      },
      (address, message) => console.error(`[derive] ${address} failed:`, message),
    );
    if (processed) console.log(`[derive] recomputed ${processed} wallets`);
  } catch (err) {
    tickError = (err as Error).message;
    console.error("[derive] tick failed:", tickError);
  } finally {
    running = false;
    reportTick("derive", config.deriveIntervalMs, tickError);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startDerive() {
  timer = setInterval(tick, config.deriveIntervalMs);
}
export function stopDerive() {
  if (timer) clearInterval(timer);
}
