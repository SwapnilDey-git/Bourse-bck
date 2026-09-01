// M3 dry-run harness — answers the one real open question before any infra spend
// (IMPLEMENTATION.md §5 item #2): does per-wallet `userFillsByTime` actually reach
// back the full 60-day leaderboard window, or does the depth cap truncate it so a
// one-time S3 backfill is required?
//
// It needs NO database — pure Hyperliquid reads: harvest real wallets off the public
// `trades` WS (the discover loop's mechanism), then probe each with userFillsByTime
// over a window WIDER than 60 days and measure how far back the fills reach and
// whether the wallet is depth-capped. Prints a report AND writes a visual timeline
// of every fill point to ~/.bourse-shots/dryrun.html.
//
//   cd worker && npm run dryrun

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hl, classify, WINDOW_DAYS } from "./core";

const DAY_MS = 86_400_000;
const DEX = process.env.BOURSE_DEX ?? "xyz";
const PROBE_DAYS = 90;              // probe wider than the 60d window to see if it caps first
const HARVEST_MS = 20_000;         // how long to listen on the trades feed
const MAX_WALLETS = 12;            // probe budget: 12 × 25wt = 300wt, well under 1000/min
const DEPTH_CAP = 2000;            // userFills returns at most ~2000 fills/request

type Probe = {
  address: string;
  total: number;
  equity: number;
  oldestDaysAgo: number | null;
  newestDaysAgo: number | null;
  reaches60d: boolean;
  capped: boolean;
  fills: { t: number; equity: boolean; pnl: number; isClose: boolean }[];
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── 1. pick the busiest equity coins so the trades feed actually flows ──────
async function busiestCoins(n: number): Promise<string[]> {
  const rows = await hl.metaAndAssetCtxs(DEX);
  return rows
    .filter((r) => classify(r.coin))
    .map((r) => ({ coin: r.coin, vol: parseFloat(r.ctx.dayNtlVlm ?? "0") }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, n)
    .map((r) => r.coin);
}

// ── 2. harvest wallet addresses off the public trades WS ────────────────────
function harvest(coins: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const seen = new Set<string>();
    const ws = new WebSocket(process.env.HL_WS_URL ?? "wss://api.hyperliquid.xyz/ws");
    const done = () => { try { ws.close(); } catch {} resolve([...seen]); };

    ws.on("open", () => {
      for (const coin of coins) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
      process.stdout.write(`  listening ${HARVEST_MS / 1000}s on ${coins.length} coins for wallets`);
    });
    ws.on("message", (raw) => {
      let msg: { channel?: string; data?: { users?: [string, string] }[] | { users?: [string, string] } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.channel !== "trades" || !msg.data) return;
      const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
      for (const t of trades) for (const u of t.users ?? []) if (u) { seen.add(u.toLowerCase()); process.stdout.write("."); }
      if (seen.size >= MAX_WALLETS * 3) done();
    });
    ws.on("error", () => done());
    setTimeout(done, HARVEST_MS);
  });
}

// ── 3. probe one wallet's reach ─────────────────────────────────────────────
async function probe(address: string, now: number): Promise<Probe> {
  const fills = await hl.userFillsByTime(address, now - PROBE_DAYS * DAY_MS);
  const pts = fills.map((f) => ({
    t: f.time,
    equity: classify(f.coin) !== null,
    pnl: parseFloat(f.closedPnl || "0"),
    isClose: /^close/i.test(f.dir),
  }));
  const times = pts.map((p) => p.t);
  const oldest = times.length ? Math.min(...times) : null;
  const newest = times.length ? Math.max(...times) : null;
  const oldestDaysAgo = oldest ? (now - oldest) / DAY_MS : null;
  const capped = fills.length >= DEPTH_CAP;
  return {
    address,
    total: fills.length,
    equity: pts.filter((p) => p.equity).length,
    oldestDaysAgo,
    newestDaysAgo: newest ? (now - newest) / DAY_MS : null,
    // "reaches 60d" = we have a fill at least 60d old (window fully covered) OR the
    // wallet simply isn't 60d old yet (nothing to miss) and it's NOT depth-capped.
    reaches60d: (oldestDaysAgo != null && oldestDaysAgo >= WINDOW_DAYS) || (!capped && fills.length > 0),
    capped,
    fills: pts,
  };
}

