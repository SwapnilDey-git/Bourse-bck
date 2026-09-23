# Deploy the Bourse worker to Cloudflare (Durable Object)

The Cloudflare-native home for the Stage-2 ingestion worker. Same four loops as
`../worker`, hosted as a **single Durable Object** instead of an always-on VM. Pick this
over Railway when you want everything on the org's Cloudflare account.

## Why a Durable Object (not a plain Worker or a Container)

The worker is an inbound-less daemon: a persistent WebSocket to Hyperliquid's `trades`
feed, periodic sync/derive/fresh loops, and — critically — **one shared rate-budget token
bucket** so it can't exceed Hyperliquid's 1200 wt/min. A DO matches all three:

- **Singleton** — `index.ts` always addresses the DO by the fixed name `"singleton"`, so
  there is exactly one instance = one isolate = **one in-memory token bucket**. This is the
  rate invariant, preserved by construction. **Never** address it per-request.
- **Persistent outbound WebSocket** — the DO opens the `trades` socket via
  `fetch(url, { headers: { Upgrade: "websocket" } })` and stays resident while it's open.
- **DO Alarms** replace `setInterval` for the periodic loops; a **once-a-minute Cron
  Trigger** pings the DO so it's re-woken and re-armed if Cloudflare ever evicts it.

## Prerequisites

- A **Cloudflare account** (the org's) and `wrangler` (bundled as a dev dep here).
- **Plan note:** Durable Objects with alarms need a plan that includes DOs. This uses a
  **SQLite-backed** class (`new_sqlite_classes` in `wrangler.toml`), the broadest-compatible
  option. Confirm the org account has Durable Objects enabled (Workers Paid includes them).
- The Neon **connection string** — same DB the Railway path / local runs already populate.

## Deploy

All commands run from `worker-cf/`.

1. **Install deps** (once):
   ```bash
   cd worker-cf && npm install
   ```

2. **Log in** (interactive browser — run it yourself; in this session type `! npx wrangler login`):
   ```bash
   npx wrangler login
   ```
   To target the org account specifically, set `CLOUDFLARE_ACCOUNT_ID=<id>` or pick it when prompted.

3. **Set the database secret** (never commit it — `wrangler.toml` has none):
   ```bash
   npx wrangler secret put DATABASE_URL
   # paste the Neon connection string when prompted (pooled or direct both work —
   # the HTTP driver queries over https regardless of the -pooler host)
   ```

4. **Deploy**:
   ```bash
   npx wrangler deploy
   ```
   This uploads the Worker + registers the `Ingestor` DO class + the cron trigger. Within a
   minute the cron fires, wakes the singleton, and the loops start.

## Verify

- **Live logs**:
  ```bash
  npx wrangler tail
  ```
  Expect: `[cf] init · dex=xyz · N equity coins`, `[cf] subscribed N coins`,
  `[cf] discover +N new`, `[cf] sync +N fills`, `[cf] derive N wallets`.

- **Health endpoint** — GET the deployed Worker URL:
  ```bash
  curl https://bourse-worker.<your-subdomain>.workers.dev/ping
  # → {"ok":true,"coins":93,"buffered":12,"counts":{...}}
  ```

- **Row counts grow** — point psql at the same Neon DB and re-run over a few minutes:
  ```bash
  psql "$DATABASE_URL_UNPOOLED" -c \
    "select (select count(*) from wallet) w, (select count(*) from fill) f, (select count(*) from wallet_metrics) m;"
  ```
  Let it run until `wallet_metrics` is well-populated before flipping the app live.

## Local dev (optional, against real Neon)

```bash
printf 'DATABASE_URL=%s\n' "<neon-url>" > .dev.vars   # gitignored
npx wrangler dev --local --port 8799
# in another shell, wake the singleton DO:
curl http://localhost:8799/ping
```
Cron doesn't auto-fire in `wrangler dev` — the `curl /ping` wakes the DO, which then
self-drives via its alarm. Watch the terminal for the `[cf] …` loop logs.

## Then flip the app live (Vercel)

Identical to the Railway path — only after `wallet_metrics` is populated:

1. Vercel → project `bourse-app` → add **`DATABASE_URL`** = Neon **pooled** string.
2. Set **`BOURSE_WALLETS=live`**; redeploy.

## Guardrails

- **One instance, always** — the singleton name is the rate-budget invariant. Don't shard it.
- **Direct vs pooled** doesn't matter for this worker (HTTP driver), but the Vercel app should
  use the **pooled** `DATABASE_URL`.
- **Rotate the DB password** (Neon console) if the connection string was ever exposed, then
  `wrangler secret put DATABASE_URL` again + update Vercel + local `.env.local`.

## Railway vs Cloudflare — same store, pick one

Both `../worker` (Railway/VM) and this (`worker-cf`, Cloudflare DO) write the identical Neon
schema and are interchangeable. Run **only one** at a time against a given database, or two
writers = two token buckets = the rate invariant is broken. The read side (the Next app) is
unaffected either way.
