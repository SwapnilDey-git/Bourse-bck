// Pure wallet-intelligence derivation — NO I/O, NO framework imports. Shared by
// both the worker's derive loop (which writes wallet_metrics) and the Next read
// model (which formats display fields). Keeping it pure means the same numbers
// the worker persists are the numbers the UI shows — one definition of "P&L".
//
// The 60-day rolling window and the win-rate qualification (§10.10) are encoded
// here so both sides agree.

export const WINDOW_DAYS = 60;
export const FRESH_MAX_AGE_DAYS = 30; // <30d onchain age → "fresh" (§10.14)
const DAY_MS = 86_400_000;

// A fill as the derivation needs it (subset of hl.Fill, already numeric).
export type MetricFill = {
  time: number;        // ms
  closedPnl: number;
  isClose: boolean;    // dir starts with "Close"
  notional: number;    // sz*px USD
};

export type WalletMetrics = {
  realizedPnl: number;
  winRate: number;     // 0..1
  tradeCount: number;
  closedCount: number;
  activeDays: number;
  qualifiesWinRate: boolean;
};

// Compute the leaderboard metrics for one wallet over the 60-day window.
// `now` is passed in (never Date.now() inline) so the worker controls the clock.
export function deriveMetrics(fills: MetricFill[], now: number): WalletMetrics {
  const since = now - WINDOW_DAYS * DAY_MS;
  const inWindow = fills.filter((f) => f.time >= since);

  const closed = inWindow.filter((f) => f.isClose);
  const wins = closed.filter((f) => f.closedPnl > 0).length;
  const realizedPnl = closed.reduce((s, f) => s + f.closedPnl, 0);

  let activeDays = 0;
  if (inWindow.length) {
    const first = Math.min(...inWindow.map((f) => f.time));
    const last = Math.max(...inWindow.map((f) => f.time));
    activeDays = Math.max(1, Math.round((last - first) / DAY_MS));
  }

  const closedCount = closed.length;
  const winRate = closedCount ? wins / closedCount : 0;

  return {
    realizedPnl,
    winRate,
    tradeCount: inWindow.length,
    closedCount,
    activeDays,
    // §10.10 — win-rate only ranks wallets with a meaningful sample.
    qualifiesWinRate: closedCount >= 20 && activeDays >= 30,
  };
}

// Onchain age in days from the earliest indexed HIP-3 equity fill.
export function ageDaysFrom(firstTradeMs: number | null, now: number): number {
  if (!firstTradeMs) return 0;
  return Math.max(0, Math.floor((now - firstTradeMs) / DAY_MS));
}

// ---- Display formatting (mirrors mock.ts so live/mock render identically) ----

export function shortOf(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function midOf(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

// "11 months" / "1 yr 4 mo" / "18 days" — the active-for label (§07 Smart Wallets).
export function activeLabel(days: number): string {
  if (days < 60) {
    const d = Math.max(1, days);
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  const months = Math.round(days / 30);
  if (months < 12) return `${months} months`;
  const yr = Math.floor(months / 12);
  const mo = months % 12;
  return mo ? `${yr} yr ${mo} mo` : `${yr} yr`;
}

// "2m ago" / "3d ago" — relative time for fresh-feed + closed fills.
export function relTime(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
