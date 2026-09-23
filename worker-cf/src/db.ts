// Neon-serverless port of ../worker/src/db.ts. Cloudflare Workers cannot open raw
// TCP sockets, so we use @neondatabase/serverless's HTTP query path (`sql.query`)
// instead of the pooled `pg` client. Same SQL, same schema — only the transport
// differs. Timestamps are passed as ISO strings (the HTTP driver doesn't adapt JS
// Date the way node-postgres does), and counts come via RETURNING (the HTTP result
// shape doesn't carry a reliable rowCount).
//
// makeDb(url) is a factory so the Durable Object can construct it once from the
// DATABASE_URL binding at runtime (Workers has no process.env at module load).

import { neon } from "@neondatabase/serverless";

const DAY_MS = 86_400_000;
const FILL_COLS = 14;
const FILL_CHUNK = 500; // 14×500 = 7000 params, well under Postgres's 65535 bind cap
const iso = (ms: number) => new Date(ms).toISOString();

export type SyncTarget = { address: string; last_indexed_at: string | null };
export type FillInsert = {
  tid: number; address: string; coin: string; ticker: string;
  side: string; dir: string; leveraged: boolean; sz: number; px: number;
  notional: number; closedPnl: number; fee: number; isClose: boolean; time: number;
};
export type DeriveFill = { time: number; closed_pnl: number; is_close: boolean; notional: number };

export function makeDb(url: string) {
  const sql = neon(url);
  // The neon HTTP driver has no `.query` method — call `sql` directly as an ordinary
  // function: sql(text, params). Default (fullResults:false) returns the rows array.
  const rows = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const r = (await sql(text, params)) as unknown;
    return (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
  };

  return {
    async ping(): Promise<void> {
      await rows("SELECT 1");
    },

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
    syncBatch(limit: number): Promise<SyncTarget[]> {
      return rows<SyncTarget>(
        `SELECT address, last_indexed_at FROM wallet
         ORDER BY (tier='hot') DESC, last_indexed_at ASC NULLS FIRST LIMIT $1`,
        [limit],
      );
    },

    async insertFills(fills: FillInsert[]): Promise<number> {
      if (!fills.length) return 0;
      let inserted = 0;
      for (let off = 0; off < fills.length; off += FILL_CHUNK) {
        const chunk = fills.slice(off, off + FILL_CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((r, i) => {
          const b = i * FILL_COLS;
          values.push(r.tid, r.address, r.coin, r.ticker, r.side, r.dir, r.leveraged,
            r.sz, r.px, r.notional, r.closedPnl, r.fee, r.isClose, iso(r.time));
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14})`;
        });
        const res = await rows(
          `INSERT INTO fill (tid,address,coin,ticker,side,dir,leveraged,sz,px,notional,closed_pnl,fee,is_close,time)
           VALUES ${tuples.join(",")} ON CONFLICT (tid) DO NOTHING RETURNING tid`,
          values,
        );
        inserted += res.length;
      }
      return inserted;
    },

    async markIndexed(address: string, watermark: number, earliestFill: number | null): Promise<void> {
      await rows(
        `UPDATE wallet SET last_indexed_at = $2,
           first_hip3_trade_at = LEAST(COALESCE(first_hip3_trade_at, $3), $3)
         WHERE address = $1`,
        [address, iso(watermark), earliestFill ? iso(earliestFill) : null],
      );
    },

    // ── derive ────────────────────────────────────────────────────────────
    metricsCandidates(sinceMs: number, limit: number): Promise<{ address: string }[]> {
      return rows<{ address: string }>(
        `SELECT DISTINCT address FROM fill WHERE time >= $1 LIMIT $2`,
        [iso(sinceMs), limit],
      );
    },

    fillsForDerive(address: string, sinceMs: number): Promise<DeriveFill[]> {
      return rows<DeriveFill>(
        `SELECT extract(epoch FROM time)*1000 AS time, closed_pnl, is_close, notional
         FROM fill WHERE address = $1 AND time >= $2`,
        [address, iso(sinceMs)],
      );
    },

    async firstTradeMs(address: string): Promise<number | null> {
      const r = await rows<{ t: number | null }>(
        `SELECT extract(epoch FROM first_hip3_trade_at)*1000 AS t FROM wallet WHERE address = $1`,
        [address],
      );
      return r[0]?.t ? Number(r[0].t) : null;
    },

    async upsertMetrics(m: {
      address: string; realizedPnl: number; winRate: number; tradeCount: number;
      closedCount: number; activeDays: number; ageDays: number; qualifiesWinRate: boolean;
    }): Promise<void> {
      await rows(
        `INSERT INTO wallet_metrics
           (address, realized_pnl, win_rate, trade_count, closed_count, active_days, age_days, qualifies_winrate, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (address) DO UPDATE SET
           realized_pnl=$2, win_rate=$3, trade_count=$4, closed_count=$5,
           active_days=$6, age_days=$7, qualifies_winrate=$8, computed_at=now()`,
        [m.address, m.realizedPnl, m.winRate, m.tradeCount, m.closedCount, m.activeDays, m.ageDays, m.qualifiesWinRate],
      );
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
  };
}

export type Db = ReturnType<typeof makeDb>;
export const sinceWindow = (days: number) => Date.now() - days * DAY_MS;
