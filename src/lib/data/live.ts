// The LiveProvider (M1) — the markets half of BourseData, composed from the
// deep modules (hl + cache + symbols). Only market methods are live; the
// selector takes wallet methods from the mock provider (Stage 2), so the wallet
// methods here are unreachable stubs. TradFi-only fields (52w, prev close,
// market cap) are null by design until the reference layer ships — the UI shows
// "—" rather than guess. 24h high/low are derived from candles per-asset.

import * as cache from "../cache";
import * as hl from "../hl";
import { classify } from "../symbols";
import * as wallets from "../wallets";
import { hasDb } from "../db";
import type {
  BourseData, Candle, FreshEntry, Interval, LeaderboardSort, MoversResult,
  OrderBook, Position, Stock, Wallet, WalletProfile,
} from "./types";

// v1 equity venue. "all HIP" enumerates every dex via perpDexs; trade.xyz holds
// >90% of equity OI, so M1 reads it directly and widens later.
const DEX = "xyz";
const TTL_MS = 5_000;

const STEP_MS: Record<Interval, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

async function fetchMarkets(): Promise<Stock[]> {
  return cache.wrap(`markets:${DEX}`, TTL_MS, async () => {
    const rows = await hl.metaAndAssetCtxs(DEX);
    const stocks: Stock[] = [];
    for (const { coin, ctx } of rows) {
      const info = classify(coin);
      if (!info) continue; // drop commodities / out-of-scope
      const price = parseFloat(ctx.markPx ?? ctx.oraclePx ?? ctx.midPx ?? "0");
      const prev = parseFloat(ctx.prevDayPx ?? "0");
      const turnover = parseFloat(ctx.dayNtlVlm ?? "0");
      if (!Number.isFinite(price) || price <= 0) continue;
      stocks.push({
        symbol: info.ticker,
        name: info.name,
        sector: info.sector,
        price,
        changePct: prev > 0 ? ((price - prev) / prev) * 100 : 0,
        turnover24h: Number.isFinite(turnover) ? turnover : 0,
        marketCap: null, // TradFi — deferred
        high24h: null, // derived per-asset in market()
        low24h: null,
        high52w: null, // TradFi — deferred
        low52w: null,
        prevClose: null,
        active: Number.isFinite(turnover) && turnover > 0,
        watchlisted: false, // device-local; wired later
      });
    }
    return stocks.sort((a, b) => b.turnover24h - a.turnover24h);
  });
}

// ticker → coin ("NVDA" → "xyz:NVDA") for per-asset calls.
async function coinFor(ticker: string): Promise<string | null> {
  const map = await cache.wrap(`coinmap:${DEX}`, 60_000, async () => {
    const rows = await hl.metaAndAssetCtxs(DEX);
    const m: Record<string, string> = {};
    for (const { coin } of rows) {
      const info = classify(coin);
      if (info) m[info.ticker] = coin;
    }
    return m;
  });
  return map[ticker.toUpperCase()] ?? null;
}

