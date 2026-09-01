// Verify HL's userFillsByTime pagination DIRECTION before building the loop.
// Question: on a wallet with >2000 fills in the window, does one call return the
// OLDEST 2000 from startTime (→ paginate by advancing startTime) or the NEWEST 2000
// up to endTime (→ paginate by retreating endTime)? Getting it wrong = a loop that
// never progresses. We answer it with live calls, no assumptions.

import WebSocket from "ws";
import { hl, classify } from "./core";

const DAY_MS = 86_400_000;
const DEX = process.env.BOURSE_DEX ?? "xyz";
const CAP = 2000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const d = (t: number, now: number) => `${((now - t) / DAY_MS).toFixed(1)}d`;

async function busiest(n: number): Promise<string[]> {
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
      if (m.channel !== "trades") return;
      for (const t of m.data ?? []) for (const u of t.users ?? []) if (u) seen.add(u.toLowerCase());
      if (seen.size >= 30) done();
    });
    ws.on("error", () => done());
    setTimeout(done, ms);
  });
}

async function main() {
  const now = Date.now();
  const windowStart = now - 90 * DAY_MS;
  console.log("\n▶ Verifying userFillsByTime pagination direction (live)\n");

  const wallets = await harvest(await busiest(6), 15_000);
  // find a capped wallet to test on
  let capped: { addr: string; page: hl.Fill[] } | null = null;
  for (const w of wallets) {
    const page = await hl.userFillsByTime(w, windowStart);
    if (page.length >= CAP) { capped = { addr: w, page }; break; }
  }
  if (!capped) { console.log("  no capped wallet found this run — try again"); process.exit(0); }

  const { addr, page } = capped;
  const first = page[0].time, last = page[page.length - 1].time;
  const min = Math.min(...page.map((f) => f.time)), max = Math.max(...page.map((f) => f.time));
  const ascending = last >= first;
  console.log(`  wallet ${short(addr)} · ${page.length} fills (CAPPED)`);
  console.log(`  array order:  fills[0]=${d(first, now)}  fills[last]=${d(last, now)}  → ${ascending ? "ASCENDING" : "DESCENDING"} in time`);
  console.log(`  page spans:   newest=${d(max, now)}  oldest=${d(min, now)}\n`);

  // Test A — retreat endTime below this page's oldest: do we get OLDER fills?
  const retreat = await hl.userFillsByTime(addr, windowStart, min - 1);
  const retreatOlder = retreat.filter((f) => f.time < min).length;
  console.log(`  [retreat endTime→${d(min - 1, now)}]  returned ${retreat.length}, of which ${retreatOlder} are OLDER than the first page`);

  // Test B — advance startTime above this page's newest: do we get NEWER fills?
  const advance = await hl.userFillsByTime(addr, max + 1);
  const advanceNewer = advance.filter((f) => f.time > max).length;
  console.log(`  [advance startTime→${d(max + 1, now)}]  returned ${advance.length}, of which ${advanceNewer} are NEWER than the first page\n`);

  console.log("  ── conclusion ──");
  if (retreatOlder > 0) {
    console.log("  ✓ endTime-RETREAT reaches older history → the page is the NEWEST 2000 up to endTime.");
    console.log("    Paginate: fix startTime=windowStart, walk endTime = min(page)-1 backward until <2000 or past window.");
  } else if (advanceNewer > 0) {
    console.log("  ✓ startTime-ADVANCE reaches newer fills → the page is the OLDEST 2000 from startTime.");
    console.log("    Paginate: fix endTime=now, walk startTime = max(page)+1 forward until <2000.");
  } else {
    console.log("  ? neither direction yielded new fills — inspect manually.");
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
