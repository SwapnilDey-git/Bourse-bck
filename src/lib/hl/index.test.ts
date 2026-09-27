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