export const liveProvider: BourseData = {
  async markets(): Promise<Stock[]> {
    return fetchMarkets();
  },

  async market(symbol: string): Promise<Stock | null> {
    const stocks = await fetchMarkets();
    const found = stocks.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase());
    if (!found) return null;
    // Clone so the cached array isn't mutated, then derive real 24h high/low.
    const stock: Stock = { ...found };
    const coin = await coinFor(stock.symbol);
    if (coin) {
      try {
        const now = Date.now();
        const candles = await cache.wrap(`c24:${coin}`, TTL_MS, () =>
          hl.candleSnapshot(coin, "1h", now - 24 * 3_600_000, now)
        );
        if (candles.length) {
          stock.high24h = Math.max(...candles.map((c) => parseFloat(c.h)));
          stock.low24h = Math.min(...candles.map((c) => parseFloat(c.l)));
        }
      } catch {
        /* leave 24h hi/lo null → UI shows "—" */
      }
    }
    return stock;
  },

  async movers(n = 5): Promise<MoversResult> {
    const stocks = await fetchMarkets();
    const active = stocks.filter((s) => s.active);
    return {
      gainers: [...active].sort((a, b) => b.changePct - a.changePct).slice(0, n),
      losers: [...active].sort((a, b) => a.changePct - b.changePct).slice(0, n),
      trending: [...stocks].sort((a, b) => b.turnover24h - a.turnover24h).slice(0, n),
    };
  },

  async watchlist(): Promise<Stock[]> {
    return []; // device-local; wired in a later phase
  },

  async candles(symbol: string, interval: Interval = "1h", points = 48): Promise<Candle[]> {
    const coin = await coinFor(symbol);
    if (!coin) return [];
    const now = Date.now();
    const raw = await cache.wrap(`candles:${coin}:${interval}:${points}`, TTL_MS, () =>
      hl.candleSnapshot(coin, interval, now - points * STEP_MS[interval], now)
    );
    return raw.map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
  },

  async orderbook(symbol: string, opts?: { depth?: number; nSigFigs?: number; mantissa?: number }): Promise<OrderBook | null> {
    const depth = opts?.depth ?? 12;
    const { nSigFigs, mantissa } = opts ?? {};
    const coin = await coinFor(symbol);
    if (!coin) return null;
    // 1.2s TTL matches the ~1.5s client poll — cheap (weight 2) and deduped.
    // Key by precision so each aggregation level caches separately.
    const book = await cache.wrap(`l2:${coin}:${nSigFigs ?? 0}:${mantissa ?? 0}`, 1_200, () =>
      hl.l2Book(coin, nSigFigs, mantissa)
    );
    const rawBids = (book.levels?.[0] ?? []).slice(0, depth);
    const rawAsks = (book.levels?.[1] ?? []).slice(0, depth);
    if (!rawBids.length || !rawAsks.length) return null;
    let bt = 0;
    let at = 0;
    const bids = rawBids.map((l) => {
      const px = parseFloat(l.px);
      const size = px * parseFloat(l.sz); // USD notional
      bt += size;
      return { px, size, total: bt };
    });
    const asks = rawAsks.map((l) => {
      const px = parseFloat(l.px);
      const size = px * parseFloat(l.sz);
      at += size;
      return { px, size, total: at };
    });
    const bestBid = bids[0].px;
    const bestAsk = asks[0].px;
    const spread = bestAsk - bestBid;
    const total = bt + at || 1;
    return {
      bids,
      asks,
      spread,
      spreadPct: (spread / bestBid) * 100,
      mid: (bestBid + bestAsk) / 2,
      bidPct: (bt / total) * 100,
      askPct: (at / total) * 100,
      ts: book.time ?? Date.now(),
    };
  },

  // Wallet domain (Stage 2) — reads the worker's Neon store via src/lib/wallets.
  // Reachable only when BOURSE_WALLETS=live; without a DATABASE_URL these throw
  // rather than fabricate, so a misconfigured live flag fails loud, not silent.
  async leaderboard(sort: LeaderboardSort): Promise<Wallet[]> {
    if (!hasDb()) throw new Error("BOURSE_WALLETS=live but DATABASE_URL is unset (worker store missing)");
    return wallets.leaderboard(sort);
  },
  async walletProfile(address: string): Promise<WalletProfile | null> {
    if (!hasDb()) throw new Error("BOURSE_WALLETS=live but DATABASE_URL is unset (worker store missing)");
    return wallets.walletProfile(address);
  },
  async freshWallets(): Promise<FreshEntry[]> {
    if (!hasDb()) throw new Error("BOURSE_WALLETS=live but DATABASE_URL is unset (worker store missing)");
    return wallets.freshWallets();
  },
  async assetTrades(symbol: string, n?: number): Promise<Position[]> {
    if (!hasDb()) throw new Error("BOURSE_WALLETS=live but DATABASE_URL is unset (worker store missing)");
    return wallets.assetTrades(symbol, n);
  },

  freshness() {
    return cache.freshnessOf(`markets:${DEX}`);
  },
};
