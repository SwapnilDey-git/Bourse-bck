# Bourse Backend

The always-on wallet-intelligence ingestion service for [Bourse](https://bourse.money) —
turns Hyperliquid's public trade feeds into the precomputed Smart-Wallets leaderboard and
Fresh-Wallets feed the frontend serves. Split out from `Bourse-Frontend` so the two deploy
independently; they share nothing but a Neon Postgres database.

## Layout

```
worker/       Docker-based worker (discover/sync/derive/fresh loops, pooled pg) — see worker/README.md
worker-cf/    Cloudflare Durable Object port of the same four loops — alternative host, not both at once
db/           schema.sql — the Neon schema both workers write and the frontend reads
src/lib/      Vendored copy of 3 modules also used by Bourse-Frontend (hl, symbols, wallets/metrics.ts) —
              kept in sync by hand, see the note in worker/README.md
railway.json  render.yaml  .do/app.yaml — deploy configs for Railway / Render / DigitalOcean
```

## Start here

`worker/README.md` — what the four loops do, hosting options, local dev.
`worker/DEPLOY-DIGITALOCEAN.md` — the recommended deploy path.

## The one invariant that matters everywhere in this repo

All four loops share **one process, one egress IP, one Hyperliquid rate-budget token bucket**
(1200 wt/min). Whatever you deploy this as, it must run as **exactly one instance, always** —
never enable autoscaling or raise the replica/instance count. Every deploy config here already
pins this; don't override it. (`worker/README.md`'s "Multi-instance safety" section has the
nuance: the DB layer is now safe against an accidental second instance, the rate budget still
isn't — that rule doesn't change.)

## `src/lib` — shared, tested, typechecked from here

`src/lib/{hl,symbols,wallets}` has no package.json of its own (both `worker/` and `worker-cf/`
import it via a relative path, and the frontend repo vendors its own copy) — its tests and
typecheck run from this root instead:

```bash
npm install
npm run typecheck   # tsc --noEmit over src/lib
npm test            # vitest — retry/backoff policy, ticker-classification gating,
                     # the sync/derive tick against a fake DB, deriveMetrics math
```

CI (`.github/workflows/ci.yml`) runs this plus `npm run typecheck` in both `worker/` and
`worker-cf/` on every push/PR to `main`.

`src/lib/wallets/ingest.ts` is the one definition of "sync a wallet" / "derive its metrics" /
"classify a fill for storage" — both workers call into it instead of each carrying their own copy
of the loop bodies (they used to; that duplication is what `worker-cf/src/ingestor.ts` used to
carry verbatim).
