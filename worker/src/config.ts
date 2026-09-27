// Worker configuration — the always-on ingestion service (ARCHITECTURE.md · Diagram B,
// lane ④). Every knob that paces the four loops against the 1200 wt/min budget
// lives here. Defaults are conservative; override via env on Railway.

function num(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

export const config = {
  // Prefer the DIRECT (unpooled) URL for the always-on worker: it's a long-lived
  // pg pool doing single-statement writes, where PgBouncer transaction-mode pooling
  // buys nothing and can trip prepared-statement edge cases. Falls back to the
  // pooled URL if only that is set (e.g. a minimal Railway env).
  databaseUrl: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",

  // Hyperliquid — the single equity dex (trade.xyz holds >90% of equity OI).
  dex: process.env.BOURSE_DEX ?? "xyz",
  wsUrl: process.env.HL_WS_URL ?? "wss://api.hyperliquid.xyz/ws",

  // Discovery — refresh the tracked equity-coin list from perpDexs/meta this often.
  discoverRefreshMs: num("DISCOVER_REFRESH_MS", 10 * 60_000),
  // Buffer address upserts and flush in batches to keep PG writes cheap.
  discoverFlushMs: num("DISCOVER_FLUSH_MS", 5_000),

  // Sync — the budget-dominating loop. At ~25 wt/userFills and a 1000-wt working
  // limit, the ceiling is ~40 wallet refreshes/min. Batch + interval stay under it,
  // leaving headroom for market polling elsewhere.
  syncIntervalMs: num("SYNC_INTERVAL_MS", 30_000),
  syncBatchSize: num("SYNC_BATCH_SIZE", 15),
  // Pages drained per wallet per pass. userFillsByTime caps at 2000/page and the
  // fetch paginates FORWARD through it (verified 2026-08-27). A hyperactive wallet's
  // full 60-day backfill can span hundreds of pages — cap it so one greedy wallet
  // can't monopolize a pass; the wallet resumes from its watermark next pass.
  syncMaxPagesPerWallet: num("SYNC_MAX_PAGES", 6),
  // How many claimed wallets a sync tick processes concurrently (bounded — the
  // real network rate still serializes behind the shared hl weight budget).
  syncConcurrency: num("SYNC_CONCURRENCY", 4),
  // Lease a claimed wallet holds (claimSyncBatch) before another pass could
  // reclaim it if this one crashes mid-flight — comfortably longer than one
  // sync interval so a normal pass never lets its own claim lapse early.
  syncLeaseMs: num("SYNC_LEASE_MS", 120_000),

  // Derive — recompute wallet_metrics from fills over the 60-day window.
  deriveIntervalMs: num("DERIVE_INTERVAL_MS", 60_000),
  deriveBatchSize: num("DERIVE_BATCH_SIZE", 200),
  deriveConcurrency: num("DERIVE_CONCURRENCY", 8),

  // Fresh-flag — re-evaluate the <30d "fresh" set.
  freshIntervalMs: num("FRESH_INTERVAL_MS", 5 * 60_000),

  // How far back a never-indexed wallet's first sync reaches. Forward-only
  // discovery warms the full 60-day window over 60 days; a one-time S3 backfill
  // (deferred open item) would make day-one complete.
  backfillDays: num("BACKFILL_DAYS", 60),

  // Optional /health HTTP endpoint (worker/src/health.ts) — off unless set.
  // Every current deploy target (.do/app.yaml, render.yaml, railway.json) runs
  // this as a headless background worker with no HTTP port, so this stays
  // opt-in rather than changing the default deploy shape.
  healthPort: process.env.HEALTH_PORT ? num("HEALTH_PORT", 0) : undefined,
};

export const DAY_MS = 86_400_000;
