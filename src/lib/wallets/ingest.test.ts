import { describe, it, expect, vi, beforeEach } from "vitest";
import * as hlModule from "../hl";
import {
  classifyForIngestion,
  nextAttemptDelay,
  mapWithConcurrency,
  runSyncTick,
  runDeriveTick,
  runFreshTick,
  planIngest,
  type FillInsert,
  type IngestDb,
  type SyncTarget,
} from "./ingest";

describe("classifyForIngestion", () => {
  it("accepts a known ticker in the tracked dex namespace", () => {
    const info = classifyForIngestion("xyz:NVDA", "xyz");
    expect(info?.ticker).toBe("NVDA");
  });

  it("rejects a coin outside the tracked dex namespace (core-dex crypto)", () => {
    // A wallet's userFillsByTime can return fills from ANY dex it has traded
    // on, e.g. bare "BTC" from Hyperliquid's core dex — this must never be
    // absorbed as a Bourse "equity" fill just because "BTC" isn't excluded.
    expect(classifyForIngestion("BTC", "xyz")).toBeNull();
  });

  it("rejects a coin belonging to a different HIP-3 dex", () => {
    expect(classifyForIngestion("otherdex:NVDA", "xyz")).toBeNull();
  });

  it("rejects an explicitly excluded ticker within the tracked dex", () => {
    expect(classifyForIngestion("xyz:GOLD", "xyz")).toBeNull();
  });

  it("still defaults an unmapped-but-in-namespace ticker to generic equity metadata", () => {
    const info = classifyForIngestion("xyz:SOMENEWTICKER", "xyz");
    expect(info).toEqual({ coin: "xyz:SOMENEWTICKER", ticker: "SOMENEWTICKER", name: "SOMENEWTICKER", sector: "Equity", kind: "equity" });
  });
});

describe("nextAttemptDelay", () => {
  it("grows with fail count and stays capped", () => {
    const d1 = nextAttemptDelay(1);
    const d5 = nextAttemptDelay(5);
    const d20 = nextAttemptDelay(20);
    expect(d1).toBeGreaterThan(0);
    expect(d5).toBeGreaterThan(d1 / 2); // jitter makes exact ordering noisy, but scale should grow
    expect(d20).toBeLessThanOrEqual(30 * 60_000);
  });
});

