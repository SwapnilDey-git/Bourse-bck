// The wallet-intelligence READ model (Stage 2). This is the store-backed half of
// BourseData: leaderboard + fresh feed come straight from the worker's Postgres
// (precomputed — never recomputed per view), and wallet profiles follow the split
// rule — CURRENT positions live from clearinghouseState (cheap, wt 2), HISTORICAL
// trades/metrics from `fill` + `wallet_metrics`. liveProvider delegates here when
// BOURSE_WALLETS=live; otherwise the selector uses the mock, untouched.

import { db } from "../db";
import * as hl from "../hl";
import type {
  FreshEntry, LeaderboardSort, Position, Related, TimelineRow,
  TradingPatterns, Wallet, WalletProfile,
} from "../data/types";
import { activeLabel, ageDaysFrom, midOf, relTime, shortOf } from "./metrics";

const LEADERBOARD_LIMIT = 50;

function tickerOf(coin: string): string {
  return coin.includes(":") ? coin.split(":")[1] : coin;
}

// Map a wallet + wallet_metrics row (snake_case from PG) to the UI `Wallet`.
type WalletRow = {
  address: string;
  first_hip3_trade_at: string | null;
  realized_pnl: number; win_rate: number; trade_count: number;
  closed_count: number; active_days: number; age_days: number;
  qualifies_winrate: boolean;
};
function toWallet(r: WalletRow, rank: number, now: number): Wallet {
  const ageDays = r.age_days || ageDaysFrom(r.first_hip3_trade_at ? Date.parse(r.first_hip3_trade_at) : null, now);
  return {
    address: r.address,
    short: shortOf(r.address),
    mid: midOf(r.address),
    rank,
    pnl: Number(r.realized_pnl),
    winRate: Number(r.win_rate),
    trades: r.trade_count,
    closed: r.closed_count,
    activeLabel: activeLabel(r.active_days),
    activeDays: r.active_days,
    qualifiesWinRate: r.qualifies_winrate,
    ageDays,
  };
}

// ── leaderboard ────────────────────────────────────────────────────────────
// One indexed sort per view (§10.9). Win-rate is gated to qualifying wallets so
// a 2-trade fluke can't top it.
export async function leaderboard(sort: LeaderboardSort): Promise<Wallet[]> {
  const sql = db();
  const now = Date.now();
  let rows: WalletRow[];
  if (sort === "winrate") {
    rows = (await sql`
      SELECT w.address, w.first_hip3_trade_at, m.realized_pnl, m.win_rate, m.trade_count,
             m.closed_count, m.active_days, m.age_days, m.qualifies_winrate
      FROM wallet_metrics m JOIN wallet w USING (address)
      WHERE m.qualifies_winrate
      ORDER BY m.win_rate DESC LIMIT ${LEADERBOARD_LIMIT}
    `) as WalletRow[];
  } else if (sort === "activity") {
    rows = (await sql`
      SELECT w.address, w.first_hip3_trade_at, m.realized_pnl, m.win_rate, m.trade_count,
             m.closed_count, m.active_days, m.age_days, m.qualifies_winrate
      FROM wallet_metrics m JOIN wallet w USING (address)
      ORDER BY m.trade_count DESC LIMIT ${LEADERBOARD_LIMIT}
    `) as WalletRow[];
  } else {
    rows = (await sql`
      SELECT w.address, w.first_hip3_trade_at, m.realized_pnl, m.win_rate, m.trade_count,
             m.closed_count, m.active_days, m.age_days, m.qualifies_winrate
      FROM wallet_metrics m JOIN wallet w USING (address)
      ORDER BY m.realized_pnl DESC LIMIT ${LEADERBOARD_LIMIT}
    `) as WalletRow[];
  }
  return rows.map((r, i) => toWallet(r, i + 1, now));
}

