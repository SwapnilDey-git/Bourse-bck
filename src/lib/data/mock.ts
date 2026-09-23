// Mock data for the Bourse v1 UI. Canonical price table from DESIGN.md §9.3 —
// every absolute is arithmetically derived from price and percentage.
//
// This is the `MockProvider` half of the seam: the current illustrative data,
// plus the synchronous helpers the screens use today (kept for backward compat
// and re-exported from ./index), plus `mockProvider` implementing `BourseData`.

import type {
  BourseData,
  Candle,
  FreshEntry,
  Interval,
  LeaderboardSort,
  OrderBook,
  Position,
  RecentItem,
  Related,
  Stock,
  TimelineRow,
  TradingPatterns,
  Wallet,
  WalletProfile,
} from "./types";

// absolute change from price + pct
export function absChange(s: Stock): number {
  if (s.changePct === 0) return 0;
  return s.price - s.price / (1 + s.changePct / 100);
}

export const STOCKS: Stock[] = [
  { symbol: "MSTR", name: "MicroStrategy", sector: "Technology", price: 412.9, changePct: 8.42, marketCap: 11_400_000_000, turnover24h: 88_400_000, high24h: 418.2, low24h: 379.5, high52w: 543.0, low52w: 102.4, prevClose: 380.83, active: true, watchlisted: false },
  { symbol: "MINT", name: "Bourse Mint", sector: "Digital Assets", price: 0.7812, changePct: 12.45, marketCap: 94_200_000, turnover24h: 41_900_000, high24h: 0.802, low24h: 0.688, high52w: 1.14, low52w: 0.21, prevClose: 0.6948, active: true, watchlisted: true },
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors", price: 181.24, changePct: 3.88, marketCap: 4_420_000_000_000, turnover24h: 312_700_000, high24h: 183.1, low24h: 174.6, high52w: 195.9, low52w: 86.6, prevClose: 174.47, active: true, watchlisted: true },
  { symbol: "TSLA", name: "Tesla, Inc.", sector: "Automotive", price: 415.39, changePct: 0.97, marketCap: 1_330_000_000_000, turnover24h: 268_100_000, high24h: 419.8, low24h: 408.2, high52w: 488.5, low52w: 138.8, prevClose: 411.4, active: true, watchlisted: true },
  { symbol: "MSFT", name: "Microsoft", sector: "Technology", price: 511.3, changePct: 0.83, marketCap: 3_800_000_000_000, turnover24h: 201_500_000, high24h: 514.9, low24h: 505.1, high52w: 555.4, low52w: 385.6, prevClose: 507.09, active: true, watchlisted: true },
  { symbol: "QQQ", name: "Invesco QQQ Trust", sector: "Index Fund", price: 498.02, changePct: 0.0, marketCap: null, turnover24h: 156_300_000, high24h: 499.4, low24h: 495.8, high52w: 540.1, low52w: 402.3, prevClose: 498.02, active: true, watchlisted: true },
  { symbol: "GOOGL", name: "Alphabet", sector: "Technology", price: 243.87, changePct: -1.86, marketCap: 2_960_000_000_000, turnover24h: 142_800_000, high24h: 249.6, low24h: 242.1, high52w: 258.9, low52w: 147.2, prevClose: 248.49, active: true, watchlisted: true },
  { symbol: "AAPL", name: "Apple", sector: "Technology", price: 232.18, changePct: -0.64, marketCap: 3_460_000_000_000, turnover24h: 188_200_000, high24h: 235.0, low24h: 231.2, high52w: 260.1, low52w: 169.2, prevClose: 233.68, active: true, watchlisted: true },
  { symbol: "COIN", name: "Coinbase", sector: "Financial Services", price: 318.45, changePct: 5.12, marketCap: 79_800_000_000, turnover24h: 97_600_000, high24h: 324.9, low24h: 301.7, high52w: 388.2, low52w: 142.6, prevClose: 302.94, active: true, watchlisted: false },
  { symbol: "HOOD", name: "Robinhood", sector: "Financial Services", price: 61.72, changePct: 2.34, marketCap: 54_300_000_000, turnover24h: 63_400_000, high24h: 62.8, low24h: 59.9, high52w: 68.4, low52w: 13.98, prevClose: 60.31, active: true, watchlisted: false },
  { symbol: "PLTR", name: "Palantir", sector: "Technology", price: 64.31, changePct: 4.27, marketCap: 148_900_000_000, turnover24h: 121_700_000, high24h: 65.1, low24h: 61.4, high52w: 84.8, low52w: 20.3, prevClose: 61.68, active: true, watchlisted: false },
  { symbol: "AMD", name: "Advanced Micro Devices", sector: "Semiconductors", price: 168.9, changePct: -2.71, marketCap: 273_500_000_000, turnover24h: 84_100_000, high24h: 174.6, low24h: 167.2, high52w: 227.3, low52w: 76.5, prevClose: 173.6, active: true, watchlisted: false },
  { symbol: "KO", name: "Coca-Cola", sector: "Consumer Staples", price: 69.14, changePct: 0.21, marketCap: 297_600_000_000, turnover24h: 22_800_000, high24h: 69.5, low24h: 68.7, high52w: 73.5, low52w: 60.6, prevClose: 68.99, active: true, watchlisted: false },
  { symbol: "SIRI", name: "Sirius XM", sector: "Media", price: 21.63, changePct: 0.0, marketCap: 7_320_000_000, turnover24h: 0, high24h: 21.63, low24h: 21.63, high52w: 32.1, low52w: 18.4, prevClose: 21.63, active: false, watchlisted: false },
];