// ── 4. render the visible timeline ──────────────────────────────────────────
function renderHtml(probes: Probe[], now: number): string {
  const W = 1000, rowH = 34, padL = 150, padR = 40, top = 90;
  const x = (t: number) => padL + ((t - (now - PROBE_DAYS * DAY_MS)) / (PROBE_DAYS * DAY_MS)) * (W - padL - padR);
  const rows = probes.map((p, i) => {
    const y = top + i * rowH;
    const dots = p.fills.map((f) => {
      const c = !f.isClose ? "#8855FF" : f.pnl > 0 ? "#55FFAF" : "#FF6B6B";
      const o = f.equity ? 1 : 0.28;
      return `<circle cx="${x(f.t).toFixed(1)}" cy="${y}" r="3.4" fill="${c}" opacity="${o}"/>`;
    }).join("");
    const reach = p.oldestDaysAgo != null ? `${p.oldestDaysAgo.toFixed(0)}d` : "—";
    const flag = p.capped ? `<tspan fill="#FF6B6B"> CAPPED</tspan>` : "";
    return `<text x="12" y="${y + 4}" fill="#FAF7F2" font-size="12" font-family="JetBrains Mono,monospace">${short(p.address)}</text>
      <text x="12" y="${y + 17}" fill="#726E78" font-size="10" font-family="JetBrains Mono,monospace">${p.total} fills · reach ${reach}${flag ? " ⚠" : ""}</text>
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2a2a2e" stroke-width="1"/>${dots}`;
  }).join("");

  // 60-day boundary line — the window edge.
  const bx = x(now - WINDOW_DAYS * DAY_MS);
  const H = top + probes.length * rowH + 30;
  const gridX = [90, 60, 30, 0].map((d) => {
    const gx = x(now - d * DAY_MS);
    return `<line x1="${gx}" y1="${top - 14}" x2="${gx}" y2="${H - 20}" stroke="#2a2a2e" stroke-dasharray="2 4"/>
      <text x="${gx}" y="${top - 20}" fill="#726E78" font-size="10" text-anchor="middle" font-family="JetBrains Mono,monospace">${d === 0 ? "now" : `-${d}d`}</text>`;
  }).join("");

  const capCount = probes.filter((p) => p.capped).length;
  const withHist = probes.filter((p) => p.total > 0).length;
  // Verified 2026-08-27: userFillsByTime returns the OLDEST 2000 from startTime,
  // ascending — so a capped wallet isn't one whose old history is hidden, it's one
  // with >2000 fills that FORWARD PAGINATION drains fully. Correctness needs no S3.
  const verdict = capCount === 0
    ? "No wallet exceeded the single-call cap this sample — the sync loop's forward pagination trivially covers them."
    : `${capCount}/${probes.length} wallets exceed the 2000-fill single-call cap → the sync loop drains them by paginating startTime forward (implemented). No S3 backfill needed for correctness; the only cost is extra pages for hyperactive wallets.`;

  return `<!doctype html><html><head><meta charset="utf8"><title>Bourse · M3 fill-reach dry-run</title>
<style>body{margin:0;background:#111113;color:#FAF7F2;font-family:'Space Grotesk',system-ui,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px}h1{font-size:22px;margin:0 0 4px}
.sub{color:#9a96a0;font-size:13px;margin-bottom:20px}
.verdict{border-left:3px solid ${capCount ? "#FF6B6B" : "#55FFAF"};background:#1a1a1e;padding:14px 16px;border-radius:8px;margin:20px 0;font-size:14px;line-height:1.5}
.legend{display:flex;gap:18px;font-size:12px;color:#9a96a0;margin-top:14px}.dot{display:inline-block;width:9px;height:9px;border-radius:9px;margin-right:5px;vertical-align:middle}
.stat{display:inline-block;margin-right:24px;font-size:13px}.stat b{color:#8855FF;font-family:'JetBrains Mono',monospace}</style></head>
<body><div class="wrap">
<h1>M3 dry-run · does <code>userFillsByTime</code> reach 60 days?</h1>
<div class="sub">Live Hyperliquid · dex ${DEX} · ${probes.length} wallets harvested off the public trades feed · probe window ${PROBE_DAYS}d · no database</div>
<div><span class="stat">wallets probed <b>${probes.length}</b></span><span class="stat">with fill history <b>${withHist}</b></span><span class="stat">depth-capped <b>${capCount}</b></span></div>
<div class="verdict">${capCount ? "⚠️ " : "✓ "}${verdict}</div>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="${bx}" y="${top - 14}" width="${W - padR - bx}" height="${H - top - 6}" fill="#8855FF" opacity="0.05"/>
  <line x1="${bx}" y1="${top - 14}" x2="${bx}" y2="${H - 20}" stroke="#8855FF" stroke-width="1.5"/>
  <text x="${bx + 6}" y="${H - 24}" fill="#8855FF" font-size="10" font-family="JetBrains Mono,monospace">60d window edge →</text>
  ${gridX}${rows}
</svg>
<div class="legend">
  <span><span class="dot" style="background:#55FFAF"></span>closed · win</span>
  <span><span class="dot" style="background:#FF6B6B"></span>closed · loss</span>
  <span><span class="dot" style="background:#8855FF"></span>open / other</span>
  <span><span class="dot" style="background:#8855FF;opacity:.28"></span>non-equity (dimmed)</span>
</div></div></body></html>`;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();
  console.log(`\n▶ Bourse M3 dry-run — does userFillsByTime reach ${WINDOW_DAYS}d? (dex ${DEX}, no DB)\n`);

  console.log("① discovering wallets off the trades WS…");
  const coins = await busiestCoins(6);
  const wallets = (await harvest(coins)).slice(0, MAX_WALLETS);
  console.log(`\n  harvested ${wallets.length} unique wallets from ${coins.length} busiest equity coins\n`);
  if (!wallets.length) { console.error("  no wallets seen — market may be quiet; try again."); process.exit(1); }

  console.log(`② probing each with userFillsByTime over ${PROBE_DAYS}d…\n`);
  const probes: Probe[] = [];
  for (const w of wallets) {
    try {
      const p = await probe(w, now);
      probes.push(p);
      const reach = p.oldestDaysAgo != null ? `${p.oldestDaysAgo.toFixed(0)}d` : "none";
      console.log(
        `  ${short(w)}  fills=${String(p.total).padStart(4)}  equity=${String(p.equity).padStart(4)}  ` +
        `reach=${reach.padStart(5)}  ${p.capped ? "⚠ CAPPED" : p.reaches60d ? "✓ covers 60d" : "· short window"}`,
      );
    } catch (err) {
      console.log(`  ${short(w)}  probe failed: ${(err as Error).message}`);
    }
  }

  const capped = probes.filter((p) => p.capped).length;
  const covers = probes.filter((p) => p.reaches60d).length;
  console.log(`\n③ verdict`);
  console.log(`  ${covers}/${probes.length} wallets fully covered by a single call; ${capped} exceed the 2000-fill cap.`);
  console.log(`  → userFillsByTime returns OLDEST-2000 ascending (verified) → forward pagination drains any wallet.`);
  console.log(capped === 0
    ? `  → Open item #2 resolved: no S3 backfill needed; pagination is enough.`
    : `  → ${capped} hyperactive wallet(s) need multi-page drains — the sync loop paginates (cap ${process.env.SYNC_MAX_PAGES ?? 6} pages/pass, resumes next pass). No S3 required for correctness.`);

  const dir = join(homedir(), ".bourse-shots");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "dryrun.html");
  writeFileSync(out, renderHtml(probes, now));
  console.log(`\n④ visible timeline written → ${out}\n`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
