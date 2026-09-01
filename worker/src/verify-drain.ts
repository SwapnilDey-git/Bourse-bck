// Proof that userFillsPaged actually drains past the single-call cap. Find a capped
// wallet, then compare one call vs the paginated drain.
import WebSocket from "ws";
import { hl, classify } from "./core";

const DAY_MS = 86_400_000;
const DEX = process.env.BOURSE_DEX ?? "xyz";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function busiest(n: number) {
  const rows = await hl.metaAndAssetCtxs(DEX);
  return rows.filter((r) => classify(r.coin))
    .map((r) => ({ c: r.coin, v: parseFloat(r.ctx.dayNtlVlm ?? "0") }))
    .sort((a, b) => b.v - a.v).slice(0, n).map((r) => r.c);
}
function harvest(coins: string[], ms: number): Promise<string[]> {
  return new Promise((res) => {
    const seen = new Set<string>();
    const ws = new WebSocket(process.env.HL_WS_URL ?? "wss://api.hyperliquid.xyz/ws");
    const done = () => { try { ws.close(); } catch {} res([...seen]); };
    ws.on("open", () => coins.forEach((c) => ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: c } }))));
    ws.on("message", (raw) => {
      let m: { channel?: string; data?: { users?: [string, string] }[] };
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.channel === "trades") for (const t of m.data ?? []) for (const u of t.users ?? []) if (u) seen.add(u.toLowerCase());
      if (seen.size >= 30) done();
    });
    ws.on("error", () => done());
    setTimeout(done, 15_000);
  });
}

async function main() {
  const now = Date.now();
  const start = now - 90 * DAY_MS;
  console.log("\n▶ Proving userFillsPaged drains past the 2000 cap\n");
  const wallets = await harvest(await busiest(6), 15_000);

  for (const w of wallets) {
    const one = await hl.userFillsByTime(w, start);
    if (one.length < 2000) continue; // want a capped one
    const { fills, drained } = await hl.userFillsPaged(w, start, { maxPages: 50 });
    const span = fills.length ? (Math.max(...fills.map((f) => f.time)) - Math.min(...fills.map((f) => f.time))) / DAY_MS : 0;
    console.log(`  wallet ${short(w)}`);
    console.log(`    single call : ${one.length} fills (capped)`);
    console.log(`    paginated   : ${fills.length} fills · ${span.toFixed(1)}d span · drained=${drained}`);
    console.log(`    → pagination recovered ${fills.length - one.length} fills the single call missed\n`);
    process.exit(0);
  }
  console.log("  no capped wallet this run — retry.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
