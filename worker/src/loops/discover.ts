// Loop 1 · Discover — the wallet universe, harvested free from the public `trades`
// WebSocket. Every trade carries users:[buyer,seller] (confirmed live 2026-08-26:
// 30/30 trades on xyz:SKHX carried a valid pair). We subscribe to each tracked
// equity coin's trades feed and upsert every address we see. This is market-data,
// bounded by the 1000-sub / 10-connection WS limit — the ~117 equity coins fit on
// one connection. No per-wallet subs (that's what the sync loop's REST polling is for).
//
// Known residual gap: a wallet whose ONLY trade falls inside a reconnect gap is
// never discovered (there's no Hyperliquid endpoint for historical global trades
// to replay against — only per-user fills, which need the address first). We
// can't close that gap, but we can shrink it (jittered backoff instead of a
// fixed 3s hammer) and make it visible (logged gap duration on reconnect,
// instead of silently resuming) — see the two review findings this addresses.

import WebSocket from "ws";
import { config } from "../config";
import { hl, classify } from "../core";
import { db } from "../db";
import { reportTick } from "../health";

type Trade = { coin: string; users?: [string, string] };
type WsMsg = { channel: string; data: Trade | Trade[] };

let ws: WebSocket | null = null;
let coins: string[] = [];
let buffer = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let stopped = false;
let lastMessageAt = 0;
let reconnectAttempt = 0;
let malformedCount = 0;

// The tracked equity coins, from the live meta filtered through the symbol universe.
async function equityCoins(): Promise<string[]> {
  const rows = await hl.metaAndAssetCtxs(config.dex);
  return rows.map((r) => r.coin).filter((c) => classify(c) !== null);
}

async function flush() {
  const hadWork = buffer.size > 0;
  if (hadWork) {
    const batch = [...buffer];
    buffer = new Set();
    try {
      const added = await db.upsertWallets(batch);
      if (added) console.log(`[discover] +${added} new wallets (${batch.length} seen)`);
    } catch (err) {
      console.error("[discover] flush failed:", (err as Error).message);
    }
  }
  reportTick("discover", config.discoverFlushMs);
}

function subscribe(sock: WebSocket) {
  for (const coin of coins) {
    sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
  }
  console.log(`[discover] subscribed to ${coins.length} equity coins`);
}

// Bounded exponential backoff with jitter for reconnects — an outage no longer
// hammers the WS endpoint on a fixed 3s timer indefinitely (review finding:
// "the retry logic treats every failure the same way" applies here too).
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
function reconnectDelay(): number {
  const exp = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

function connect() {
  if (stopped) return;
  const sock = new WebSocket(config.wsUrl);
  ws = sock;

  sock.on("open", () => {
    if (lastMessageAt) {
      const gapMs = Date.now() - lastMessageAt;
      if (gapMs > 5_000) {
        console.warn(
          `[discover] reconnected after a ${(gapMs / 1000).toFixed(1)}s gap — a wallet whose ` +
          `only trade fell in that window won't be discovered until it trades again`,
        );
      }
    }
    reconnectAttempt = 0;
    subscribe(sock);
  });
  sock.on("message", (raw) => {
    lastMessageAt = Date.now();
    let msg: WsMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      malformedCount++;
      console.warn(
        `[discover] malformed WS message #${malformedCount} (${(err as Error).message}): ` +
        raw.toString().slice(0, 200),
      );
      return;
    }
    if (msg.channel !== "trades") return;
    const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const t of trades) if (t.users) for (const u of t.users) if (u) buffer.add(u.toLowerCase());
  });
  sock.on("close", () => {
    if (stopped) return;
    const delay = reconnectDelay();
    reconnectAttempt++;
    console.warn(`[discover] WS closed — reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    setTimeout(connect, delay);
  });
  sock.on("error", (err) => console.error("[discover] WS error:", (err as Error).message));
}

export async function startDiscover() {
  coins = await equityCoins();
  connect();
  flushTimer = setInterval(flush, config.discoverFlushMs);
  refreshTimer = setInterval(async () => {
    try {
      const next = await equityCoins();
      const added = next.filter((c) => !coins.includes(c));
      coins = next;
      if (added.length && ws?.readyState === WebSocket.OPEN) {
        for (const coin of added) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
        console.log(`[discover] +${added.length} newly-listed coins`);
      }
    } catch (err) {
      console.error("[discover] coin refresh failed:", (err as Error).message);
    }
  }, config.discoverRefreshMs);
}

export async function stopDiscover() {
  stopped = true;
  if (flushTimer) clearInterval(flushTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  await flush();
  ws?.close();
}
