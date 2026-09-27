// Shared ingestion orchestration — the ONE definition of what "sync a wallet",
// "derive a wallet's metrics", and "classify a fill for storage" mean. Used
// unchanged by the Node worker (worker/, pg Pool) and the Cloudflare Durable
// Object worker (worker-cf/, neon HTTP driver). Only the Db adapter differs
// per runtime; every loop body here is pure orchestration over the IngestDb
// interface plus the shared hl/symbols/metrics modules. Extracted so the two
// runtimes' loop logic can't drift apart again — worker-cf/src/ingestor.ts
// used to carry a byte-for-byte duplicate of worker/src/loops/*.

import * as hl from "../hl";
import { classify } from "../symbols";
import { EQUITY_META, INDEX_META } from "../symbols/table";
import { deriveMetrics, ageDaysFrom, type MetricFill } from "./metrics";

export type SyncTarget = { address: string; last_indexed_at: string | null };

export type FillInsert = {
  tid: number; address: string; coin: string; ticker: string;
  side: string; dir: string; leveraged: boolean; sz: number; px: number;
  notional: number; closedPnl: number; fee: number; isClose: boolean; time: number;
};

export type DeriveFill = { time: number; closed_pnl: number; is_close: boolean; notional: number };

// Every write the loops need, behind one interface — implemented once per
// runtime (worker/src/db.ts on pg, worker-cf/src/db.ts on @neondatabase/serverless).
export interface IngestDb {
  upsertWallets(addresses: string[]): Promise<number>;

  // Atomically claim up to `limit` due wallets for sync, leasing them for
  // `leaseMs` so a second worker instance can't grab the same rows — the
  // multi-instance-DATA-safety half of that fix. (The other half, the shared
  // Hyperliquid rate-budget token bucket in src/lib/hl, is still process-local
  // memory — see worker/README.md's "Known limits" note before running >1
  // instance.)
  claimSyncBatch(limit: number, leaseMs: number): Promise<SyncTarget[]>;
  insertFills(rows: FillInsert[]): Promise<number>;
  recordSyncSuccess(address: string, watermark: number, earliestFill: number | null): Promise<void>;
  recordSyncFailure(address: string, message: string): Promise<void>;

  metricsCandidates(sinceMs: number, limit: number): Promise<{ address: string }[]>;
  fillsForDerive(address: string, sinceMs: number): Promise<DeriveFill[]>;
  firstTradeMs(address: string): Promise<number | null>;
  upsertMetrics(m: {
    address: string; realizedPnl: number; winRate: number; tradeCount: number;
    closedCount: number; activeDays: number; ageDays: number; qualifiesWinRate: boolean;
  }): Promise<void>;

  refreshFreshFlags(maxAgeDays: number): Promise<number>;
}

export const DAY_MS = 86_400_000;
export const sinceWindow = (days: number): number => Date.now() - days * DAY_MS;

// ── retry/backoff policy for a wallet that keeps failing sync ───────────────
// Exponential with ~50-100% jitter, capped — a wallet that keeps failing backs
// off instead of sitting at the front of the claim queue forever (review
// finding: "a failing wallet can keep getting retried").
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;
export function nextAttemptDelay(failCount: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1));
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

// ── ticker classification, gated to the tracked dex's own namespace ─────────
// classify() intentionally defaults an unrecognized ticker to "equity" so the
// grid self-updates (symbols/table.ts) — sound ONLY for coins that actually
// belong to the tracked dex. userFillsByTime returns a wallet's fills across
// EVERY dex/venue it has ever touched, not just ours: a wallet that also
// trades core-dex BTC/ETH (coin "BTC", no colon) or another HIP-3 dex's coins
// would otherwise have those fills silently absorbed as "equities" (review
// finding: hardcoded/fallback classification risk). Reject anything outside
// `${dex}:` before consulting the ticker tables at all.
const warnedTickers = new Set<string>();
export function classifyForIngestion(coin: string, dex: string) {
  if (!coin.startsWith(`${dex}:`)) return null;
  const info = classify(coin);
  if (!info) return null;
  const known = info.kind === "index" ? info.ticker in INDEX_META : info.ticker in EQUITY_META;
  if (!known && !warnedTickers.has(info.ticker)) {
    warnedTickers.add(info.ticker);
    console.warn(
      `[ingest] unmapped ticker "${info.ticker}" (${coin}) defaulted to generic equity metadata — add it to src/lib/symbols/table.ts`,
    );
  }
  return info;
}

