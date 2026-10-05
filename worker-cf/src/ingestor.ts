// The Ingestor Durable Object — the five ingestion loops as a single Cloudflare-hosted
// isolate. It reuses the SAME orchestration the Railway worker uses
// (../../src/lib/wallets/ingest.ts, which itself sits on ../../src/lib/{hl,symbols}) —
// all fetch-based/pure, so it runs unchanged in the Workers runtime. Only the
// orchestration SHELL differs from ../worker: a persistent OUTBOUND WebSocket for
// discovery, and DO Alarms in place of setInterval for the periodic loops. The two
// runtimes used to carry byte-for-byte duplicate loop bodies here; they now both call
// into src/lib/wallets/ingest.ts so a change (e.g. the sync retry/backoff policy)
// can't drift between them.
//
// Why a singleton DO: index.ts always addresses it by the fixed name "singleton", so
// there is exactly one instance = one isolate = one in-memory hl token bucket. That is
// the whole rate-budget invariant (≤1200 wt/min to Hyperliquid) preserved by design —
// never run more than one instance.

import * as hl from "../../src/lib/hl";
import { classify } from "../../src/lib/symbols";
import { FRESH_MAX_AGE_DAYS, WINDOW_DAYS } from "../../src/lib/wallets/metrics";
import { runSyncTick, runDeriveTick, runFreshTick, runRetainTick, DAY_MS, type IngestDb } from "../../src/lib/wallets/ingest";
import { makeDb, ping } from "./db";

export interface Env {
  INGESTOR: DurableObjectNamespace;
  DATABASE_URL: string;
  BOURSE_DEX?: string;
  HL_WS_URL?: string;
  SYNC_INTERVAL_MS?: string;
  SYNC_BATCH_SIZE?: string;
  SYNC_MAX_PAGES?: string;
  SYNC_CONCURRENCY?: string;
  SYNC_LEASE_MS?: string;
  DERIVE_INTERVAL_MS?: string;
  DISCOVER_FLUSH_MS?: string;
  RAW_FILLS_PER_WALLET?: string;
  FRESH_INTERVAL_MS?: string;
  BACKFILL_DAYS?: string;
  FILL_RETENTION_DAYS?: string;
}

const numEnv = (v: string | undefined, dflt: number) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
};

type Trade = { coin: string; users?: [string, string] };

// One alarm drives every loop. Each loop has an interval and a next-due timestamp;
// alarm() runs whatever is due, re-arms each, then sets the alarm to the soonest.
type Loop = "flush" | "discover" | "sync" | "derive" | "fresh" | "retain";

export class Ingestor {
  private state: DurableObjectState;
  private env: Env;
  private db: IngestDb;
  private dex: string;
  private cfg: {
    syncMs: number; syncBatch: number; syncPages: number; syncConcurrency: number; syncLeaseMs: number;
    deriveMs: number; flushMs: number; keepRaw: number; freshMs: number; backfillDays: number; retentionDays: number;
  };

  private coins: string[] = [];
  private ws: WebSocket | null = null;
  private buffer = new Set<string>();
  private ready = false;
  private lastMessageAt = 0;
  private malformedCount = 0;

