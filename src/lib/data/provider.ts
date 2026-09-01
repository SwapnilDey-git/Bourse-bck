// The per-domain selector. This is what makes every phase a one-line swap:
// markets can go live while wallets stay mock, independently, via env flags.
// Server-only — imports the live modules (hl/cache); never bundled to a client.
//
//   BOURSE_MARKETS = mock | live   (default: mock)   [M1: live]
//   BOURSE_WALLETS = mock | live   (default: mock)   [Stage 2]

import type { BourseData } from "./types";
import { mockProvider } from "./mock";
import { liveProvider } from "./live";

type Source = "mock" | "live";

const MARKETS_SOURCE: Source =
  (process.env.BOURSE_MARKETS as Source) ?? (process.env.NEXT_PUBLIC_BOURSE_MARKETS as Source) ?? "mock";
const WALLETS_SOURCE: Source =
  (process.env.BOURSE_WALLETS as Source) ?? (process.env.NEXT_PUBLIC_BOURSE_WALLETS as Source) ?? "mock";

function marketsImpl(): BourseData {
  return MARKETS_SOURCE === "live" ? liveProvider : mockProvider;
}
function walletsImpl(): BourseData {
  // Wallet intelligence is Stage 2; live wallet methods are not implemented yet.
  return WALLETS_SOURCE === "live" ? liveProvider : mockProvider;
}

// Compose one BourseData whose market-methods come from the markets source and
// whose wallet-methods come from the wallets source. Freshness follows markets.
function select(): BourseData {
  const m = marketsImpl();
  const w = walletsImpl();
  return {
    markets: m.markets,
    market: m.market,
    movers: m.movers,
    watchlist: m.watchlist,
    candles: m.candles,
    orderbook: m.orderbook,
    leaderboard: w.leaderboard,
    walletProfile: w.walletProfile,
    freshWallets: w.freshWallets,
    assetTrades: w.assetTrades,
    freshness: m.freshness,
  };
}

export const provider: BourseData = select();
export function getProvider(): BourseData {
  return provider;
}

// Which source each domain resolved to — handy for a debug/status surface.
export const dataSources = { markets: MARKETS_SOURCE, wallets: WALLETS_SOURCE } as const;
