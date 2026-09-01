// Formatting helpers. Prices/volumes in USD, clean tickers, never @N notation.

export function usd(value: number, opts?: { compact?: boolean }): string {
  if (opts?.compact) return compactUsd(value);
  const decimals = Math.abs(value) < 1 ? 4 : 2;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function signedPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function signedUsd(value: number, opts?: { cents?: boolean }): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  // Cents are noise on large whole-dollar figures (wallet P&L on tight mobile
  // columns); callers opt out with { cents: false }.
  const decimals = opts?.cents === false ? 0 : abs < 1 ? 4 : 2;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

// Directional bucket. Flat figures carry an em-dash, never a coloured zero.
export type Direction = "up" | "down" | "flat";
export function directionOf(pct: number): Direction {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}