// ── walletProfile ──────────────────────────────────────────────────────────
export async function walletProfile(address: string): Promise<WalletProfile | null> {
  const sql = db();
  const now = Date.now();
  const addr = address.toLowerCase();

  const wr = (await sql`
    SELECT w.address, w.first_hip3_trade_at, m.realized_pnl, m.win_rate, m.trade_count,
           m.closed_count, m.active_days, m.age_days, m.qualifies_winrate
    FROM wallet w LEFT JOIN wallet_metrics m USING (address)
    WHERE w.address = ${addr} LIMIT 1
  `) as WalletRow[];
  if (!wr.length) return null;

  // Rank within the P&L leaderboard (best-effort — a single count query).
  const rankRow = (await sql`
    SELECT count(*)::int AS ahead FROM wallet_metrics
    WHERE realized_pnl > ${wr[0].realized_pnl ?? 0}
  `) as { ahead: number }[];
  const wallet = toWallet(wr[0], (rankRow[0]?.ahead ?? 0) + 1, now);

  // CURRENT positions: live clearinghouseState (the split rule). Best-effort —
  // if the call fails, the profile still renders with historical data.
  let currentPositions: Position[] = [];
  try {
    const state = await hl.clearinghouseState(addr);
    currentPositions = state.assetPositions.map(({ position: p }) => {
      const szi = parseFloat(p.szi);
      const leveraged = (p.leverage?.value ?? 1) > 1; // §6.4: lev==1 ⇒ spot
      const notional = Math.abs(parseFloat(p.positionValue));
      const px = szi !== 0 ? notional / Math.abs(szi) : parseFloat(p.entryPx);
      return {
        symbol: tickerOf(p.coin),
        dir: leveraged ? (szi < 0 ? "short" : "long") : (szi < 0 ? "sell" : "buy"),
        leveraged,
        size: notional,
        price: px,
        entry: leveraged ? parseFloat(p.entryPx) : undefined,
        liq: leveraged && p.liquidationPx ? parseFloat(p.liquidationPx) : undefined,
        pnl: leveraged ? parseFloat(p.unrealizedPnl) : undefined,
        meta: "Open",
        status: "open",
      } as Position;
    });
  } catch {
    /* live positions unavailable → show historical only */
  }

  // HISTORICAL trades: recent fills from the store.
  const fills = (await sql`
    SELECT ticker, dir, leveraged, notional, px, closed_pnl, is_close,
           extract(epoch FROM time) * 1000 AS t
    FROM fill WHERE address = ${addr} ORDER BY time DESC LIMIT 40
  `) as { ticker: string; dir: string; leveraged: boolean; notional: number; px: number; closed_pnl: number; is_close: boolean; t: number }[];

  const historicalTrades: Position[] = fills.map((f) => {
    const d = f.dir.toLowerCase();
    const dir: Position["dir"] = d.includes("long") ? "long" : d.includes("short") ? "short"
      : d.includes("sell") ? "sell" : "buy";
    return {
      symbol: f.ticker,
      dir,
      leveraged: f.leveraged,
      size: Number(f.notional),
      price: Number(f.px),
      pnl: f.is_close ? Number(f.closed_pnl) : undefined,
      meta: f.is_close ? "Closed" : "Filled",
      status: f.is_close ? "closed" : "open",
      time: relTime(f.t, now),
    };
  });

  // Timeline: realized P&L per asset over the window.
  const tl = (await sql`
    SELECT ticker, sum(closed_pnl) AS pnl FROM fill
    WHERE address = ${addr} AND is_close
    GROUP BY ticker ORDER BY pnl DESC LIMIT 8
  `) as { ticker: string; pnl: number }[];
  const timeline: TimelineRow[] = tl.map((r) => ({ symbol: r.ticker, pnl: Number(r.pnl) }));

  const patterns = derivePatterns(fills, timeline);
  // Related wallets (§10.13) need a co-trading graph the M3 schema doesn't carry
  // yet — deferred to a hardening pass. Empty renders the section's empty state.
  const related: Related[] = [];

  return { wallet, currentPositions, historicalTrades, timeline, patterns, related };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function derivePatterns(
  fills: { ticker: string; notional: number; t: number; closed_pnl: number }[],
  timeline: TimelineRow[],
): TradingPatterns {
  const byTicker: Record<string, number> = {};
  for (const f of fills) byTicker[f.ticker] = (byTicker[f.ticker] ?? 0) + 1;
  const preferred = Object.entries(byTicker).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t).join(" · ") || "—";
  const best = timeline[0];
  // 6 UTC buckets (00/04/08/12/16/20) — when-they-trade histogram.
  const hours = [0, 0, 0, 0, 0, 0];
  for (const f of fills) hours[Math.floor((new Date(f.t).getUTCHours()) / 4) % 6]++;
  const peak = Math.max(1, ...hours);
  return {
    avgHolding: "—", // needs entry/exit pairing — deferred with related-wallets
    typicalSize: Math.round(median(fills.map((f) => Number(f.notional)))),
    preferred,
    bestAsset: best ? best.symbol : "—",
    hours: hours.map((h) => h / peak),
  };
}