export function getStock(symbol: string): Stock | undefined {
  return STOCKS.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase());
}

export const activeMarketsCount = STOCKS.filter((s) => s.active).length;
export const totalMarkets = STOCKS.length;

// Default sort: 24h turnover descending, ordering only (§10.3).
export function bySortTurnover(list: Stock[] = STOCKS): Stock[] {
  return [...list].sort((a, b) => b.turnover24h - a.turnover24h);
}

export function topGainers(n = 5): Stock[] {
  return [...STOCKS].filter((s) => s.active).sort((a, b) => b.changePct - a.changePct).slice(0, n);
}
export function topLosers(n = 5): Stock[] {
  return [...STOCKS].filter((s) => s.active).sort((a, b) => a.changePct - b.changePct).slice(0, n);
}
export function trending(n = 5): Stock[] {
  return bySortTurnover().slice(0, n);
}
export function watchlist(): Stock[] {
  return STOCKS.filter((s) => s.watchlisted);
}

// ---- Sparkline series: deterministic per ticker, biased by 24h direction.
// Pure function of the symbol → identical on server and client (no hydration drift).
export function sparkSeries(symbol: string, direction: number, points = 24): number[] {
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) % 100000;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1; // -1..1
  };
  const bias = direction > 0 ? 0.06 : direction < 0 ? -0.06 : 0;
  const out: number[] = [];
  let v = 0.5;
  for (let i = 0; i < points; i++) {
    v += rand() * 0.09 + bias * (direction === 0 ? 0 : 1);
    v = Math.max(0.05, Math.min(0.95, v));
    out.push(v);
  }
  return out;
}

// Deterministic OHLC derived from the sparkline series, banded around the
// stock's 24h range. Placeholder until M1 wires the real `candleSnapshot`;
// pure per (symbol, interval) so no hydration drift.
const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};
function mockCandles(symbol: string, interval: Interval, points: number): Candle[] {
  const s = getStock(symbol);
  const base = s?.price ?? 100;
  const dir = s ? Math.sign(s.changePct) : 0;
  const series = sparkSeries(`${symbol}:${interval}`, dir, points); // 0..1
  const lo = s?.low24h ?? base * 0.98;
  const span =
    s && s.high24h != null && s.low24h != null
      ? Math.max(s.high24h - s.low24h, base * 0.02)
      : base * 0.05;
  const step = INTERVAL_MS[interval];
  const anchor = points * step; // relative epoch; caller stamps real time downstream
  const out: Candle[] = [];
  for (let i = 0; i < points; i++) {
    const c = lo + series[i] * span;
    const o = i === 0 ? c : out[i - 1].c;
    out.push({
      t: anchor - (points - i) * step,
      o,
      h: Math.max(o, c) * 1.004,
      l: Math.min(o, c) * 0.996,
      c,
      v: 1000 + series[i] * 5000,
    });
  }
  return out;
}

