// Worker entry. Exports the Ingestor Durable Object class and two tiny handlers whose
// only job is to keep the SINGLE ingestor alive and let you inspect it:
//   - scheduled(): the once-a-minute Cron Trigger pings the singleton DO. If Cloudflare
//     evicted it, this wakes it → it reconnects the WS and re-arms its alarm. When it's
//     already running, the ping is a no-op it answers instantly.
//   - fetch(): forwards any HTTP request to the same singleton for a health snapshot
//     (GET the worker URL to see coin count / buffered wallets / row presence).
//
// Everything is addressed by the fixed name "singleton" so there is ever only ONE
// ingestor instance — one isolate, one hl token bucket, one WS. Never change this to
// per-request IDs; that would multiply the Hyperliquid rate budget.

import { Ingestor, type Env } from "./ingestor";

export { Ingestor };

const SINGLETON = "singleton";

function stub(env: Env) {
  const id = env.INGESTOR.idFromName(SINGLETON);
  return env.INGESTOR.get(id);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return stub(env).fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Wake/keepalive the singleton; don't block the cron on the full response.
    ctx.waitUntil(stub(env).fetch(new Request("https://ingestor/ping")));
  },
};