// ── assetTrades ────────────────────────────────────────────────────────────
// Recent fills on one asset across all tracked wallets — the asset-detail "smart
// wallet activity" tab. Same fill→Position mapping as a wallet profile's history.
export async function assetTrades(symbol: string, n = 12): Promise<Position[]> {
  const sql = db();
  const now = Date.now();
  const rows = (await sql`
    SELECT ticker, dir, leveraged, notional, px, closed_pnl, is_close,
           extract(epoch FROM time) * 1000 AS t
    FROM fill WHERE ticker = ${symbol.toUpperCase()} ORDER BY time DESC LIMIT ${n}
  `) as { ticker: string; dir: string; leveraged: boolean; notional: number; px: number; closed_pnl: number; is_close: boolean; t: number }[];

  return rows.map((f) => {
    const d = f.dir.toLowerCase();
    const dir: Position["dir"] = d.includes("long") ? "long" : d.includes("short") ? "short"
      : d.includes("sell") ? "sell" : "buy";
    // A fill is a single execution, not a standing position — it has no entry /
    // liquidation / running P&L. Render it as a clean trade line (leveraged:false
    // suppresses TradeRow's position-detail block); the LONG/SHORT badge still
    // shows via `dir`. The time sits in the caption.
    return {
      symbol: f.ticker,
      dir,
      leveraged: false,
      size: Number(f.notional),
      price: Number(f.px),
      meta: relTime(f.t, now),
      status: "closed" as const,
      time: "",
    };
  });
}

// ── freshWallets ───────────────────────────────────────────────────────────
// New entrants (§10.14): flagged by the worker's fresh loop, joined to their
// most-recent fill for the "bought X" line.
export async function freshWallets(): Promise<FreshEntry[]> {
  const sql = db();
  const now = Date.now();
  const rows = (await sql`
    SELECT DISTINCT ON (f.address)
      f.address, f.ticker, f.dir, f.notional, f.side,
      extract(epoch FROM f.time) * 1000 AS t,
      extract(day FROM now() - w.first_hip3_trade_at)::int AS age_days
    FROM wallet w JOIN fill f USING (address)
    WHERE w.is_fresh
    ORDER BY f.address, f.time DESC
    LIMIT 24
  `) as { address: string; ticker: string; dir: string; notional: number; side: string; t: number; age_days: number }[];

  return rows
    .sort((a, b) => b.t - a.t)
    .map((r) => ({
      address: r.address,
      short: shortOf(r.address),
      symbol: r.ticker,
      side: r.dir.toLowerCase().includes("sell") || r.side === "A" ? "sell" : "buy",
      size: Number(r.notional),
      walletAgeDays: r.age_days ?? 0,
      time: relTime(r.t, now),
    }));
}
