// Loop 3 · Derive — recompute wallet_metrics from `fill` over the 60-day window.
// Pure math lives in the shared metrics module (deriveMetrics), so the numbers the
// worker persists are byte-identical to what the read layer would compute. This is
// the "precomputed, never recomputed per view" half of the depth-cap survival split.

import { config } from "../config";
import { deriveMetrics, ageDaysFrom, WINDOW_DAYS } from "../core";
import {
  fillsForDerive, metricsCandidates, upsertMetrics, sinceWindow, pool,
} from "../db";

let running = false;

async function tick() {
  if (running) return;
  running = true;
  const now = Date.now();
  const since = sinceWindow(WINDOW_DAYS);
  try {
    const candidates = await metricsCandidates(since, config.deriveBatchSize);
    for (const { address } of candidates) {
      try {
        const raw = await fillsForDerive(address, since);
        const m = deriveMetrics(
          raw.map((f) => ({
            time: Number(f.time),
            closedPnl: Number(f.closed_pnl),
            isClose: f.is_close,
            notional: Number(f.notional),
          })),
          now,
        );
        // Age basis is the wallet's earliest-ever HIP-3 trade, not window-clipped.
        const ageRow = await pool.query(
          `SELECT extract(epoch FROM first_hip3_trade_at)*1000 AS t FROM wallet WHERE address=$1`,
          [address],
        );
        const firstMs = ageRow.rows[0]?.t ? Number(ageRow.rows[0].t) : null;
        await upsertMetrics({ address, ...m, ageDays: ageDaysFrom(firstMs, now) });
      } catch (err) {
        console.error(`[derive] ${address} failed:`, (err as Error).message);
      }
    }
    if (candidates.length) console.log(`[derive] recomputed ${candidates.length} wallets`);
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;
export function startDerive() {
  timer = setInterval(tick, config.deriveIntervalMs);
}
export function stopDerive() {
  if (timer) clearInterval(timer);
}
