// Loop 1 · Discover — the wallet universe, harvested free from the public `trades`
// WebSocket. Every trade carries users:[buyer,seller] (confirmed live 2026-08-26:
// 30/30 trades on xyz:SKHX carried a valid pair). We subscribe to each tracked
// equity coin's trades feed and upsert every address we see. This is market-data,
// bounded by the 1000-sub / 10-connection WS limit — the ~117 equity coins fit on
// one connection. No per-wallet subs (that's what the sync loop's REST polling is for).

import WebSocket from "ws";
import { config } from "../config";
import { hl, classify } from "../core";
import { upsertWallets } from "../db";

type Trade = { coin: string; users?: [string, string] };
type WsMsg = { channel: string; data: Trade | Trade[] };

let ws: WebSocket | null = null;
let coins: string[] = [];
let buffer = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let stopped = false;

// The tracked equity coins, from the live meta filtered through the symbol universe.
async function equityCoins(): Promise<string[]> {
  const rows = await hl.metaAndAssetCtxs(config.dex);
  return rows.map((r) => r.coin).filter((c) => classify(c) !== null);
}

async function flush() {
  if (!buffer.size) return;
  const batch = [...buffer];
  buffer = new Set();
  try {
    const added = await upsertWallets(batch);
    if (added) console.log(`[discover] +${added} new wallets (${batch.length} seen)`);
  } catch (err) {
    console.error("[discover] flush failed:", (err as Error).message);
  }
}

function subscribe(sock: WebSocket) {
  for (const coin of coins) {
    sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
  }
  console.log(`[discover] subscribed to ${coins.length} equity coins`);
}

function connect() {
  if (stopped) return;
  const sock = new WebSocket(config.wsUrl);
  ws = sock;

  sock.on("open", () => subscribe(sock));
  sock.on("message", (raw) => {
    let msg: WsMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.channel !== "trades") return;
    const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const t of trades) {
      if (t.users) for (const u of t.users) if (u) buffer.add(u.toLowerCase());
    }
  });
  sock.on("close", () => {
    if (stopped) return;
    console.warn("[discover] WS closed — reconnecting in 3s");
    setTimeout(connect, 3_000);
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
