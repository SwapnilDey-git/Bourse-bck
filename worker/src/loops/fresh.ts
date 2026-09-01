// Loop 4 · Fresh-flag — maintain the <30-day "fresh wallet" set (§10.14). A wallet
// is fresh when its earliest indexed HIP-3 equity trade is under FRESH_MAX_AGE_DAYS
// old; it ages out automatically. One SQL statement flips only the rows that changed,
// so this is cheap even over the whole table.

import { config } from "../config";
import { FRESH_MAX_AGE_DAYS } from "../core";
import { refreshFreshFlags } from "../db";

async function tick() {
  try {
    const changed = await refreshFreshFlags(FRESH_MAX_AGE_DAYS);
    if (changed) console.log(`[fresh] flipped is_fresh on ${changed} wallets`);
  } catch (err) {
    console.error("[fresh] failed:", (err as Error).message);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startFresh() {
  timer = setInterval(tick, config.freshIntervalMs);
  void tick();
}
export function stopFresh() {
  if (timer) clearInterval(timer);
}
