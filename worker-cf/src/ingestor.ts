// The Ingestor Durable Object — the four ingestion loops as a single Cloudflare-hosted
// isolate. It reuses the SAME deep modules the Railway worker and the Next app use
// (../../src/lib/{hl,symbols,wallets/metrics}) — all fetch-based/pure, so they run
// unchanged in the Workers runtime. Only the orchestration shell differs from
// ../worker: a persistent OUTBOUND WebSocket for discovery, and DO Alarms in place of
// setInterval for the periodic loops.
//
// Why a singleton DO: index.ts always addresses it by the fixed name "singleton", so
// there is exactly one instance = one isolate = one in-memory hl token bucket. That is
// the whole rate-budget invariant (≤1200 wt/min to Hyperliquid) preserved by design —
// never run more than one instance.

import * as hl from "../../src/lib/hl";
import { classify } from "../../src/lib/symbols";
import { deriveMetrics, ageDaysFrom, WINDOW_DAYS, FRESH_MAX_AGE_DAYS } from "../../src/lib/wallets/metrics";
import { makeDb, sinceWindow, type Db, type FillInsert, type SyncTarget } from "./db";

export interface Env {
  INGESTOR: DurableObjectNamespace;
  DATABASE_URL: string;
  BOURSE_DEX?: string;
  HL_WS_URL?: string;
  SYNC_INTERVAL_MS?: string;
  SYNC_BATCH_SIZE?: string;
  SYNC_MAX_PAGES?: string;
  DERIVE_INTERVAL_MS?: string;
  FRESH_INTERVAL_MS?: string;
  BACKFILL_DAYS?: string;
}

const numEnv = (v: string | undefined, dflt: number) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
};

type Trade = { coin: string; users?: [string, string] };

// One alarm drives every loop. Each loop has an interval and a next-due timestamp;
// alarm() runs whatever is due, re-arms each, then sets the alarm to the soonest.
type Loop = "flush" | "discover" | "sync" | "derive" | "fresh";

export class Ingestor {
  private state: DurableObjectState;
  private env: Env;
  private db: Db;
  private dex: string;
  private cfg: { syncMs: number; syncBatch: number; syncPages: number; deriveMs: number; freshMs: number; backfillDays: number };

  private coins: string[] = [];
  private ws: WebSocket | null = null;
  private buffer = new Set<string>();
  private ready = false;

