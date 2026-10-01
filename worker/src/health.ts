// Minimal operability surface (review finding: "limited monitoring — console
// logs only, no metrics or health checks"). Two low-risk additions:
//   1. an in-memory heartbeat each loop reports into on every tick, logged as
//      one structured JSON line every HEARTBEAT_LOG_MS — greppable and
//      shippable to any log-based monitor (Datadog, Loki, ...) without a new
//      infra dependency or outbound integration.
//   2. an optional HTTP /health endpoint, started ONLY if HEALTH_PORT is set —
//      every current deploy target (.do/app.yaml, render.yaml, railway.json)
//      runs this as a headless background worker with no HTTP port, so the
//      server stays off unless an operator opts in and wires a platform
//      health check to it.

type LoopName = "discover" | "sync" | "derive" | "fresh" | "retain";

type LoopStatus = { lastTickAt: number; lastError: string | null; intervalMs: number };

const status: Record<LoopName, LoopStatus> = {
  discover: { lastTickAt: 0, lastError: null, intervalMs: 0 },
  sync: { lastTickAt: 0, lastError: null, intervalMs: 0 },
  derive: { lastTickAt: 0, lastError: null, intervalMs: 0 },
  fresh: { lastTickAt: 0, lastError: null, intervalMs: 0 },
  retain: { lastTickAt: 0, lastError: null, intervalMs: 0 },
};

export function reportTick(loop: LoopName, intervalMs: number, error?: string): void {
  status[loop] = { lastTickAt: Date.now(), lastError: error ?? null, intervalMs };
}

// A loop is "stalled" if it's overdue by more than 3x its own interval — wide
// enough to absorb one slow pass without flapping healthy/unhealthy.
export function isHealthy(now = Date.now()): boolean {
  return (Object.keys(status) as LoopName[]).every((k) => {
    const s = status[k];
    if (!s.intervalMs) return true; // hasn't ticked yet — not unhealthy, just not up
    return now - s.lastTickAt <= s.intervalMs * 3;
  });
}

export function snapshot() {
  return { healthy: isHealthy(), loops: status, uptimeMs: Math.floor(process.uptime() * 1000) };
}

let heartbeatTimer: NodeJS.Timeout | null = null;
export function startHeartbeatLog(intervalMs = 60_000): void {
  heartbeatTimer = setInterval(() => console.log(`[health] ${JSON.stringify(snapshot())}`), intervalMs);
}
export function stopHeartbeatLog(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}

let server: import("node:http").Server | null = null;
export function startHealthServer(port: number): void {
  void import("node:http").then(({ createServer }) => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        const snap = snapshot();
        res.writeHead(snap.healthy ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify(snap));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(port, () => console.log(`[health] listening on :${port}/health`));
  });
}
export function stopHealthServer(): void {
  server?.close();
}
