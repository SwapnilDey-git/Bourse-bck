// symbols module (M1). Narrow face: resolve a coin string to its ticker /
// company / sector, and decide whether it belongs in Bourse's universe.
// Hides the owned table and the classification rules.

import { EQUITY_META, EXCLUDE_TICKERS, INDEX_META, INDEX_TICKERS } from "./table";

export type SymbolInfo = {
  coin: string; // "xyz:NVDA"
  ticker: string; // "NVDA"
  name: string;
  sector: string;
  kind: "equity" | "index";
};

function tickerOf(coin: string): string {
  return coin.includes(":") ? coin.split(":")[1] : coin;
}

// Returns null for coins outside the v1 scope (commodities, FX, …) — the caller
// drops them. Unknown tickers default to an equity so the grid self-updates.
export function classify(coin: string): SymbolInfo | null {
  const ticker = tickerOf(coin);
  if (EXCLUDE_TICKERS.has(ticker)) return null;

  if (INDEX_TICKERS.has(ticker)) {
    const meta = INDEX_META[ticker];
    return { coin, ticker, name: meta?.name ?? ticker, sector: meta?.sector ?? "Equity Index", kind: "index" };
  }

  const meta = EQUITY_META[ticker];
  return { coin, ticker, name: meta?.name ?? ticker, sector: meta?.sector ?? "Equity", kind: "equity" };
}
