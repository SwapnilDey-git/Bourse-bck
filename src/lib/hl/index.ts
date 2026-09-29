// The `hl` gateway (M1, REST-only). The ONLY module that knows Hyperliquid
// exists: request shaping, the shared weight budget, retry/backoff, and parsing
// all live here. Everything upstream is verified against the live API
// (see ARCHITECTURE.md §spike / DATA-SOURCES.md): metaAndAssetCtxs weighs 20,
// candleSnapshot ~3, and there are no rate-limit headers — so we account for
// weight ourselves. WS live-prices arrive in the hardening phase; polling this
// at 5s for one dex is ~240 wt/min, well under the 1200 cap.

const INFO_URL = "https://api.hyperliquid.xyz/info";

// `cache: "no-store"` defeats Next.js's fetch caching (needed for live-data freshness
// in the app), but the Cloudflare Workers runtime (workerd) throws on the `cache`
// field — "The 'cache' field on 'RequestInitializerDict' is not implemented." So we
// only attach it off-workerd; the worker has no Next fetch cache to defeat anyway.
const IS_WORKERD = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

// ---- Shared weight budget (the token bucket, in-process) -----------------
const WEIGHT_LIMIT = 1000; // hold margin under the documented 1200/min/IP
let windowStart = Date.now();
let spent = 0;

async function spend(weight: number): Promise<void> {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    spent = 0;
  }
  if (spent + weight > WEIGHT_LIMIT) {
    const wait = Math.max(0, 60_000 - (now - windowStart));
    await new Promise((r) => setTimeout(r, wait));
    windowStart = Date.now();
    spent = 0;
  }
  spent += weight;
}

// Thrown for a non-2xx HTTP response, carrying the status so callers (and the
// retry policy below) can tell "rate-limited/transient" from "our request was
// wrong" apart — a network-level throw (DNS, timeout, connection reset) is a
// plain Error and always retried.
export class HlHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HlHttpError";
  }
}

// Only retry what retrying can plausibly fix: a transient network failure, a
// rate limit (429), or the server's own 5xx. A 4xx other than 429 means our
// request was malformed or unauthorized — retrying it three times just burns
// weight budget to reproduce the same error (review finding: "the retry logic
// treats every failure the same way").
function isRetryable(err: unknown): boolean {
  if (err instanceof HlHttpError) return err.status === 429 || err.status >= 500;
  return true;
}

