// The Neon read client (Stage 2). Used by the Next Read API side only — the
// serverless HTTP driver (`neon()`) is edge/serverless-friendly and needs no
// pooled TCP connection, which is exactly right for short-lived route handlers.
// The always-on worker uses a pooled `pg` client instead (worker/src/db.ts) —
// same database, connection style matched to each runtime.
//
// DATABASE_URL is a Neon connection string. Absent it, `sql` throws on first use;
// callers (src/lib/wallets) guard with `hasDb()` and the provider only routes here
// when BOURSE_WALLETS=live, so a missing URL degrades cleanly to mock.

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL;
}

// Tagged-template query function: sql`SELECT … WHERE address = ${addr}` — params
// are bound, never interpolated. Lazily created so importing this module is free.
export function db(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set — wallet store unavailable (BOURSE_WALLETS should be 'mock')");
  }
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}