export function buildFillRows(
  address: string,
  fills: hl.Fill[],
  dex: string,
): { rows: FillInsert[]; earliest: number | null } {
  const rows: FillInsert[] = [];
  let earliest: number | null = null;
  for (const f of fills) {
    const info = classifyForIngestion(f.coin, dex);
    if (!info) continue; // drop non-equity / other-venue fills
    const sz = parseFloat(f.sz);
    const px = parseFloat(f.px);
    rows.push({
      tid: f.tid,
      address,
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
      isClose: /^close/i.test(f.dir),
      time: f.time,
    });
    if (earliest === null || f.time < earliest) earliest = f.time;
  }
  return { rows, earliest };
}

function watermarkOf(t: SyncTarget, backfillDays: number): number {
  return t.last_indexed_at ? Date.parse(t.last_indexed_at) : sinceWindow(backfillDays);
}

export type SyncOpts = { dex: string; maxPages: number; backfillDays: number };

// One wallet's sync pass: page userFillsByTime forward from its watermark and
// insert new fills. Throws on failure — the caller (runSyncTick) persists
// success/failure so retry/backoff policy lives in one place.
export async function syncOneWallet(
  db: Pick<IngestDb, "insertFills">,
  target: SyncTarget,
  opts: SyncOpts,
): Promise<{ inserted: number; watermark: number; earliest: number | null }> {
  const start = watermarkOf(target, opts.backfillDays);
  const { fills } = await hl.userFillsPaged(target.address, start, { maxPages: opts.maxPages });
  const { rows, earliest } = buildFillRows(target.address, fills, opts.dex);
  const inserted = await db.insertFills(rows);
  const watermark = fills.length ? Math.max(...fills.map((f) => f.time)) : Date.now();
  return { inserted, watermark, earliest };
}

// Bounded-concurrency map — loops process a claimed batch in parallel instead
// of one wallet at a time (review finding: "sequential DB operations"). This
// bounds CONCURRENT IN-FLIGHT wallets; the actual Hyperliquid calls still
// serialize behind the shared weight budget in src/lib/hl when it's spent, so
// raising this only overlaps I/O wait, not the real request rate.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export type SyncWalletOutcome = { inserted: number } | { error: string };

// ── the sync tick: claim → process (bounded concurrency) → persist outcome ──
export async function runSyncTick(
  db: IngestDb,
  opts: SyncOpts & { batchSize: number; concurrency: number; leaseMs: number },
  onWalletDone?: (address: string, result: SyncWalletOutcome) => void,
): Promise<{ totalInserted: number; walletsProcessed: number }> {
  const batch = await db.claimSyncBatch(opts.batchSize, opts.leaseMs);
  let totalInserted = 0;
  await mapWithConcurrency(batch, opts.concurrency, async (t) => {
    try {
      const r = await syncOneWallet(db, t, opts);
      await db.recordSyncSuccess(t.address, r.watermark, r.earliest);
      totalInserted += r.inserted;
      onWalletDone?.(t.address, { inserted: r.inserted });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      await db.recordSyncFailure(t.address, message);
      onWalletDone?.(t.address, { error: message });
    }
  });
  return { totalInserted, walletsProcessed: batch.length };
}

// ── the derive tick ──────────────────────────────────────────────────────────
export async function runDeriveTick(
  db: Pick<IngestDb, "metricsCandidates" | "fillsForDerive" | "firstTradeMs" | "upsertMetrics">,
  opts: { sinceMs: number; batchSize: number; concurrency: number; now: number },
  onError?: (address: string, message: string) => void,
): Promise<{ processed: number }> {
  const candidates = await db.metricsCandidates(opts.sinceMs, opts.batchSize);
  await mapWithConcurrency(candidates, opts.concurrency, async ({ address }) => {
    try {
      const raw = await db.fillsForDerive(address, opts.sinceMs);
      const m = deriveMetrics(
        raw.map(
          (f): MetricFill => ({
            time: Number(f.time),
            closedPnl: Number(f.closed_pnl),
            isClose: f.is_close,
            notional: Number(f.notional),
          }),
        ),
        opts.now,
      );
      const firstMs = await db.firstTradeMs(address);
      await db.upsertMetrics({ address, ...m, ageDays: ageDaysFrom(firstMs, opts.now) });
    } catch (err) {
      onError?.(address, (err as Error).message ?? String(err));
    }
  });
  return { processed: candidates.length };
}

export async function runFreshTick(
  db: Pick<IngestDb, "refreshFreshFlags">,
  maxAgeDays: number,
): Promise<number> {
  return db.refreshFreshFlags(maxAgeDays);
}
