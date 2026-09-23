# Deploy the Bourse worker to DigitalOcean

The always-on ingestion worker (discover · sync · derive · fresh) that fills the Neon store
the app reads. This is the last infra step before the Smart-Wallets leaderboard can go live —
see `worker/README.md` for what the four loops do. This doc replaces Railway/Render as the
hosting choice; pick **one** host only (never run two workers against the same DB).

## Before you start — what's already done

- ✅ **Neon Postgres provisioned**, `db/schema.sql` applied, end-to-end verified locally.
- ✅ **Worker code + Dockerfile + `.do/app.yaml`** ready — the Dockerfile is unchanged from the
  Railway/Render path, so there's no code work here, only hosting setup.
- You need: a **DigitalOcean account**, billing enabled (App Platform's paid tier, ~$5/mo at the
  cheapest instance size — background workers aren't eligible for the free static tier), and your
  Neon **direct** connection string (`DATABASE_URL_UNPOOLED`, host *without* `-pooler`) — already
  in the frontend repo's `.env.local` (this worker only needs the value, not that repo).

## The one constraint that shapes everything

All four loops share **one egress IP + one Hyperliquid rate-budget token bucket** (1200 wt/min).
The service must run as exactly **one instance** — never enable autoscaling or raise
`instance_count`. `.do/app.yaml` pins this; if you deploy via the dashboard instead, set it by
hand and double check before the first deploy.

There's no monorepo build-context workaround needed here: this repo (`0xArchitect/Bourse-Backend`)
is self-contained — `src/lib/{hl,symbols,wallets/metrics.ts}` is a vendored copy of the shared
modules the worker needs (the live frontend repo has its own copy; see the note at the bottom of
`worker/README.md`) — so App Platform's `source_dir` is just the repo root and
`dockerfile_path: worker/Dockerfile` resolves directly.

---

## Path A — App Platform via `doctl` (recommended)

Run everything from `bourse-app/`.

1. **Install the CLI**
   ```bash
   brew install doctl        # or see docs.digitalocean.com/reference/doctl/how-to/install
   doctl version
   ```

2. **Authenticate** (interactive — generates a token in the DO dashboard; run it yourself, in this
   session type `! doctl auth init`)
   ```bash
   doctl auth init
   ```

3. **Create the app from the committed spec.** `.do/app.yaml` already declares the worker,
   `instance_count: 1`, and which env keys it expects — it does **not** carry secret values (App
   Platform strips/rejects a bare secret value in a spec you'd commit):
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
   This kicks off the first build against the `main` branch. If the GitHub repo isn't already
   connected to your DO account, `doctl` will prompt you to authorize it (opens a browser —
   run that step yourself).

4. **Set the secret env var** — `DATABASE_URL_UNPOOLED` was declared as `type: SECRET` with no
   value in the spec, so set it after creation (get the app ID from step 3's output or
   `doctl apps list`):
   ```bash
   doctl apps update <APP_ID> --spec .do/app.yaml
   ```
   or, simpler, set it once via the dashboard: **App → Settings → bourse-worker component →
   Environment Variables → Edit → add `DATABASE_URL_UNPOOLED`** (mark it "Encrypted"), then
   **Save** (triggers a redeploy).

5. **Confirm single instance**: dashboard → the app → **bourse-worker component → Settings →
   Instance Count = 1**, autoscaling off. (`.do/app.yaml` already sets this — just verify it
   stuck.)

---

## Path B — a plain Droplet (cheapest, most manual)

Skip this if Path A worked — it's here because a single always-on background process with no
HTTP port is also one of the simplest possible Droplet workloads, and it's cheaper at this scale
(a $6/mo basic Droplet vs. App Platform's per-component pricing).

1. **Create the Droplet** — Ubuntu 24.04 LTS, smallest size (1 vCPU / 512MB–1GB is plenty for
   this workload), any region close to your Neon project's region (lower latency, not required).

2. **Install Docker** (DigitalOcean's "Docker on Ubuntu" 1-click marketplace image does this for
   you at creation — pick that instead of plain Ubuntu to skip this step):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

3. **Get the code onto the Droplet and build.** Simplest path — clone the repo directly on the
   Droplet rather than pushing a prebuilt image to a registry:
   ```bash
   git clone https://github.com/0xArchitect/Bourse-Backend.git
   cd Bourse-Backend
   docker build -f worker/Dockerfile -t bourse-worker .
   ```

4. **Run it** with `--restart=always` so it survives reboots and crashes, and `-d` to stay
   detached:
   ```bash
   docker run -d --name bourse-worker --restart=always \
     -e DATABASE_URL_UNPOOLED="postgresql://…@ep-…(no -pooler)…/neondb?sslmode=require" \
     -e SYNC_MAX_PAGES=6 \
     -e SYNC_BATCH_SIZE=15 \
     bourse-worker
   ```

5. **Redeploying on code changes** is manual here (no git-push auto-deploy like Path A):
   ```bash
   cd Bourse-Backend && git pull
   docker build -f worker/Dockerfile -t bourse-worker .
   docker stop bourse-worker && docker rm bourse-worker
   # re-run the `docker run` command from step 4
   ```
   If you'll iterate often, Path A's auto-deploy-on-push is worth the extra few dollars a month.

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

Never set anything that raises replica/instance count above 1 — see "the one constraint" above.

---

## Verify the deploy

1. **Logs** — App Platform: dashboard → app → **Runtime Logs**, or `doctl apps logs <APP_ID>
   --type run --follow`. Droplet: `docker logs -f bourse-worker`. Within ~90s you should see:
   ```
   [worker] all four loops running
   [discover] subscribed to N equity coins
   [discover] +NNN new wallets
   [sync] +NNN fills across N wallets
   [derive] recomputed N wallets
   ```
   No `[sync] … failed` lines.

2. **Row counts grow** — from `bourse-app/` locally, pointed at the same DB:
   ```bash
   set -a; . ./.env.local; set +a
   psql "$DATABASE_URL_UNPOOLED" -c \
     "select (select count(*) from wallet) w, (select count(*) from fill) f, (select count(*) from wallet_metrics) m;"
   ```
   Re-run after a few minutes — `m` (wallet_metrics) should climb. **Let it run until the
   leaderboard is well-populated** (hundreds of metrics rows), not just a handful, before flipping
   the app live.

---

## Then flip the app live (Vercel)

Only after `wallet_metrics` is populated:

1. Vercel → project `bourse-app` → **Settings → Environment Variables**: add
   **`DATABASE_URL`** = the Neon **pooled** string (host *with* `-pooler`).
2. Set **`BOURSE_WALLETS=live`**.
3. Redeploy. The Smart-Wallets + Fresh-Wallets pages now read the live store; markets stay live
   as before.

> Don't flip `BOURSE_WALLETS=live` against an empty or thin store — the leaderboard would render
> sparse. Watch the row counts first.

---

## Guardrails recap

- **One instance/replica, always** (single egress IP / one token bucket).
- **Direct URL for the worker**, pooled URL for the Vercel app.
- **Rotate the DB password** (Neon console → `neondb_owner` → Reset password) if the connection
  string was ever exposed, then update wherever it's set (DO app/Droplet env + Vercel + local
  `.env.local`).
- If you later decide against DO, `railway.json` and `render.yaml` are still in the repo as
  alternatives — this doc doesn't remove them, it's just a third option.