// Deterministic order book banded around the stock price (USD notional sizes).
// Placeholder for mock mode; live mode uses the real l2Book.
function mockOrderbook(symbol: string, depth: number): OrderBook | null {
  const s = getStock(symbol);
  if (!s) return null;
  const price = s.price;
  const tick = price > 1000 ? 0.1 : price > 100 ? 0.05 : price > 10 ? 0.01 : 0.001;
  const series = sparkSeries(`book:${symbol}`, 0, depth * 2);
  const bids = [];
  const asks = [];
  let bt = 0;
  let at = 0;
  for (let i = 0; i < depth; i++) {
    const bsz = Math.round((0.4 + series[i]) * price * 120);
    bt += bsz;
    bids.push({ px: +(price - tick * (i + 1)).toFixed(4), size: bsz, total: bt });
    const asz = Math.round((0.4 + series[depth + i]) * price * 120);
    at += asz;
    asks.push({ px: +(price + tick * (i + 1)).toFixed(4), size: asz, total: at });
  }
  const bestBid = bids[0].px;
  const bestAsk = asks[0].px;
  const spread = +(bestAsk - bestBid).toFixed(4);
  const total = bt + at || 1;
  return {
    bids,
    asks,
    spread,
    spreadPct: (spread / bestBid) * 100,
    mid: (bestBid + bestAsk) / 2,
    bidPct: (bt / total) * 100,
    askPct: (at / total) * 100,
    ts: Date.now(),
  };
}

// ---- Wallet intelligence -------------------------------------------------

