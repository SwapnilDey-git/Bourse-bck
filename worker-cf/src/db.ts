// Neon-serverless port of ../worker/src/db.ts. Cloudflare Workers cannot open raw
// TCP sockets, so we use @neondatabase/serverless's HTTP query path (`sql.query`)
// instead of the pooled `pg` client. Same SQL, same schema — only the transport
// differs. Timestamps are passed as ISO strings (the HTTP driver doesn't adapt JS
// Date the way node-postgres does), and counts come via RETURNING (the HTTP result
// shape doesn't carry a reliable rowCount).
//
// makeDb(url) is a factory so the Durable Object can construct it once from the
// DATABASE_URL binding at runtime (Workers has no process.env at module load).
// Implements ../../src/lib/wallets/ingest.ts's IngestDb interface — see that file
// for why each method exists.

import { neon } from "@neondatabase/serverless";
import { nextAttemptDelay, type IngestDb, type IngestBatch, type SyncTarget } from "../../src/lib/wallets/ingest";
import {
  INGEST_FILLS_SQL, TRIM_RAW_FILLS_SQL, RECOMPUTE_METRICS_SQL, PRUNE_DAILY_SQL, PRUNE_RAW_SQL,
} from "../../src/lib/wallets/sql";

const iso = (ms: number) => new Date(ms).toISOString();

export function makeDb(url: string): IngestDb {
  const sql = neon(url);
  // The neon HTTP driver has no `.query` method — call `sql` directly as an ordinary
  // function: sql(text, params). Default (fullResults:false) returns the rows array.
  const rows = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const r = (await sql(text, params)) as unknown;
    return (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
  };

  return {
    // ── discover ──────────────────────────────────────────────────────────
    async upsertWallets(addresses: string[]): Promise<number> {
      if (!addresses.length) return 0;
      const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
      const r = await rows(
        `INSERT INTO wallet (address) SELECT unnest($1::text[])
         ON CONFLICT (address) DO NOTHING RETURNING address`,
        [uniq],
      );
      return r.length;
    },

    // ── sync ──────────────────────────────────────────────────────────────
    // Atomically claim + lease due wallets — see worker/src/db.ts's claimSyncBatch
    // for the multi-instance-safety rationale (identical SQL, HTTP transport).
    async claimSyncBatch(limit: number, leaseMs: number): Promise<SyncTarget[]> {
      return rows<SyncTarget>(
        `WITH due AS (
           SELECT address FROM wallet
           WHERE (claimed_until IS NULL OR claimed_until <= now())
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY (tier='hot') DESC, last_indexed_at ASC NULLS FIRST
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE wallet SET claimed_until = now() + ($2 || ' milliseconds')::interval
         FROM due WHERE wallet.address = due.address
         RETURNING wallet.address, wallet.last_indexed_at`,
        [limit, leaseMs],
      );
    },

    // Same single statement as worker/src/db.ts (src/lib/wallets/sql.ts).
    async ingestFills(b: IngestBatch): Promise<number> {
      const r = await rows<{ counted: number }>(INGEST_FILLS_SQL, [
        JSON.stringify(b.tail), b.boundaryTids, JSON.stringify(b.daily), b.address, b.watermark,
      ]);
      await rows(TRIM_RAW_FILLS_SQL, [b.address, b.keepRaw]);
      return Number(r[0]?.counted ?? 0);
    },

    async recordSyncSuccess(address: string, watermark: number, earliestFill: number | null): Promise<void> {
      await rows(
        `UPDATE wallet SET last_indexed_at = $2,
           first_hip3_trade_at = LEAST(COALESCE(first_hip3_trade_at, $3), $3),
           fail_count = 0, last_error = NULL, next_attempt_at = NULL, claimed_until = NULL
         WHERE address = $1`,
        [address, iso(watermark), earliestFill ? iso(earliestFill) : null],
      );
    },

    async recordSyncFailure(address: string, message: string): Promise<void> {
      const r = await rows<{ fail_count: number }>(
        `UPDATE wallet SET fail_count = fail_count + 1, last_error = $2, claimed_until = NULL
         WHERE address = $1 RETURNING fail_count`,
        [address, message.slice(0, 500)],
      );
      const failCount = r[0]?.fail_count ?? 1;
      await rows(
        `UPDATE wallet SET next_attempt_at = $2 WHERE address = $1`,
        [address, iso(Date.now() + nextAttemptDelay(failCount))],
      );
    },

    // ── derive ────────────────────────────────────────────────────────────
    async recomputeMetrics(windowDays: number): Promise<number> {
      return (await rows(RECOMPUTE_METRICS_SQL, [windowDays])).length;
    },

    // ── fresh-flag ────────────────────────────────────────────────────────
    async refreshFreshFlags(maxAgeDays: number): Promise<number> {
      const r = await rows(
        `UPDATE wallet SET is_fresh =
           (first_hip3_trade_at IS NOT NULL AND first_hip3_trade_at > now() - ($1 || ' days')::interval)
         WHERE is_fresh <>
           (first_hip3_trade_at IS NOT NULL AND first_hip3_trade_at > now() - ($1 || ' days')::interval)
         RETURNING address`,
        [maxAgeDays],
      );
      return r.length;
    },

    // ── retain (Neon storage) ────────────────────────────────────────────
    // Batched so the FIRST run against a months-old backlog can't hold one
    // long DELETE open on the HTTP driver — it works down PRUNE_BATCHES
    // chunks per call and picks up where it left off on the next alarm tick.
    async pruneOldFills(beforeMs: number): Promise<number> {
      let total = (await rows(`${PRUNE_DAILY_SQL} RETURNING 1`, [beforeMs])).length;
      for (let i = 0; i < PRUNE_BATCHES; i++) {
        const r = await rows<{ tid: number }>(`${PRUNE_RAW_SQL} RETURNING tid`, [beforeMs, PRUNE_BATCH_SIZE]);
        total += r.length;
        if (r.length < PRUNE_BATCH_SIZE) break; // caught up
      }
      return total;
    },
  };
}

const PRUNE_BATCH_SIZE = 5_000;
const PRUNE_BATCHES = 20; // ≤100k rows/call — the rest catches up over later daily ticks

// A ping used only at DO init to fail fast on a missing/unreachable database.
export async function ping(url: string): Promise<void> {
  const sql = neon(url);
  await sql("SELECT 1");
}
