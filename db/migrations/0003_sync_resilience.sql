-- Migration 0003 — sync resilience: multi-instance-safe claiming + retry backoff.
--
-- Applied automatically by `cd worker && npm run migrate` (scripts: worker/src/migrate.ts),
-- which wraps this whole file in one transaction and records it in
-- schema_migrations — do not add your own BEGIN/COMMIT here or to future
-- migration files in this directory.
--
-- Adds the columns worker/src/db.ts's claimSyncBatch / recordSyncSuccess /
-- recordSyncFailure need: a lease (claimed_until) so two worker instances
-- can't grab the same wallet, and a backoff schedule (fail_count / last_error
-- / next_attempt_at) so a wallet that keeps failing stops sitting at the
-- front of the sync queue.

ALTER TABLE wallet
  ADD COLUMN IF NOT EXISTS fail_count      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error      TEXT,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_until   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS wallet_claim_idx
  ON wallet (next_attempt_at NULLS FIRST, claimed_until NULLS FIRST);
