# Deploy the Bourse worker to Railway

The always-on ingestion worker (discover · sync · derive · fresh) that fills the Neon store
the app reads. This is the last infra step before the Smart-Wallets leaderboard can go live.

## Before you start — what's already done

- ✅ **Neon Postgres provisioned**, `db/schema.sql` applied (5 tables live), end-to-end verified
  locally (953 wallets / 71k fills / metrics computed).
- ✅ **Worker code + Dockerfile + repo-root `railway.json`** ready.
- You need: a **Railway account** (railway.app) and your Neon **direct** connection string
  (`DATABASE_URL_UNPOOLED`, host *without* `-pooler`) — it's in the frontend repo's `.env.local`
  (this worker only needs the value, not that repo).

## The one constraint that shapes everything

The worker imports the shared modules from `../src/lib`, which this repo (`Bourse-Backend`)
vendors locally, so the Docker **build context is just this repo's root**, not `worker/`. The
repo-root `railway.json` + `worker/Dockerfile` already encode this (the Dockerfile copies both
`src/lib` and `worker/`). And because all four loops share **one egress IP + one rate-budget
token bucket**, the service must run as exactly **one replica** (`numReplicas: 1`). A second
replica = a second IP = a doubled upstream rate — it can blow the 1200 wt/min Hyperliquid budget.
Never scale this service horizontally.

---

## Path A — Railway CLI (recommended)

Run everything from this repo's root.

1. **Install the CLI**
   ```bash
   npm i -g @railway/cli          # or: brew install railway
   railway --version
   ```

2. **Log in** (interactive browser — run it yourself; in this session type `! railway login`)
   ```bash
   railway login
   ```

3. **Create the project + service** (from this repo's root)
   ```bash
   railway init            # name it e.g. "bourse-worker"; creates a project
   ```

4. **Set the environment variables** (see the table below). Set at least the direct URL:
   ```bash
   railway variables --set "DATABASE_URL_UNPOOLED=postgresql://…@ep-…(no -pooler)…/neondb?sslmode=require"
   # optional tuning, e.g.:
   railway variables --set "SYNC_MAX_PAGES=6" --set "SYNC_BATCH_SIZE=15"
   ```

5. **Deploy** — uploads this repo as the build context (secrets excluded via `.dockerignore`),
   builds `worker/Dockerfile`, starts `npm start`:
   ```bash
   railway up
   ```

6. **Confirm single replica**: Railway dashboard → the service → **Settings → Deploy → Replicas = 1**
   (it defaults to 1; the repo-root `railway.json` also declares it — just verify).

---

## Path B — GitHub connect (only if you prefer git-push deploys)

1. Railway dashboard → **New Project → Deploy from GitHub repo** → pick `Bourse-Backend`.
2. Service **Settings**:
   - **Root Directory** = `/` (repo root — build context and `railway.json` resolve directly).
   - **Dockerfile Path** = `worker/Dockerfile` (already set by the root `railway.json`; confirm).
   - **Replicas** = 1.
3. Add the env vars (below) under **Variables**.
4. Trigger a deploy; every push to the tracked branch redeploys.

---

## Environment variables

| Variable | Required | Value / default |
|---|---|---|
| `DATABASE_URL_UNPOOLED` | **yes** | Neon **direct** string (no `-pooler`). The worker prefers this; falls back to `DATABASE_URL`. |
| `SYNC_INTERVAL_MS` | no | `30000` — sync loop cadence |
| `SYNC_BATCH_SIZE` | no | `15` — wallets per sync pass |
| `SYNC_MAX_PAGES` | no | `6` — pagination pages/wallet/pass (caps hyperactive-wallet cost) |
| `DERIVE_INTERVAL_MS` | no | `60000` |
| `FRESH_INTERVAL_MS` | no | `300000` |
| `BACKFILL_DAYS` | no | `60` — how far a never-indexed wallet's first sync reaches |
| `BOURSE_DEX` | no | `xyz` |

Do **not** set `numReplicas` via env — it's fixed at 1 in `railway.json`.

---

## Verify the deploy

1. **Logs** (dashboard → Deployments → Logs, or `railway logs`): within ~90s you should see
   ```
   [worker] all four loops running
   [discover] subscribed to N equity coins
   [discover] +NNN new wallets
   [sync] +NNN fills across N wallets
   [derive] recomputed N wallets
   ```
   No `[sync] … failed` lines (the fill-insert is chunked).

2. **Row counts grow** — from anywhere with the connection string, pointed at the same DB:
   ```bash
   set -a; . ./.env.local; set +a
   psql "$DATABASE_URL_UNPOOLED" -c \
     "select (select count(*) from wallet) w, (select count(*) from fill) f, (select count(*) from wallet_metrics) m;"
   ```
   Re-run after a few minutes — `m` (wallet_metrics) should climb as `derive` works through the
   discovered universe. **Let it run until the leaderboard is well-populated** (hundreds of
   metrics rows), not just a handful.

---

## Then flip the app live (Vercel)

Only after `wallet_metrics` is populated:

1. Vercel → project `bourse-app` → **Settings → Environment Variables**: add
   **`DATABASE_URL`** = the Neon **pooled** string (host *with* `-pooler`).
2. Set **`BOURSE_WALLETS=live`** (Vercel env, or commit it in `.env.production`).
3. Redeploy. The Smart-Wallets + Fresh-Wallets pages now read the live store; markets stay live as before.

> Don't flip `BOURSE_WALLETS=live` against an empty or thin store — the leaderboard would render
> sparse. Watch the row counts first.

---

## Guardrails recap

- **Replicas = 1, always** (single egress IP / one token bucket).
- **Direct URL for the worker**, pooled URL for the Vercel app.
- **Rotate the DB password** (Neon console → `neondb_owner` → Reset password) if the connection
  string was ever exposed, then update both Railway and Vercel env + local `.env.local`.
