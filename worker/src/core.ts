// Single bridge to the shared deep modules in ../../src/lib. IMPLEMENTATION.md §4:
// the worker "starts as a top-level worker/ dir sharing src/lib" — this file is
// the one place that reaches across, so the deep relative path lives here only and
// the loops import from "../core". The `hl` token bucket is module-level, so both
// the worker and any co-located code share ONE budget within this process — the
// single-egress-IP invariant from the architecture.

export * as hl from "../../src/lib/hl";
export { classify } from "../../src/lib/symbols";
export {
  deriveMetrics, ageDaysFrom, WINDOW_DAYS, FRESH_MAX_AGE_DAYS,
  type MetricFill,
} from "../../src/lib/wallets/metrics";
export {
  runSyncTick, runDeriveTick, runFreshTick, nextAttemptDelay, classifyForIngestion, sinceWindow,
  type IngestDb, type SyncTarget, type FillInsert, type DeriveFill, type SyncOpts,
  type SyncWalletOutcome,
} from "../../src/lib/wallets/ingest";
