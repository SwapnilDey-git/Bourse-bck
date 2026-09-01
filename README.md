# Bourse Backend — Stage-2 ingestion worker

Always-on service that runs the discover / sync / derive / fresh loops against
Hyperliquid and writes wallet analytics into Neon (see `worker/README.md` and
`worker/src`). It reuses the app's shared data layer, vendored here at
`src/lib/` so the container builds standalone.

## Deploy (Render)
1. Render Dashboard → **New → Blueprint** → connect this repo (`render.yaml`).
2. Paste the Neon secret when prompted: `DATABASE_URL_UNPOOLED` (and/or `DATABASE_URL`).
3. Create — the Background Worker boots and starts populating Neon.

`db/schema.sql` is the store schema (`npm run db:apply` with `DATABASE_URL` set).
