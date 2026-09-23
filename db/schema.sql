-- Bourse v1 · Stage-2 leaderboard store — Neon Postgres schema (migration 0001).
--
-- This is the "③ Managed stores · Neon Postgres" box in ARCHITECTURE.md · Diagram B,
-- and the data model in IMPLEMENTATION.md §3. It is written ONLY by the always-on
-- worker (worker/), and read ONLY by the Next Read API through src/lib/wallets.
-- The browser and the Read API never touch Hyperliquid — every wallet number the
-- UI shows is precomputed here, which is what makes the userFills depth-cap survivable
-- (the split rule: current positions = live clearinghouseState; historical = this store).
--
-- Apply with:  psql "$DATABASE_URL" -f db/schema.sql     (idempotent — safe to re-run)

BEGIN;

-- ── symbol ─────────────────────────────────────────────────────────────────
-- The owned universe (single-name equities + equity indices), enumerated at
-- runtime from perpDexs and named/sectored from the MoonDev seed. `coin` is the
-- HL namespaced id ("xyz:TSLA"); `ticker` is the display symbol ("TSLA").
CREATE TABLE IF NOT EXISTS symbol (
  coin        TEXT PRIMARY KEY,            -- "xyz:TSLA"
  ticker      TEXT NOT NULL,               -- "TSLA"
  name        TEXT NOT NULL,               -- "Tesla, Inc."
  sector      TEXT NOT NULL,               -- "Automotive"
  kind        TEXT NOT NULL DEFAULT 'equity' CHECK (kind IN ('equity','index')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS symbol_ticker_idx ON symbol (ticker);

-- ── tradfi_ref ─────────────────────────────────────────────────────────────
-- Deferred reference layer (M2′): 52w range, market cap, prev close, from a
-- commercial provider (Finnhub) via the daily cron. Kept null until that tier
-- is in place — the UI shows "—" rather than guess. Keyed by ticker (TradFi is
-- venue-agnostic), not coin.
CREATE TABLE IF NOT EXISTS tradfi_ref (
  ticker      TEXT PRIMARY KEY,
  week52_hi   DOUBLE PRECISION,
  week52_lo   DOUBLE PRECISION,
  market_cap  DOUBLE PRECISION,
  prev_close  DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── wallet ─────────────────────────────────────────────────────────────────
-- The discovered universe. Rows are upserted by the discover loop the instant a
-- trade names an address (buyer/seller on the public trades WS feed). `tier`
-- paces resync against the ~48 userFills/min budget ceiling (IMPLEMENTATION.md §5.4):
-- hot = index often, warm = occasionally, cold = slow backfill, new = never indexed.
CREATE TABLE IF NOT EXISTS wallet (
  address              TEXT PRIMARY KEY,   -- lowercase 0x…
  first_seen           TIMESTAMPTZ NOT NULL DEFAULT now(),  -- first time WE saw it
  first_hip3_trade_at  TIMESTAMPTZ,        -- earliest equity fill we've indexed (age basis)
  is_fresh             BOOLEAN NOT NULL DEFAULT FALSE,       -- <30d old & first HIP-3 trade → §10.14 feed
  last_indexed_at      TIMESTAMPTZ,        -- watermark: userFillsByTime startTime for next sync
  tier                 TEXT NOT NULL DEFAULT 'new' CHECK (tier IN ('hot','warm','cold','new'))
);
CREATE INDEX IF NOT EXISTS wallet_tier_idx        ON wallet (tier, last_indexed_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS wallet_is_fresh_idx    ON wallet (is_fresh) WHERE is_fresh;

-- ── fill ───────────────────────────────────────────────────────────────────
-- Raw per-fill history, appended by the sync loop from userFillsByTime. `tid` is
-- Hyperliquid's globally-unique trade id → natural PK, makes re-polling idempotent
-- (ON CONFLICT DO NOTHING). `closed_pnl` is realized P&L on the closing side of a
-- position; `dir` is HL's "Open Long" / "Close Short" / "Buy" / "Sell" label.
CREATE TABLE IF NOT EXISTS fill (
  tid         BIGINT PRIMARY KEY,          -- HL trade id (unique per fill)
  address     TEXT NOT NULL REFERENCES wallet(address) ON DELETE CASCADE,
  coin        TEXT NOT NULL,               -- "xyz:TSLA"
  ticker      TEXT NOT NULL,               -- denormalized "TSLA" for cheap reads
  side        TEXT NOT NULL,               -- "B" | "A" (buy/sell aggressor)
  dir         TEXT NOT NULL,               -- "Open Long" | "Close Short" | "Buy" | "Sell"
  leveraged   BOOLEAN NOT NULL DEFAULT TRUE,-- display heuristic, not a venue: HIP-3 equities are
                                             -- 100% perpetuals (docs.trade.xyz confirms no spot
                                             -- equity market exists — Hyperliquid's real spot
                                             -- markets, via Unit Protocol, are tokenized native-chain
                                             -- crypto only, unrelated to equities). lev==1 just means
                                             -- the UI renders the fill as a plain buy/sell instead of
                                             -- long/short + entry/liq/pnl, since a 1x perp behaves like
                                             -- spot day-to-day. Caveat: a 1x position can still be
                                             -- liquidated on funding/margin shortfalls unlike true spot,
                                             -- so this hides real (if rare) liquidation risk — confirmed
                                             -- as a deliberate simplification, not revisited further.
  sz          DOUBLE PRECISION NOT NULL,   -- contracts
  px          DOUBLE PRECISION NOT NULL,   -- fill price
  notional    DOUBLE PRECISION NOT NULL,   -- sz*px, USD (Bourse shows USD everywhere)
  closed_pnl  DOUBLE PRECISION NOT NULL DEFAULT 0,
  fee         DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_close    BOOLEAN NOT NULL DEFAULT FALSE, -- dir LIKE 'Close%' → counts toward win-rate
  time        TIMESTAMPTZ NOT NULL         -- fill time (HL ms → tz)
);
CREATE INDEX IF NOT EXISTS fill_address_time_idx ON fill (address, time DESC);
CREATE INDEX IF NOT EXISTS fill_coin_time_idx    ON fill (coin, time DESC);
CREATE INDEX IF NOT EXISTS fill_time_idx         ON fill (time DESC);
-- Backs relatedWallets' (§10.13) cross-wallet-by-ticker join in src/lib/wallets —
-- "which other wallets traded any of MY tickers in the last 60 days" fans out
-- from this index rather than a precomputed O(wallets²) pairwise table.
CREATE INDEX IF NOT EXISTS fill_ticker_time_idx  ON fill (ticker, time DESC);

-- ── wallet_metrics ─────────────────────────────────────────────────────────
-- The precomputed leaderboard row, recomputed by the derive loop over the
-- 60-DAY ROLLING WINDOW from `fill`. The leaderboard query reads THIS table only
-- (never recomputes per view) — the whole reason the depth-cap is survivable.
--   realized_pnl = Σ closed_pnl over window
--   win_rate     = share of closing fills with closed_pnl > 0
--   trade_count  = fills in window; closed_count = closing fills
--   age_days     = now - first_hip3_trade_at
-- qualifies_winrate mirrors §10.10 (≥20 closed over ≥30 active days) so the read
-- layer can gate the win-rate sort without recomputation.
CREATE TABLE IF NOT EXISTS wallet_metrics (
  address            TEXT PRIMARY KEY REFERENCES wallet(address) ON DELETE CASCADE,
  realized_pnl       DOUBLE PRECISION NOT NULL DEFAULT 0,
  win_rate           DOUBLE PRECISION NOT NULL DEFAULT 0,  -- 0..1
  trade_count        INTEGER NOT NULL DEFAULT 0,
  closed_count       INTEGER NOT NULL DEFAULT 0,
  active_days        INTEGER NOT NULL DEFAULT 0,           -- span first→last fill in window
  age_days           INTEGER NOT NULL DEFAULT 0,           -- onchain age (fresh = <30)
  qualifies_winrate  BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Leaderboard sorts (§10.9): P&L, win-rate (gated), activity.
CREATE INDEX IF NOT EXISTS metrics_pnl_idx      ON wallet_metrics (realized_pnl DESC);
CREATE INDEX IF NOT EXISTS metrics_winrate_idx  ON wallet_metrics (win_rate DESC) WHERE qualifies_winrate;
CREATE INDEX IF NOT EXISTS metrics_activity_idx ON wallet_metrics (trade_count DESC);

-- ── Accounts (migration 0002) ─────────────────────────────────────────────
-- Resolves PRD §11 Q3 (DESIGN.md §4a/§4b, PROPOSAL): "browse open, sign in to
-- save", Google OAuth + 6-digit email OTP, zero passwords. Hand-rolled rather
-- than an auth library/ORM, matching every other module in this schema — the
-- app already talks to Postgres directly via @neondatabase/serverless, so an
-- adapter package would just be a second, conflicting way to do the same
-- thing. Owned entirely by src/lib/auth; nothing else touches these tables.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One row per account. Email is the identity in both sign-in paths.
CREATE TABLE IF NOT EXISTS app_user (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,       -- always lowercased before insert
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Links a Google identity to an app_user. provider_user_id is Google's stable
-- `sub` claim, not the email (a Google account's email can change). Google
-- and OTP auto-link onto the same app_user row when the email matches, but
-- ONLY on a verified Google email (src/lib/auth) — an unverified provider
-- address linking silently would be an account-takeover path.
CREATE TABLE IF NOT EXISTS oauth_account (
  provider          TEXT NOT NULL,          -- 'google'
  provider_user_id  TEXT NOT NULL,
  user_id           UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);

-- Six-digit sign-in codes (DESIGN.md's OTP Input). Only a hash is stored, same
-- reasoning as `session` below. Insert-only — superseded codes are left in
-- place and made inert by expiry/attempts rather than deleted or updated.
CREATE TABLE IF NOT EXISTS email_otp (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,              -- sha256(code), never the raw code
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0, -- capped in src/lib/auth
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_otp_email_idx ON email_otp (email, created_at DESC);

-- Only a hash of the session token is stored — a leaked row alone can't
-- authenticate, since the raw token lives only in the browser's cookie.
CREATE TABLE IF NOT EXISTS session (
  token_hash   TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session (user_id);

-- Account-scoped watchlist — same rows as src/lib/watchlist.ts's localStorage
-- shape, different store, once a user is signed in.
CREATE TABLE IF NOT EXISTS watchlist_item (
  user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ticker       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticker)
);

-- Account-scoped Recently Viewed (§6.10). `kind`+`ref` identify the asset
-- ticker or wallet address; upserted on every view so the latest visit wins
-- without duplicate rows or an unbounded table.
CREATE TABLE IF NOT EXISTS recently_viewed_item (
  user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('stock','wallet')),
  ref          TEXT NOT NULL,              -- ticker or address
  context      TEXT NOT NULL,              -- e.g. "Asset detail", "Wallet profile"
  viewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS recently_viewed_user_idx ON recently_viewed_item (user_id, viewed_at DESC);

COMMIT;
