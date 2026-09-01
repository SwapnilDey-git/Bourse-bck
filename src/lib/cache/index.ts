// Read-through cache + freshness (M1). In-memory for now (module-level Maps,
// which persist across requests in a single `next start` process); swaps to
// Upstash in the hardening phase behind this same tiny interface.
//
// Also the home of the serve-stale contract: if the producer throws, we return
// the last value we successfully fetched (marked stale via freshnessOf) rather
// than error to the UI. The freshness timestamp here drives the "updated Ns ago"
// badge — so staleness is honest, never cosmetic.

type Entry = { value: unknown; ts: number; ttl: number };

const fresh = new Map<string, Entry>();
const lastGood = new Map<string, { value: unknown; ts: number }>();

export async function wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = fresh.get(key);
  if (hit && now - hit.ts < hit.ttl) return hit.value as T;

  try {
    const value = await fn();
    fresh.set(key, { value, ts: now, ttl: ttlMs });
    lastGood.set(key, { value, ts: now });
    return value;
  } catch (err) {
    // serve-stale: last-good beats an error for a read-only analytics view.
    const lg = lastGood.get(key);
    if (lg) return lg.value as T;
    throw err;
  }
}

export function freshnessOf(key: string): { ts: number; stale: boolean } {
  const hit = fresh.get(key);
  if (hit) return { ts: hit.ts, stale: Date.now() - hit.ts > hit.ttl };
  const lg = lastGood.get(key);
  if (lg) return { ts: lg.ts, stale: true };
  return { ts: Date.now(), stale: true };
}