function shortOf(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function midOf(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

function wallet(
  address: string,
  rank: number,
  pnl: number,
  winRate: number,
  trades: number,
  closed: number,
  activeLabel: string,
  activeDays: number,
  ageDays: number
): Wallet {
  return {
    address,
    short: shortOf(address),
    mid: midOf(address),
    rank,
    pnl,
    winRate,
    trades,
    closed,
    activeLabel,
    activeDays,
    qualifiesWinRate: closed >= 20 && activeDays >= 30,
    ageDays,
  };
}

// Canonical leaderboard values read from the Figma master file (07 · Smart Wallets).
export const WALLETS: Wallet[] = [
  wallet("0x7a2f4b19d0c8e2a5f3719b64c2d80ff1a93bc419", 1, 412_880, 0.68, 214, 211, "11 months", 334, 334),
  wallet("0xbe3041c7d9a25f80e6b3128d4477af0c5169e7fa", 2, 288_140, 0.72, 341, 336, "1 yr 4 mo", 486, 486),
  wallet("0x1d84c05e93f7a2b16d80cc4419fe7350b2a79b02", 3, 174_905, 0.61, 88, 84, "7 months", 214, 214),
  wallet("0x92ab77f0c134e85d2bb69a0417cc83f5e60dd517", 4, 96_320, 0.64, 129, 122, "9 months", 276, 276),
  wallet("0x44c9e1b8037fa25d6c90118e4ba7fd3021c520de", 5, 61_470, 0.57, 47, 44, "4 months", 122, 122),
  wallet("0x3fd1a90c47b28e6015dd7743cc09b18f52ae88a7", 6, 38_215, 0.59, 63, 60, "5 months", 150, 150),
  wallet("0xc0479b21e5f8a4d3610cc82b74f195e0d3a71e93", 7, -12_640, 0.44, 156, 150, "8 months", 245, 245),
  wallet("0x8b5540e2c7193fd6a80b41cc25e7f309a1d64402", 8, -29_480, 0.39, 92, 88, "6 months", 182, 182),
];

export function walletByAddress(addr: string): Wallet | undefined {
  return WALLETS.find(
    (w) => w.address.toLowerCase() === addr.toLowerCase() || w.short === addr
  );
}

export const smartWalletsByPnl = () => [...WALLETS].sort((a, b) => b.pnl - a.pnl);
export const smartWalletsByWinRate = () =>
  [...WALLETS].filter((w) => w.qualifiesWinRate).sort((a, b) => b.winRate - a.winRate);
export const smartWalletsByActivity = () => [...WALLETS].sort((a, b) => b.trades - a.trades);

// ---- Positions / trades: the display rule (§6.4) -------------------------
export const CURRENT_POSITIONS: Position[] = [
  { symbol: "TSLA", dir: "long", leveraged: true, size: 96_400, price: 414.6, entry: 402.15, liq: 358.9, pnl: 21_840, meta: "Opened 3 days ago · held 3d", status: "open" },
  { symbol: "NVDA", dir: "buy", leveraged: false, size: 48_200, price: 178.3, meta: "Opened 11 days ago · held 11d", status: "open" },
  { symbol: "GOOGL", dir: "short", leveraged: true, size: 31_900, price: 246.1, entry: 248.8, liq: 271.4, pnl: -3_410, meta: "Opened 2 days ago · held 2d", status: "open" },
];

export const HISTORICAL_TRADES: Position[] = [
  { symbol: "MSFT", dir: "long", leveraged: true, size: 74_500, price: 508.2, entry: 489.6, liq: 441.1, pnl: 18_220, meta: "Closed · held 6 days", status: "closed", time: "4d ago" },
  { symbol: "TSLA", dir: "sell", leveraged: false, size: 22_150, price: 421.44, meta: "Closed · held 2 days", status: "closed", time: "9d ago" },
  { symbol: "NVDA", dir: "long", leveraged: true, size: 112_800, price: 171.05, entry: 158.4, liq: 139.9, pnl: 41_960, meta: "Closed · held 14 days", status: "closed", time: "16d ago" },
  { symbol: "AAPL", dir: "buy", leveraged: false, size: 36_700, price: 262.88, meta: "Closed · held 5 days", status: "closed", time: "23d ago" },
];

// Recent trades shown on Asset Detail wallet-activity tabs.
export const SAMPLE_TRADES: Position[] = [
  { symbol: "TSLA", dir: "long", leveraged: true, size: 128_400, price: 415.39, entry: 402.1, liq: 351.7, pnl: 24_180, meta: "2m ago", status: "open" },
  { symbol: "NVDA", dir: "buy", leveraged: false, size: 96_200, price: 181.24, meta: "14m ago", status: "open" },
  { symbol: "MSTR", dir: "long", leveraged: true, size: 212_900, price: 412.9, entry: 388.4, liq: 302.9, pnl: 41_600, meta: "31m ago", status: "open" },
  { symbol: "GOOGL", dir: "sell", leveraged: false, size: 54_700, price: 243.87, meta: "1h ago", status: "open" },
  { symbol: "COIN", dir: "short", leveraged: true, size: 71_300, price: 318.45, entry: 305.2, liq: 258.6, pnl: -8_900, meta: "2h ago", status: "open" },
];

// ---- Position timeline (§10.11): one row per asset, entries/exits + P&L ----
export const POSITION_TIMELINE: TimelineRow[] = [
  { symbol: "TSLA", pnl: 186_410 },
  { symbol: "NVDA", pnl: 148_220 },
  { symbol: "MSFT", pnl: 92_600 },
  { symbol: "GOOGL", pnl: -14_350 },
];

// ---- Trading patterns (§10.12) -------------------------------------------
export const TRADING_PATTERNS: TradingPatterns = {
  avgHolding: "4.2 days",
  typicalSize: 32_400,
  preferred: "TSLA · NVDA",
  bestAsset: "NVDA 74%",
  // when-they-trade histogram, 6 UTC buckets 00/04/08/12/16/20
  hours: [0.35, 0.4, 0.6, 1.0, 0.95, 0.7],
};

// ---- Related wallets (§10.13), capped at five ----------------------------
export const RELATED_WALLETS: Related[] = [
  { short: "0x4e91…c7d2", address: "0x4e91a2c5f8b3d6e0a4c7b9f2d5e8a1c4b7f0c7d2", overlap: 84 },
  { short: "0xa03f…1b56", address: "0xa03f7c1e4b9d2a6f0c3e8b5d1a4f7c0e3b6d1b56", overlap: 77 },
  { short: "0x67cc…90ae", address: "0x67cc0f3a9d2b5e8c1f4a7d0b3e6c9f2a5d890ae", overlap: 71 },
  { short: "0xd128…4f03", address: "0xd1284b7e0a3c6f9d2b5e8a1c4f7b0d3e6a9c4f03", overlap: 66 },
  { short: "0x9b74…e215", address: "0x9b74c1f4a7d0e3b6c9f2a5d8b1e4c7f0a3d6e215", overlap: 61 },
];

// ---- Fresh wallet feed (§6.7) --------------------------------------------
export const FRESH_FEED: FreshEntry[] = [
  { address: "0x4f8b2c6a9d1e3f5b7c0a2d4e6f8b1c3a5d7e9f02", short: "0x4f8b…9f02", symbol: "MSTR", side: "buy", size: 84_200, walletAgeDays: 2, time: "just now" },
  { address: "0xa1c5e9b3d7f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8", short: "0xa1c5…a6c8", symbol: "NVDA", side: "buy", size: 41_900, walletAgeDays: 6, time: "3m ago" },
  { address: "0x7d0f3a6c9b2e5d8f1a4c7b0e3d6f9a2c5b8e1d40", short: "0x7d0f…1d40", symbol: "TSLA", side: "buy", size: 128_600, walletAgeDays: 1, time: "8m ago" },
  { address: "0x2e6a9c1f4b7d0a3e6c9b2f5d8a1c4e7b0d3f6a90", short: "0x2e6a…6a90", symbol: "COIN", side: "sell", size: 22_400, walletAgeDays: 19, time: "15m ago" },
  { address: "0xb4d8f2a6c0e3b7d1f5a9c3e7b1d5f9a3c7e1b5d9", short: "0xb4d8…b5d9", symbol: "PLTR", side: "buy", size: 63_100, walletAgeDays: 4, time: "22m ago" },
  { address: "0x9f1c4e7a0d3b6f9c2e5a8d1b4f7c0a3e6d9b2f50", short: "0x9f1c…2f50", symbol: "HOOD", side: "buy", size: 18_700, walletAgeDays: 11, time: "34m ago" },
];

// ---- Recently viewed (§6.10) — assets AND wallets, with a context line.
export const RECENTLY_VIEWED: RecentItem[] = [
  { kind: "stock", symbol: "TSLA", context: "Asset detail · Chart", time: "3m ago" },
  { kind: "wallet", short: WALLETS[0].short, address: WALLETS[0].address, context: "Wallet profile · Positions", time: "12m ago" },
  { kind: "stock", symbol: "MSTR", context: "Asset detail · Smart wallets", time: "48m ago" },
  { kind: "stock", symbol: "NVDA", context: "Asset detail · Chart", time: "1h ago" },
  { kind: "wallet", short: WALLETS[1].short, address: WALLETS[1].address, context: "Wallet profile · Trading patterns", time: "2h ago" },
];

// ---- The MockProvider ----------------------------------------------------
// Wraps the arrays/helpers above behind the async `BourseData` contract. No
// method uses `this`, so the per-domain selector can reference them directly.

export const mockProvider: BourseData = {
  async markets() {
    return STOCKS;
  },
  async market(symbol: string) {
    return getStock(symbol) ?? null;
  },
  async movers(n = 5) {
    return { gainers: topGainers(n), losers: topLosers(n), trending: trending(n) };
  },
  async watchlist() {
    return watchlist();
  },
  async candles(symbol: string, interval: Interval = "1h", points = 48) {
    return mockCandles(symbol, interval, points);
  },
  async orderbook(symbol: string, opts?: { depth?: number; nSigFigs?: number; mantissa?: number }): Promise<OrderBook | null> {
    // Mock ignores precision (nSigFigs); live mode aggregates via the real l2Book.
    return mockOrderbook(symbol, opts?.depth ?? 12);
  },
  async leaderboard(sort: LeaderboardSort) {
    if (sort === "winrate") return smartWalletsByWinRate();
    if (sort === "activity") return smartWalletsByActivity();
    return smartWalletsByPnl();
  },
  async walletProfile(address: string): Promise<WalletProfile | null> {
    const w = walletByAddress(address);
    if (!w) return null;
    return {
      wallet: w,
      currentPositions: CURRENT_POSITIONS,
      historicalTrades: HISTORICAL_TRADES,
      timeline: POSITION_TIMELINE,
      patterns: TRADING_PATTERNS,
      related: RELATED_WALLETS,
    };
  },
  async freshWallets() {
    return FRESH_FEED;
  },
  async assetTrades() {
    return SAMPLE_TRADES;
  },
  // Mock data is always "fresh". The live cache module returns the real ts.
  freshness() {
    return { ts: Date.now(), stale: false };
  },
};
