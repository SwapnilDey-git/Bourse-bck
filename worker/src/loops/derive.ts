// Loop 3 · Derive — recompute wallet_metrics from fill_daily over the 60-day
// window. Thin wrapper around the shared runDeriveTick (src/lib/wallets/ingest.ts,
// via ../core): one set-based SQL statement covers every wallet each tick, so
// there's no candidate batching to starve and no raw fills leave the database.

import { config } from "../config";
import { runDeriveTick, WINDOW_DAYS } from "../core";
import { db } from "../db";
import { reportTick } from "../health";

let running = false;

async function tick() {
  if (running) return;
  running = true;
  let tickError: string | undefined;
  try {
    const { processed } = await runDeriveTick(db, { windowDays: WINDOW_DAYS });
    if (processed) console.log(`[derive] updated ${processed} wallets`);
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