async function postInfo<T>(body: object, weight: number, attempt = 0): Promise<T> {
  await spend(weight);
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (!IS_WORKERD) (init as { cache?: string }).cache = "no-store";
    const res = await fetch(INFO_URL, init);
    if (!res.ok) throw new HlHttpError(res.status, `HL ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (attempt < 3 && isRetryable(err)) {
      const backoff = 250 * 2 ** attempt; // 250 / 500 / 1000ms
      const jittered = backoff * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jittered));
      return postInfo<T>(body, weight, attempt + 1);
    }
    throw err;
  }
}

// ---- Typed responses -----------------------------------------------------

export type AssetCtx = {
  dayNtlVlm?: string;
  markPx?: string;
  midPx?: string;
  prevDayPx?: string;
  oraclePx?: string;
  openInterest?: string;
};
type UniverseItem = { name: string; szDecimals?: number; maxLeverage?: number };
export type RawCandle = { t: number; T?: number; o: string; c: string; h: string; l: string; v: string };
export type PerpDex = { name: string; full_name?: string; deployer?: string } | null;

// One row per coin on a builder dex: the coin string (e.g. "xyz:NVDA") + its ctx.
export async function metaAndAssetCtxs(dex: string): Promise<{ coin: string; ctx: AssetCtx }[]> {
  const [meta, ctxs] = await postInfo<[{ universe: UniverseItem[] }, AssetCtx[]]>(
    { type: "metaAndAssetCtxs", dex },
    20
  );
  return meta.universe.map((u, i) => ({ coin: u.name, ctx: ctxs[i] ?? {} }));
}

export async function candleSnapshot(
  coin: string,
  interval: string,
  startTime: number,
  endTime: number
): Promise<RawCandle[]> {
  return postInfo<RawCandle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, 3);
}

// Enumerate builder dexes (index 0 is null = the core dex). Used to go "all HIP".
export async function perpDexs(): Promise<PerpDex[]> {
  return postInfo<PerpDex[]>({ type: "perpDexs" }, 20);
}

// ---- Wallet endpoints (Stage 2 · used by the worker indexer + M1b profiles) --
// These stay in the REST-only gateway so both the always-on worker and the Next
// wallet-profile pages share ONE token bucket. The worker polls userFillsByTime
// (heavy, ≈25 wt — the leaderboard's whole cost); profile pages read the cheap
// live clearinghouseState (wt 2) for CURRENT positions, per the split rule.

// One historical fill. `tid` is HL's globally-unique trade id → the fill PK.
// `dir` is the human label ("Open Long" / "Close Short" / "Buy" / "Sell");
// `closedPnl` is realized P&L on a closing fill; `hash`/`oid` identify the order.
export type Fill = {
  coin: string;
  px: string;
  sz: string;
  side: string;      // "B" | "A"
  time: number;      // ms
  dir: string;
  closedPnl: string;
  fee: string;
  hash: string;
  oid: number;
  tid: number;
  startPosition: string;
  crossed: boolean;
};

// userFillsByTime — the indexer's sync call. Bounded window per request; the
// worker walks it forward from each wallet's last_indexed watermark. Weight ≈25,
// so this is the budget-dominating call (IMPLEMENTATION.md §5.4). aggregateByTime
// keeps partial fills of one order collapsed.
export async function userFillsByTime(
  user: string,
  startTime: number,
  endTime?: number
): Promise<Fill[]> {
  const req: Record<string, unknown> = { type: "userFillsByTime", user, startTime, aggregateByTime: true };
  if (endTime != null) req.endTime = endTime;
  return postInfo<Fill[]>(req, 25);
}

// Paginate userFillsByTime forward through the 2000-fill depth cap, returning ALL
// fills in [startTime, endTime] (oldest-first, de-duped by tid).
//
// Verified against the live API 2026-08-27: a single call returns the OLDEST 2000
// fills from startTime in ASCENDING time order — so to drain a wallet past the cap
// we advance startTime to just after the newest fill we've seen and re-request. A
// page shorter than the cap means we've reached the end. `maxPages` bounds the cost
// of one drain (a hyperactive wallet can span hundreds of pages); the caller resumes
// from its persisted watermark on the next pass, so partial progress is never lost.
export async function userFillsPaged(
  user: string,
  startTime: number,
  opts?: { endTime?: number; maxPages?: number },
): Promise<{ fills: Fill[]; drained: boolean }> {
  const maxPages = opts?.maxPages ?? 200;
  const out: Fill[] = [];
  const seen = new Set<number>();
  let cursor = startTime;
  let drained = false;
  for (let page = 0; page < maxPages; page++) {
    const batch = await userFillsByTime(user, cursor, opts?.endTime);
    let maxT = cursor;
    for (const f of batch) {
      if (seen.has(f.tid)) continue;
      seen.add(f.tid);
      out.push(f);
      if (f.time > maxT) maxT = f.time;
    }
    if (batch.length < 2000) { drained = true; break; } // reached the end of history
    if (maxT <= cursor) { drained = true; break; }       // no forward progress (guard)
    cursor = maxT + 1;
  }
  return { fills: out, drained };
}

// One open position from clearinghouseState. Perp positions carry entryPx /
// liquidationPx / unrealizedPnl / leverage; szi<0 = short. All HIP-3 equities are
// perps underneath, so leverage.value==1 is the spot-display heuristic (§6.4).
export type ClearingPosition = {
  coin: string;
  szi: string;                 // signed size; <0 short
  entryPx: string;
  liquidationPx: string | null;
  positionValue: string;       // USD notional
  unrealizedPnl: string;
  leverage: { type: string; value: number };
};
export type ClearinghouseState = {
  assetPositions: { position: ClearingPosition }[];
  marginSummary: { accountValue: string; totalNtlPos: string };
  time?: number;
};

// clearinghouseState — a wallet's CURRENT open positions, live. Cheap (wt 2), so
// profile pages call it on the request path behind a short cache; historical
// trades/metrics come from Postgres instead.
export async function clearinghouseState(user: string, dex?: string): Promise<ClearinghouseState> {
  const req: Record<string, unknown> = { type: "clearinghouseState", user };
  if (dex) req.dex = dex;
  return postInfo<ClearinghouseState>(req, 2);
}