  private loops: Record<Loop, { every: number; next: number }>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.db = makeDb(env.DATABASE_URL);
    this.dex = env.BOURSE_DEX ?? "xyz";
    this.cfg = {
      // Same cadence as ../worker/src/config.ts (see there for the budget math).
      syncMs: numEnv(env.SYNC_INTERVAL_MS, 30_000),
      syncBatch: numEnv(env.SYNC_BATCH_SIZE, 15),
      syncPages: numEnv(env.SYNC_MAX_PAGES, 6),
      syncConcurrency: numEnv(env.SYNC_CONCURRENCY, 4),
      syncLeaseMs: numEnv(env.SYNC_LEASE_MS, 300_000),
      deriveMs: numEnv(env.DERIVE_INTERVAL_MS, 120_000),
      flushMs: numEnv(env.DISCOVER_FLUSH_MS, 30_000),
      keepRaw: numEnv(env.RAW_FILLS_PER_WALLET, 50),
      freshMs: numEnv(env.FRESH_INTERVAL_MS, 300_000),
      backfillDays: numEnv(env.BACKFILL_DAYS, 60),
      // The 60-day metrics window plus the one partial UTC day it can reach into.
      retentionDays: numEnv(env.FILL_RETENTION_DAYS, 61),
    };
    this.loops = {
      flush: { every: this.cfg.flushMs, next: 0 },
      discover: { every: 600_000, next: 0 }, // refresh coin list + resubscribe new
      sync: { every: this.cfg.syncMs, next: 0 },
      derive: { every: this.cfg.deriveMs, next: 0 },
      fresh: { every: this.cfg.freshMs, next: 0 },
      retain: { every: DAY_MS, next: 0 }, // next:0 → also runs on first alarm tick
    };
  }

  // Any hit (cron ping or manual) ensures the DO is initialized and an alarm is armed.
  async fetch(_req: Request): Promise<Response> {
    await this.ensureStarted();
    return new Response(
      JSON.stringify({
        ok: true,
        coins: this.coins.length,
        buffered: this.buffer.size,
        malformedMessages: this.malformedCount,
        wsConnected: !!this.ws,
        lastMessageAgoMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
      }),
      { headers: { "content-type": "application/json" } },
    );
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
    await ping(this.env.DATABASE_URL);
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
    ws.addEventListener("close", () => {
      if (this.lastMessageAt) {
        const gapMs = Date.now() - this.lastMessageAt;
        if (gapMs > 5_000) {
          console.warn(`[cf] WS closed after a ${(gapMs / 1000).toFixed(1)}s-old last message — reconnect will leave a discovery gap`);
        }
      }
      this.ws = null;
    });
    ws.addEventListener("error", () => { this.ws = null; });
    for (const coin of this.coins) {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
    }
    this.ws = ws;
    console.log(`[cf] subscribed ${this.coins.length} coins`);
  }

  private onMessage(data: string | ArrayBuffer) {
    this.lastMessageAt = Date.now();
    let msg: { channel?: string; data?: Trade | Trade[] };
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch (err) {
      this.malformedCount++;
      console.warn(`[cf] malformed WS message #${this.malformedCount}: ${(err as Error).message}`);
      return;
    }
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
    if (loop === "retain") return this.retain();
  }

  // ── loops — thin wrappers over the shared src/lib/wallets/ingest.ts ─────
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

  private async sync() {
    const { totalInserted, walletsProcessed } = await runSyncTick(
      this.db,
      {
        dex: this.dex,
        maxPages: this.cfg.syncPages,
        backfillDays: this.cfg.backfillDays,
        keepRaw: this.cfg.keepRaw,
        batchSize: this.cfg.syncBatch,
        concurrency: this.cfg.syncConcurrency,
        leaseMs: this.cfg.syncLeaseMs,
      },
      (address, result) => {
        if ("error" in result) console.error(`[cf] sync ${address}:`, result.error);
      },
    );
    if (totalInserted) console.log(`[cf] sync +${totalInserted} fills / ${walletsProcessed} wallets`);
  }

  private async derive() {
    const { processed } = await runDeriveTick(this.db, { windowDays: WINDOW_DAYS });
    if (processed) console.log(`[cf] derive ${processed} wallets`);
  }

  private async fresh() {
    const changed = await runFreshTick(this.db, FRESH_MAX_AGE_DAYS);
    if (changed) console.log(`[cf] fresh flipped ${changed}`);
  }

  private async retain() {
    const deleted = await runRetainTick(this.db, { retentionDays: this.cfg.retentionDays });
    if (deleted) console.log(`[cf] retain -${deleted} fills older than ${this.cfg.retentionDays}d`);
  }
}
