# Bourse Stage-2 Worker

The always-on ingestion service — lane ④ of the frontend repo's `ARCHITECTURE.md · Diagram B`.
It turns Hyperliquid's public feeds into the precomputed Smart-Wallets leaderboard + fresh feed
that the Next Read API serves. **The browser and the Vercel Read API never run any of
this** — they only read the Neon Postgres it fills (frontend repo's `src/lib/wallets`).

This repo (`Bourse-Backend`) is deploy-independent from the frontend (`Bourse-Frontend`): they
only share a Neon Postgres database, never a codebase or a deploy. The `src/lib/{hl,symbols,
wallets/metrics.ts}` under this repo's root is a **vendored copy** of three modules the frontend
also has locally (it needs them for live markets data + wallet display formatting) — kept in
sync by hand since both sides need the exact same `deriveMetrics` logic to agree on P&L numbers.
If you change the derivation math, patch it in both repos.

## The four loops

| Loop | Source | Writes | Cadence (default) |
|---|---|---|---|
| **discover** | `trades` WebSocket — `users:[buyer,seller]` on every trade | `wallet` | continuous (WS) |
| **sync** | `userFillsByTime` REST (≈25 wt) | `fill` | every 30s, batch 15 |
| **derive** | `fill` → pure `deriveMetrics` (60-day window) | `wallet_metrics` | every 60s |
| **fresh** | `wallet.first_hip3_trade_at` < 30d | `wallet.is_fresh` | every 5m |

All four share **one process, one egress IP, one `hl` token bucket** — that's the whole
reason ingestion can't blow the 1200 wt/min budget. **`numReplicas` must stay 1** (see the
repo-root `railway.json`); a second replica = a second IP = a second bucket, breaking the invariant.

## Run locally

```bash
# 1. Provision Neon, apply the schema (from this repo's root):
psql "$DATABASE_URL" -f db/schema.sql

# 2. Install + run the worker:
cd worker
npm install
DATABASE_URL="postgres://…neon…" npm start      # or: npm run dev  (watch mode)
```

It refuses to start without `DATABASE_URL` and fails fast if the schema is missing.

## Two hosting options — pick one

This `worker/` (Docker container, pooled `pg`) and **`../worker-cf/`** (Cloudflare Durable
Object, Neon serverless driver) write the **identical** Neon schema and are interchangeable. Run
**only one** against a given database — two writers = two token buckets = the rate invariant
breaks. Cloudflare = stay on the org's CF account; this `worker/` runs the same unchanged code
on Railway, Render, or DigitalOcean — any Docker-capable host works, pick whichever's cheapest or
most familiar.

## Deploy (this `worker/`, any Docker host)

Same `worker/Dockerfile` for all three; only the platform config file differs. The Docker
**build context is this repo's root** (the worker imports the vendored `../src/lib`), which each
platform's config already encodes:

- **DigitalOcean** — see **[`DEPLOY-DIGITALOCEAN.md`](./DEPLOY-DIGITALOCEAN.md)** + repo-root
  `.do/app.yaml`. App Platform (managed, git-push deploys) or a plain Droplet (cheapest, manual).
- **Railway** — see **[`DEPLOY-RAILWAY.md`](./DEPLOY-RAILWAY.md)** + repo-root `railway.json`.
- **Render** — repo-root `render.yaml` (Background Worker blueprint).

Whichever you pick: set `DATABASE_URL_UNPOOLED` (Neon direct) in the service env, and keep the
instance/replica count at **1** — see "one egress IP" above.

## Config

Every knob is an env var read in `src/config.ts` — `SYNC_INTERVAL_MS`, `SYNC_BATCH_SIZE`,
`SYNC_CONCURRENCY`, `SYNC_LEASE_MS`, `DERIVE_INTERVAL_MS`, `DERIVE_CONCURRENCY`, `BACKFILL_DAYS`,
`HEALTH_PORT`, etc. Defaults are conservative and budget-safe.

