import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearinghouseState, HlHttpError } from "./index";

function mockResponses(statuses: number[]) {
  let call = 0;
  return vi.fn(async () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call++;
    if (status >= 200 && status < 300) {
      return new Response(JSON.stringify({ assetPositions: [], marginSummary: { accountValue: "0", totalNtlPos: "0" } }), { status });
    }
    return new Response("nope", { status });
  });
}

describe("hl retry classification", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("retries a 500 and eventually succeeds", async () => {
    const fetchMock = mockResponses([500, 500, 200]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = clearinghouseState("0xabc");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 (rate limit)", async () => {
    const fetchMock = mockResponses([429, 200]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = clearinghouseState("0xabc");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 — fails fast instead of burning the retry budget", async () => {
    const fetchMock = mockResponses([400, 200]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = clearinghouseState("0xabc");
    const assertion = expect(promise).rejects.toThrow(HlHttpError); // attach before awaiting timers
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 retries on a persistent 500", async () => {
    const fetchMock = mockResponses([500, 500, 500, 500]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = clearinghouseState("0xabc");
    const assertion = expect(promise).rejects.toThrow(HlHttpError); // attach before awaiting timers
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});

// The weight budget is module state, so each test imports a fresh copy.
describe("hl weight budget", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  const fills = (n: number) => Array.from({ length: n }, (_, i) => ({ tid: i, time: i }));
  const okJson = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("reserves a full page per call, so concurrent pages can't overshoot the minute", async () => {
    const { userFillsByTime } = await import("./index");
    const fetchMock = okJson(fills(2000)); // 20 + 2000/20 = 120 wt per call
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // 10 concurrent full pages: 8 × 120 = 960 fit, the 9th would cross 1000.
    const calls = Array.from({ length: 10 }, () => userFillsByTime("0xabc", 0));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    await Promise.all(calls);
  });

  it("refunds the reservation when a page comes back small", async () => {
    const { userFillsByTime } = await import("./index");
    const fetchMock = okJson(fills(5)); // actual cost 20
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Sequential, like the pager: each call reserves 120 and refunds 100, so
    // 45 calls fit in one minute (44 × 20 booked + 120 reserved = 1000) —
    // without the refund only 8 would.
    for (let i = 0; i < 45; i++) {
      const p = userFillsByTime("0xabc", 0);
      await vi.advanceTimersByTimeAsync(10); // body parsing needs the fake clock to move
      await p;
    }
    expect(fetchMock).toHaveBeenCalledTimes(45);
    const blocked = userFillsByTime("0xabc", 0); // 900 + 120 > 1000
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(45);
    await vi.advanceTimersByTimeAsync(60_000);
    await blocked;
    expect(fetchMock).toHaveBeenCalledTimes(46);
  });

  it("a 429 makes the retry wait for a fresh window, not ~250ms", async () => {
    const { clearinghouseState } = await import("./index");
    const fetchMock = mockResponses([429, 200]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = clearinghouseState("0xabc");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting out the window
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBeDefined();
  });
});
