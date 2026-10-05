-- Migration 0006 — sync priority: sync wallets when they trade, not round-robin.
--
-- Applied by `cd worker && npm run migrate` (worker/src/migrate.ts wraps it in
-- one transaction — no BEGIN/COMMIT here).
--
-- Before this, claimSyncBatch ordered by last_indexed_at ASC — but that column
-- is the fill watermark (newest fill time), so a wallet that had just traded
-- jumped to the BACK of a ~24k-wallet queue (~13h at 30 wallets/min) and its
-- asset-page row sat on "—" until then, while dormant wallets with old
-- watermarks were re-polled at the front for nothing.
--
--   last_trade_seen_at — set by discover whenever the wallet shows up in the
--                        trades WebSocket (free: every trade names both sides)
--   last_synced_at     — set by claimSyncBatch when it claims the wallet (so a
--                        trade landing mid-pass re-dirties it); the fair-
--                        rotation key for everyone else
--
-- last_indexed_at stays the userFillsByTime watermark, unchanged.

ALTER TABLE wallet
  ADD COLUMN IF NOT EXISTS last_trade_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_synced_at     TIMESTAMPTZ;

-- Seed the rotation key from the old watermark so the first pass after deploy
-- isn't a 24k-wallet NULLS FIRST stampede in arbitrary order.
UPDATE wallet SET last_synced_at = last_indexed_at WHERE last_synced_at IS NULL;

-- claimSyncBatch's two scans: wallets that traded since their last sync
-- (small, newest first), then everyone else by when we last looked.
CREATE INDEX IF NOT EXISTS wallet_trade_seen_idx ON wallet (last_trade_seen_at DESC) WHERE last_trade_seen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_synced_idx     ON wallet (last_synced_at NULLS FIRST);