## Schema migrations

`db/schema.sql` (idempotent — `CREATE TABLE IF NOT EXISTS` throughout) is still applied by hand
once per fresh database. Anything **after** that baseline lives in `../db/migrations/*.sql` and is
applied by:

```bash
cd worker && DATABASE_URL="postgres://…" npm run migrate
```

Each file runs once, in filename order, inside its own transaction, tracked in a
`schema_migrations` table — safe to re-run (already-applied files are skipped). Add new schema
changes as a new numbered file there rather than editing `schema.sql` directly.

## Multi-instance safety (data-level only) — read before raising instance/replica count

`claimSyncBatch` (`src/db.ts`) atomically leases each wallet it hands out (`FOR UPDATE SKIP
LOCKED` + a `claimed_until` column, migration 0003), so two worker processes hitting the same
database can no longer double-process the same wallet or clobber each other's watermark. A wallet
that keeps failing also backs off (`fail_count`/`next_attempt_at`, exponential + jitter) instead of
sitting at the front of the queue forever.

**This does not make it safe to run more than one instance.** The Hyperliquid rate-budget token
bucket (`src/lib/hl`'s `spend()`) is in-process memory — a second instance is a second bucket,
doubling real request volume against the shared 1200 wt/min ceiling regardless of DB-level
locking. The "exactly one instance" rule above (and in every deploy config) still applies; this
fix only means a brief overlap during a deploy's old/new instance handoff, or a future move to a
shared distributed rate limiter, wouldn't corrupt data — it doesn't unlock horizontal scaling by
itself.

## Health / observability

- A structured `[health] {...}` JSON line is logged every 60s (`src/health.ts`) with each loop's
  last-tick time and last error — greppable/shippable to any log-based monitor without a new
  integration.
- Set `HEALTH_PORT` to also serve `GET /health` (200 if every loop has ticked within 3x its own
  interval, 503 otherwise). Off by default — every current deploy target runs this as a headless
  background worker with no HTTP port; only set it if you're wiring a platform health check.

## Tests

Pure orchestration logic (retry/backoff, ticker-classification gating, the sync/derive tick
against a fake DB, `deriveMetrics` math) is unit-tested from the repo root, not from here — see
the root `README.md`.

## Diagnostics (no database needed — pure Hyperliquid reads)

- `npm run dryrun` — harvests real wallets off the trades feed and probes how far their
  fills reach; writes a visible timeline to `~/.bourse-shots/dryrun.html`.
- `npx tsx src/verify-pagination.ts` — proves the `userFillsByTime` page direction.
- `npx tsx src/verify-drain.ts` — proves `userFillsPaged` drains a wallet past the 2000 cap.

## Known scaffold gaps (deferred, tracked in IMPLEMENTATION.md §5)

- **60-day history on day one** — ✓ handled. `hl.userFillsPaged` paginates `startTime`
  forward through the 2000/call cap (verified 2026-08-27: page is oldest-2000 ascending),
  so the sync loop drains a wallet's full window. Bounded to `SYNC_MAX_PAGES` pages per
  pass with watermark resume, so a hyperactive wallet can't monopolize a pass. S3 backfill
  is now only an optional throughput aid for the heaviest wallets — not a correctness need.
- **Wallet tiering** — the schema has a `tier` column and `syncBatch` honours `hot`, but
  nothing promotes wallets to `hot`/`warm`/`cold` yet. Add a tiering pass when the tracked
  set outgrows the ~40-refresh/min ceiling (open item #4).
- **`avgHolding` + related-wallets** — need entry/exit fill pairing and a co-trading graph
  the M3 schema doesn't carry; the read layer returns `"—"` / `[]` until a hardening pass.
- **TradFi reference** (`tradfi_ref`) — table exists; the daily Finnhub cron (M2′) is not
  built. Fields stay null → UI shows "—".