describe("mapWithConcurrency", () => {
  it("processes every item exactly once, preserving result order", async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      seen.push(n);
      await new Promise((r) => setTimeout(r, n % 2 === 0 ? 1 : 0));
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(seen.sort()).toEqual(items);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

function fakeDb(overrides: Partial<IngestDb> = {}): IngestDb {
  return {
    upsertWallets: vi.fn().mockResolvedValue(0),
    claimSyncBatch: vi.fn().mockResolvedValue([]),
    ingestFills: vi.fn().mockResolvedValue(0),
    recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
    recordSyncFailure: vi.fn().mockResolvedValue(undefined),
    recomputeMetrics: vi.fn().mockResolvedValue(0),
    refreshFreshFlags: vi.fn().mockResolvedValue(0),
    pruneOldFills: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe("runSyncTick", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("records success and inserts fills for a wallet that syncs cleanly", async () => {
    const target: SyncTarget = { address: "0xabc", last_indexed_at: null };
    vi.spyOn(hlModule, "userFillsPaged").mockResolvedValue({
      fills: [
        { coin: "xyz:NVDA", px: "100", sz: "2", side: "B", time: 1000, dir: "Open Long", closedPnl: "0", fee: "0", hash: "h", oid: 1, tid: 1, startPosition: "0", crossed: true },
      ],
      drained: true,
    });
    const db = fakeDb({
      claimSyncBatch: vi.fn().mockResolvedValue([target]),
      ingestFills: vi.fn().mockResolvedValue(1),
    });

    const outcomes: Record<string, unknown> = {};
    const result = await runSyncTick(
      db,
      { dex: "xyz", maxPages: 6, backfillDays: 60, keepRaw: 50, batchSize: 15, concurrency: 4, leaseMs: 120_000 },
      (address, outcome) => { outcomes[address] = outcome; },
    );

    expect(result.totalInserted).toBe(1);
    expect(result.walletsProcessed).toBe(1);
    expect(db.recordSyncSuccess).toHaveBeenCalledWith("0xabc", 1000, 1000);
    expect(db.ingestFills).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xabc", watermark: 1000, keepRaw: 50, boundaryTids: [] }),
    );
    expect(db.recordSyncFailure).not.toHaveBeenCalled();
    expect(outcomes["0xabc"]).toEqual({ inserted: 1 });
  });

  it("records failure (not success) when a wallet's hl call throws", async () => {
    const target: SyncTarget = { address: "0xdead", last_indexed_at: null };
    vi.spyOn(hlModule, "userFillsPaged").mockRejectedValue(new Error("HL 500"));
    const db = fakeDb({ claimSyncBatch: vi.fn().mockResolvedValue([target]) });

    const result = await runSyncTick(db, { dex: "xyz", maxPages: 6, backfillDays: 60, keepRaw: 50, batchSize: 15, concurrency: 4, leaseMs: 120_000 });

    expect(result.totalInserted).toBe(0);
    expect(db.recordSyncFailure).toHaveBeenCalledWith("0xdead", "HL 500");
    expect(db.recordSyncSuccess).not.toHaveBeenCalled();
  });
});

describe("runDeriveTick", () => {
  it("delegates the whole window to one recomputeMetrics call", async () => {
    const db = fakeDb({ recomputeMetrics: vi.fn().mockResolvedValue(7) });
    await expect(runDeriveTick(db, { windowDays: 60 })).resolves.toEqual({ processed: 7 });
    expect(db.recomputeMetrics).toHaveBeenCalledWith(60);
  });
});

const DAY = 86_400_000;
function fill(tid: number, time: number, extra: Partial<FillInsert> = {}): FillInsert {
  return {
    tid, address: "0xabc", coin: "xyz:NVDA", ticker: "NVDA", side: "B", dir: "Open Long", leveraged: true,
    sz: 1, px: 100, notional: 100, closedPnl: 0, fee: 0, isClose: false, time, ...extra,
  };
}

describe("planIngest", () => {
  it("counts every row on a first sync and rolls them up per UTC day x ticker", () => {
    const rows = [
      fill(1, 10 * DAY + 1),
      fill(2, 10 * DAY + 2, { isClose: true, dir: "Close Long", closedPnl: 5 }),
      fill(3, 10 * DAY + 3, { isClose: true, dir: "Close Long", closedPnl: -2 }),
      fill(4, 11 * DAY + 1, { ticker: "TSLA", coin: "xyz:TSLA" }),
    ];
    const plan = planIngest("0xabc", rows, null, 50);
    expect(plan.boundaryTids).toEqual([]);
    const nvda = plan.daily.find((d) => d.ticker === "NVDA")!;
    expect(nvda).toMatchObject({ day: "1970-01-11", trades: 3, closes: 2, wins: 1, pnl: 3, firstMs: 10 * DAY + 1, lastMs: 10 * DAY + 3 });
    expect(plan.daily.find((d) => d.ticker === "TSLA")).toMatchObject({ day: "1970-01-12", trades: 1 });
  });

  it("skips rows older than the watermark and leaves rows AT it to raw-row dedupe", () => {
    const wm = 5_000;
    const rows = [fill(1, 4_000), fill(2, wm), fill(3, wm), fill(4, 6_000)];
    const plan = planIngest("0xabc", rows, wm, 50);
    expect(plan.daily.reduce((s, d) => s + d.trades, 0)).toBe(1); // only tid 4 is new for certain
    expect(plan.boundaryTids.sort()).toEqual([2, 3]);
    expect(plan.tail.map((r) => r.tid)).toEqual(expect.arrayContaining([2, 3, 4]));
  });

  it("keeps only the newest keepRaw rows raw, plus every row at the newest ms", () => {
    const rows = [fill(1, 1_000), fill(2, 2_000), fill(3, 3_000), fill(4, 3_000)];
    const plan = planIngest("0xabc", rows, null, 1);
    expect(plan.tail.map((r) => r.tid).sort()).toEqual([3, 4]);
    expect(plan.daily.reduce((s, d) => s + d.trades, 0)).toBe(4); // all still counted
  });
});

describe("runFreshTick", () => {
  it("delegates straight to refreshFreshFlags", async () => {
    const db = fakeDb({ refreshFreshFlags: vi.fn().mockResolvedValue(3) });
    await expect(runFreshTick(db, 30)).resolves.toBe(3);
    expect(db.refreshFreshFlags).toHaveBeenCalledWith(30);
  });
});