  private loops: Record<Loop, { every: number; next: number }>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.db = makeDb(env.DATABASE_URL);
    this.dex = env.BOURSE_DEX ?? "xyz";
    this.cfg = {
      syncMs: numEnv(env.SYNC_INTERVAL_MS, 30_000),
      syncBatch: numEnv(env.SYNC_BATCH_SIZE, 15),
      syncPages: numEnv(env.SYNC_MAX_PAGES, 6),
      deriveMs: numEnv(env.DERIVE_INTERVAL_MS, 60_000),
      freshMs: numEnv(env.FRESH_INTERVAL_MS, 300_000),
      backfillDays: numEnv(env.BACKFILL_DAYS, 60),
    };
    this.loops = {
      flush: { every: 5_000, next: 0 },
      discover: { every: 600_000, next: 0 }, // refresh coin list + resubscribe new
      sync: { every: this.cfg.syncMs, next: 0 },
      derive: { every: this.cfg.deriveMs, next: 0 },
      fresh: { every: this.cfg.freshMs, next: 0 },
    };
  }

  // Any hit (cron ping or manual) ensures the DO is initialized and an alarm is armed.
  async fetch(_req: Request): Promise<Response> {
    await this.ensureStarted();
    const counts = await this.snapshot().catch(() => null);
    return new Response(JSON.stringify({ ok: true, coins: this.coins.length, buffered: this.buffer.size, counts }), {
      headers: { "content-type": "application/json" },
    });
  }

  private async ensureStarted() {
    if (!this.ready) {
      await this.init();
      this.ready = true;
    }
    // Arm the alarm if none is pending (e.g. after an eviction).
    const existing = await this.state.storage.getAlarm();
    if (existing === null) await this.state.storage.setAlarm(Date.now() + 1_000);
    if (!this.ws) await this.connectWS().catch((e) => console.error("[cf] WS connect:", (e as Error).message));
  }

  private async init() {
    await this.db.ping();
    this.coins = await this.equityCoins();
    console.log(`[cf] init · dex=${this.dex} · ${this.coins.length} equity coins`);
  }

  private async equityCoins(): Promise<string[]> {
    const rows = await hl.metaAndAssetCtxs(this.dex);
    return rows.map((r) => r.coin).filter((c) => classify(c) !== null);
  }

  // ── outbound WebSocket (discover) ────────────────────────────────────────
  private async connectWS() {
    // Cloudflare's outbound-WS pattern upgrades an HTTP(S) fetch — the URL scheme
    // must be https/http, NOT wss/ws (workerd rejects wss:// here). Normalize so an
    // env override written as wss:// still works.
    const raw = this.env.HL_WS_URL ?? "https://api.hyperliquid.xyz/ws";
    const url = raw.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
    const resp = await fetch(url, { headers: { Upgrade: "websocket" } });
    const ws = resp.webSocket;
    if (!ws) throw new Error(`WS upgrade failed (status ${resp.status})`);
    ws.accept();
    ws.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
    ws.addEventListener("close", () => { this.ws = null; });
    ws.addEventListener("error", () => { this.ws = null; });
    for (const coin of this.coins) {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
    }
    this.ws = ws;
    console.log(`[cf] subscribed ${this.coins.length} coins`);
  }

  private onMessage(data: string | ArrayBuffer) {
    let msg: { channel?: string; data?: Trade | Trade[] };
    try { msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)); } catch { return; }
    if (msg.channel !== "trades" || !msg.data) return;
    const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const t of trades) for (const u of t.users ?? []) if (u) this.buffer.add(u.toLowerCase());
  }

  // ── the alarm dispatcher ─────────────────────────────────────────────────
  async alarm() {
    if (!this.ready) { await this.init(); this.ready = true; }
    if (!this.ws) await this.connectWS().catch((e) => console.error("[cf] WS reconnect:", (e as Error).message));

    const now = Date.now();
    for (const name of Object.keys(this.loops) as Loop[]) {
      const l = this.loops[name];
      if (l.next <= now) {
        try { await this.run(name); }
        catch (e) { console.error(`[cf] ${name}:`, (e as Error).message); }
        l.next = Date.now() + l.every;
      }
    }
    const soonest = Math.min(...Object.values(this.loops).map((l) => l.next));
    await this.state.storage.setAlarm(soonest);
  }

  private async run(loop: Loop) {
    if (loop === "flush") return this.flush();
    if (loop === "discover") return this.refreshCoins();
    if (loop === "sync") return this.sync();
    if (loop === "derive") return this.derive();
    if (loop === "fresh") return this.fresh();
  }

  // ── loops (same logic as ../worker/src/loops/*) ──────────────────────────
  private async flush() {
    if (!this.buffer.size) return;
    const batch = [...this.buffer];
    this.buffer = new Set();
    const added = await this.db.upsertWallets(batch);
    if (added) console.log(`[cf] discover +${added} new (${batch.length} seen)`);
  }

  private async refreshCoins() {
    const next = await this.equityCoins();
    const added = next.filter((c) => !this.coins.includes(c));
    this.coins = next;
    if (added.length && this.ws) {
      for (const coin of added) this.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
      console.log(`[cf] +${added.length} newly-listed coins`);
    }
  }

  private watermarkOf(t: SyncTarget): number {
    return t.last_indexed_at ? Date.parse(t.last_indexed_at) : sinceWindow(this.cfg.backfillDays);
  }

  private async sync() {
    const batch = await this.db.syncBatch(this.cfg.syncBatch);
    let total = 0;
    for (const t of batch) {
      try {
        const start = this.watermarkOf(t);
        const { fills } = await hl.userFillsPaged(t.address, start, { maxPages: this.cfg.syncPages });
        const rows: FillInsert[] = [];
        let earliest: number | null = null;
        for (const f of fills) {
          const info = classify(f.coin);
          if (!info) continue;
          const sz = parseFloat(f.sz), px = parseFloat(f.px);
          rows.push({
            tid: f.tid, address: t.address, coin: f.coin, ticker: info.ticker,
            side: f.side, dir: f.dir, leveraged: true, sz, px, notional: sz * px,
            closedPnl: parseFloat(f.closedPnl || "0"), fee: parseFloat(f.fee || "0"),
            isClose: /^close/i.test(f.dir), time: f.time,
          });
          if (earliest === null || f.time < earliest) earliest = f.time;
        }
        total += await this.db.insertFills(rows);
        const newest = fills.length ? Math.max(...fills.map((f) => f.time)) : Date.now();
        await this.db.markIndexed(t.address, newest, earliest);
      } catch (e) {
        console.error(`[cf] sync ${t.address}:`, (e as Error).message);
      }
    }
    if (total) console.log(`[cf] sync +${total} fills / ${batch.length} wallets`);
  }

  private async derive() {
    const now = Date.now();
    const since = sinceWindow(WINDOW_DAYS);
    const candidates = await this.db.metricsCandidates(since, 200);
    for (const { address } of candidates) {
      try {
        const raw = await this.db.fillsForDerive(address, since);
        const m = deriveMetrics(
          raw.map((f) => ({ time: Number(f.time), closedPnl: Number(f.closed_pnl), isClose: f.is_close, notional: Number(f.notional) })),
          now,
        );
        const firstMs = await this.db.firstTradeMs(address);
        await this.db.upsertMetrics({ address, ...m, ageDays: ageDaysFrom(firstMs, now) });
      } catch (e) {
        console.error(`[cf] derive ${address}:`, (e as Error).message);
      }
    }
    if (candidates.length) console.log(`[cf] derive ${candidates.length} wallets`);
  }

  private async fresh() {
    const changed = await this.db.refreshFreshFlags(FRESH_MAX_AGE_DAYS);
    if (changed) console.log(`[cf] fresh flipped ${changed}`);
  }

  private async snapshot() {
    // best-effort health counts for the /ping response
    const [w] = await this.db.syncBatch(1);
    return { hasWallets: !!w };
  }
}
