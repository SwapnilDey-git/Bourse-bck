import { describe, it, expect } from "vitest";
import { deriveMetrics, ageDaysFrom, WINDOW_DAYS, type MetricFill } from "./metrics";

const DAY_MS = 86_400_000;

describe("deriveMetrics", () => {
  it("computes realized P&L and win rate from closing fills only", () => {
    const now = Date.now();
    const fills: MetricFill[] = [
      { time: now - 1_000, closedPnl: 100, isClose: true, notional: 1_000 },
      { time: now - 2_000, closedPnl: -40, isClose: true, notional: 500 },
      { time: now - 3_000, closedPnl: 0, isClose: false, notional: 800 }, // opening fill — not a win/loss
    ];
    const m = deriveMetrics(fills, now);
    expect(m.realizedPnl).toBe(60);
    expect(m.tradeCount).toBe(3);
    expect(m.closedCount).toBe(2);
    expect(m.winRate).toBe(0.5);
  });

  it("excludes fills outside the rolling window", () => {
    const now = Date.now();
    const fills: MetricFill[] = [
      { time: now - (WINDOW_DAYS + 5) * DAY_MS, closedPnl: 1_000, isClose: true, notional: 1_000 },
      { time: now - DAY_MS, closedPnl: 10, isClose: true, notional: 100 },
    ];
    const m = deriveMetrics(fills, now);
    expect(m.tradeCount).toBe(1);
    expect(m.realizedPnl).toBe(10);
  });

  it("qualifies win-rate only at >=20 closed fills over >=30 active days", () => {
    const now = Date.now();
    const few: MetricFill[] = Array.from({ length: 5 }, (_, i) => ({
      time: now - i * DAY_MS, closedPnl: 1, isClose: true, notional: 10,
    }));
    expect(deriveMetrics(few, now).qualifiesWinRate).toBe(false);

    const many: MetricFill[] = Array.from({ length: 25 }, (_, i) => ({
      time: now - i * 2 * DAY_MS, closedPnl: 1, isClose: true, notional: 10,
    }));
    expect(deriveMetrics(many, now).qualifiesWinRate).toBe(true);
  });

  it("returns zeroed metrics for a wallet with no fills in window", () => {
    const m = deriveMetrics([], Date.now());
    expect(m).toEqual({
      realizedPnl: 0, winRate: 0, tradeCount: 0, closedCount: 0, activeDays: 0, qualifiesWinRate: false,
    });
  });
});

describe("ageDaysFrom", () => {
  it("returns 0 when there's no first-trade timestamp yet", () => {
    expect(ageDaysFrom(null, Date.now())).toBe(0);
  });
  it("floors the day count", () => {
    const now = Date.now();
    expect(ageDaysFrom(now - 10 * DAY_MS - 1000, now)).toBe(10);
  });
});
