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
pins this; don't override it.
