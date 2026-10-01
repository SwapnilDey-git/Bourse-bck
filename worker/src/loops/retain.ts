// Loop 5 · Retain — prune fill_daily days and raw `fill` rows older than
// config.retentionDays so Neon storage doesn't grow forever (the 2026-09-29
// incident: an unpruned `fill` table pushed the project over its storage cap).
// Raw deletes are batched internally (db.ts) so a backlog doesn't hold one
// giant DELETE open — it catches up gradually over later ticks.

import { config } from "../config";
import { runRetainTick } from "../core";
import { db } from "../db";
import { reportTick } from "../health";

async function tick() {
  let tickError: string | undefined;
  try {
    const deleted = await runRetainTick(db, { retentionDays: config.retentionDays });
    if (deleted) console.log(`[retain] -${deleted} fills older than ${config.retentionDays}d`);
  } catch (err) {
    tickError = (err as Error).message;
    console.error("[retain] failed:", tickError);
  } finally {
    reportTick("retain", config.retainIntervalMs, tickError);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startRetain() {
  timer = setInterval(tick, config.retainIntervalMs);
  void tick();
}
export function stopRetain() {
  if (timer) clearInterval(timer);
}
