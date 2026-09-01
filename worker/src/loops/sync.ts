// Loop 2 · Sync — the userFills poller. The budget-dominating loop: for each
// wallet it walks userFillsByTime forward from the wallet's watermark, keeps only
// equity fills (classify), and appends them to `fill`. hl's own token bucket
// throttles the ≈25-wt calls, so a bounded batch per interval keeps us under the
// 1200 wt/min ceiling with headroom for market polling.

import { config } from "../config";
import { hl, classify } from "../core";
import { insertFills, markIndexed, syncBatch, sinceWindow, type FillInsert, type SyncTarget } from "../db";

let running = false;

function watermarkOf(t: SyncTarget): number {
  if (t.last_indexed_at) return Date.parse(t.last_indexed_at);
  // Never indexed → reach back the backfill window (forward-only warm-up otherwise).
  return sinceWindow(config.backfillDays);
}

async function syncWallet(t: SyncTarget): Promise<number> {
  const start = watermarkOf(t);
  // Paginate forward through the 2000-fill cap so an active wallet's full history
  // from its watermark is drained (bounded per pass; resumes next pass if not).
  const { fills } = await hl.userFillsPaged(t.address, start, { maxPages: config.syncMaxPagesPerWallet });
  const rows: FillInsert[] = [];
  let earliest: number | null = null;

  for (const f of fills) {
    const info = classify(f.coin);
    if (!info) continue; // drop non-equity fills
    const sz = parseFloat(f.sz);
    const px = parseFloat(f.px);
    const isClose = /^close/i.test(f.dir);
    rows.push({
      tid: f.tid,
      address: t.address,
      coin: f.coin,
      ticker: info.ticker,
      side: f.side,
      dir: f.dir,
      leveraged: true, // all HIP-3 equities are perps; refined by lev==1 at read time
      sz,
      px,
      notional: sz * px,
      closedPnl: parseFloat(f.closedPnl || "0"),
      fee: parseFloat(f.fee || "0"),
      isClose,
      time: f.time,
    });
    if (earliest === null || f.time < earliest) earliest = f.time;
  }

  const inserted = await insertFills(rows);
  // Advance the watermark to the newest fill we saw (or now if none), so we never
  // re-scan the same window.
  const newest = fills.length ? Math.max(...fills.map((f) => f.time)) : Date.now();
  await markIndexed(t.address, newest, earliest);
  return inserted;
}

async function tick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const batch = await syncBatch(config.syncBatchSize);
    let total = 0;
    for (const t of batch) {
      try {
        total += await syncWallet(t);
      } catch (err) {
        console.error(`[sync] ${t.address} failed:`, (err as Error).message);
      }
    }
    if (total) console.log(`[sync] +${total} fills across ${batch.length} wallets`);
  } finally {
    running = false;
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
