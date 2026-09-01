// The seam (M0). This file is the ONLY contract the app codes against once the
// migration completes: `BourseData` is the narrow interface every screen reads
// through, and the domain shapes it returns. Two implementations satisfy it —
// `MockProvider` (today) and, from M1, a `LiveProvider` composed of the deep
// modules (hl / cache / symbols / wallets). See ARCHITECTURE.md and IMPLEMENTATION.md.

// ---- Market shapes -------------------------------------------------------

export type Stock = {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePct: number; // 24h
  marketCap: number | null; // null = "market cap unavailable" (designed absence)
  turnover24h: number; // used internally for default sort (§10.3)
  // null = designed absence → UI shows "—". Live: 24h hi/lo derived from candles
  // per-asset; 52w range + prev TradFi close are deferred (reference layer).
  high24h: number | null;
  low24h: number | null;
  high52w: number | null;
  low52w: number | null;
  prevClose: number | null;
  active: boolean; // false = no 24h trade → muted + NO 24H TRADE badge (§10.19)
  watchlisted: boolean;
};

export type Interval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type MoversResult = { gainers: Stock[]; losers: Stock[]; trending: Stock[] };

// One order-book level. `size`/`total` are USD notional (px × contracts, cumulative)
// — Bourse shows everything in USD.
export type OrderLevel = { px: number; size: number; total: number };
export type OrderBook = {
  bids: OrderLevel[]; // best (highest px) first
  asks: OrderLevel[]; // best (lowest px) first
  spread: number;
  spreadPct: number;
  mid: number;
  bidPct: number; // buy-side share of shown depth, 0..100
  askPct: number;
  ts: number;
};

// ---- Wallet-intelligence shapes ------------------------------------------

export type Wallet = {
  address: string; // full
  short: string; // 0x7a2f…c419 short form
  mid: string; // 0x7a2f4b19…a93bc419 middle-truncated (header)
  rank: number;
  pnl: number; // total P&L, USD
  winRate: number; // 0..1
  trades: number; // total positions
  closed: number; // closed positions (for "of N closed")
  activeLabel: string; // "11 months", "1 yr 4 mo"
  activeDays: number;
  qualifiesWinRate: boolean; // ≥20 closed over ≥30 days (§10.10)
  ageDays: number; // onchain age (fresh = <30)
};

// Leveraged positions are LONG/SHORT and carry ENTRY / LIQ. / P&L; spot
// positions are BUY/SELL and show only the trade (§6.4).
export type Position = {
  symbol: string;
  dir: "long" | "short" | "buy" | "sell";
  leveraged: boolean;
  size: number; // notional USD
  price: number; // mark / fill price
  entry?: number;
  liq?: number;
  pnl?: number;
  meta: string; // "Opened 3 days ago · held 3d" | "Closed · held 6 days"
  status: "open" | "closed";
  time?: string; // "4d ago" for closed
};

export type TimelineRow = { symbol: string; pnl: number };

export type TradingPatterns = {
  avgHolding: string;
  typicalSize: number;
  preferred: string;
  bestAsset: string;
  hours: number[]; // when-they-trade histogram, 6 UTC buckets
};

export type Related = { short: string; address: string; overlap: number };

export type FreshEntry = {
  short: string;
  address: string;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  walletAgeDays: number;
  time: string;
};

export type RecentItem =
  | { kind: "stock"; symbol: string; context: string; time: string }
  | { kind: "wallet"; short: string; address: string; context: string; time: string };

// A wallet's full profile — everything the /wallets/[address] screen needs.
export type WalletProfile = {
  wallet: Wallet;
  currentPositions: Position[];
  historicalTrades: Position[];
  timeline: TimelineRow[];
  patterns: TradingPatterns;
  related: Related[];
};

// ---- The contract --------------------------------------------------------

export type LeaderboardSort = "pnl" | "winrate" | "activity";

// Cache-freshness for a given read — drives the UI's "updated Ns ago / stale"
// badge (§10.2). Mock returns fresh; the live cache module returns the real ts.
export type Freshness = { ts: number; stale: boolean };

// The narrow interface the whole UI hides behind. Implementations must be
// swappable per-domain (markets live while wallets stay mock, etc.).
export interface BourseData {
  // markets
  markets(): Promise<Stock[]>;
  market(symbol: string): Promise<Stock | null>;
  movers(n?: number): Promise<MoversResult>;
  watchlist(): Promise<Stock[]>;
  candles(symbol: string, interval?: Interval, points?: number): Promise<Candle[]>;
  orderbook(symbol: string, opts?: { depth?: number; nSigFigs?: number; mantissa?: number }): Promise<OrderBook | null>;
  // wallet intelligence
  leaderboard(sort: LeaderboardSort): Promise<Wallet[]>;
  walletProfile(address: string): Promise<WalletProfile | null>;
  freshWallets(): Promise<FreshEntry[]>;
  // recent trades on one asset by tracked wallets (asset-detail §6.4 "smart" tab)
  assetTrades(symbol: string, n?: number): Promise<Position[]>;
  // meta
  freshness(key: string): Freshness;
}
