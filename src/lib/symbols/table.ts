// The owned symbol → company/sector table (M1). Hyperliquid's universe only
// carries the coin string ("xyz:NVDA"), never a company name or sector — so we
// own this mapping. Curated against the live trade.xyz lineup (117 coins, 2026-08).
//
// Scope (locked): single-name equities + equity indices/ETFs only. Commodities,
// FX, rates, volatility and pre-IPO on the same dex are EXCLUDED. Any ticker not
// excluded defaults to an equity (ticker as name) so the grid stays broad and
// self-updating — MAINTENANCE NOTE: when the dex lists new NON-equity coins,
// add them to EXCLUDE or they'll show as equities.

export type EquityMeta = { name: string; sector: string };

export const EQUITY_META: Record<string, EquityMeta> = {
  // Semiconductors
  NVDA: { name: "NVIDIA", sector: "Semiconductors" },
  AMD: { name: "Advanced Micro Devices", sector: "Semiconductors" },
  AVGO: { name: "Broadcom", sector: "Semiconductors" },
  INTC: { name: "Intel", sector: "Semiconductors" },
  MU: { name: "Micron Technology", sector: "Semiconductors" },
  QCOM: { name: "Qualcomm", sector: "Semiconductors" },
  AMAT: { name: "Applied Materials", sector: "Semiconductors" },
  ARM: { name: "Arm Holdings", sector: "Semiconductors" },
  MRVL: { name: "Marvell Technology", sector: "Semiconductors" },
  TSM: { name: "Taiwan Semiconductor", sector: "Semiconductors" },
  ASML: { name: "ASML Holding", sector: "Semiconductors" },
  SNDK: { name: "SanDisk", sector: "Semiconductors" },
  WDC: { name: "Western Digital", sector: "Semiconductors" },
  LITE: { name: "Lumentum", sector: "Semiconductors" },
  AAOI: { name: "Applied Optoelectronics", sector: "Semiconductors" },
  SKHX: { name: "SK Hynix", sector: "Semiconductors" },
  SKHY: { name: "SK Hynix", sector: "Semiconductors" },
  KIOXIA: { name: "Kioxia Holdings", sector: "Semiconductors" },
  IBIDEN: { name: "Ibiden", sector: "Semiconductors" },
  // Technology / software / internet
  MSFT: { name: "Microsoft", sector: "Technology" },
  AAPL: { name: "Apple", sector: "Technology" },
  GOOGL: { name: "Alphabet", sector: "Technology" },
  META: { name: "Meta Platforms", sector: "Technology" },
  ORCL: { name: "Oracle", sector: "Technology" },
  PLTR: { name: "Palantir", sector: "Technology" },
  CRWV: { name: "CoreWeave", sector: "Technology" },
  CRWD: { name: "CrowdStrike", sector: "Technology" },
  NET: { name: "Cloudflare", sector: "Technology" },
  NOW: { name: "ServiceNow", sector: "Technology" },
  IBM: { name: "IBM", sector: "Technology" },
  DELL: { name: "Dell Technologies", sector: "Technology" },
  BB: { name: "BlackBerry", sector: "Technology" },
  ZM: { name: "Zoom", sector: "Technology" },
  NBIS: { name: "Nebius Group", sector: "Technology" },
  IREN: { name: "IREN Limited", sector: "Technology" },
  SOFTBANK: { name: "SoftBank Group", sector: "Technology" },
  SMSN: { name: "Samsung Electronics", sector: "Technology" },
  UNITREE: { name: "Unitree Robotics", sector: "Technology" },
  // Communication / internet
  NFLX: { name: "Netflix", sector: "Communication Services" },
  RDDT: { name: "Reddit", sector: "Communication Services" },
  AMZN: { name: "Amazon", sector: "Consumer Discretionary" },
  BABA: { name: "Alibaba", sector: "Consumer Discretionary" },
  EBAY: { name: "eBay", sector: "Consumer Discretionary" },
  SHEIN: { name: "Shein", sector: "Consumer Discretionary" },
  BIRD: { name: "Allbirds", sector: "Consumer Discretionary" },
  DKNG: { name: "DraftKings", sector: "Consumer Discretionary" },
  GME: { name: "GameStop", sector: "Consumer Discretionary" },
  COST: { name: "Costco", sector: "Consumer Staples" },
  // Financials / crypto-adjacent
  COIN: { name: "Coinbase", sector: "Financial Services" },
  HOOD: { name: "Robinhood", sector: "Financial Services" },
  MSTR: { name: "MicroStrategy", sector: "Financial Services" },
  BX: { name: "Blackstone", sector: "Financial Services" },
  CRCL: { name: "Circle Internet", sector: "Financial Services" },
  // Healthcare
  LLY: { name: "Eli Lilly", sector: "Healthcare" },
  HIMS: { name: "Hims & Hers Health", sector: "Healthcare" },
  MRNA: { name: "Moderna", sector: "Healthcare" },
  // Auto / EV / industrials / space / materials
  TSLA: { name: "Tesla, Inc.", sector: "Automotive" },
  RIVN: { name: "Rivian", sector: "Automotive" },
  HYUNDAI: { name: "Hyundai Motor", sector: "Automotive" },
  GEV: { name: "GE Vernova", sector: "Industrials" },
  BE: { name: "Bloom Energy", sector: "Industrials" },
  RKLB: { name: "Rocket Lab", sector: "Aerospace" },
  USAR: { name: "USA Rare Earth", sector: "Materials" },
};

// Equity indices & sector/country ETFs — included (kind: "index").
export const INDEX_META: Record<string, EquityMeta> = {
  XYZ100: { name: "Nasdaq-100 (synthetic)", sector: "Equity Index" },
  SP500: { name: "S&P 500", sector: "Equity Index" },
  NIFTY: { name: "Nifty 50 (India)", sector: "Equity Index" },
  JP225: { name: "Nikkei 225 (Japan)", sector: "Equity Index" },
  KR200: { name: "KOSPI 200 (Korea)", sector: "Equity Index" },
  IBOV: { name: "Bovespa (Brazil)", sector: "Equity Index" },
  MAGS: { name: "Magnificent 7 ETF", sector: "Equity Index" },
  SMH: { name: "Semiconductor ETF", sector: "Equity Index" },
  SOXL: { name: "Semiconductor Bull 3x ETF", sector: "Equity Index" },
  XBI: { name: "Biotech ETF", sector: "Equity Index" },
  XLE: { name: "Energy Sector ETF", sector: "Equity Index" },
  URNM: { name: "Uranium Miners ETF", sector: "Equity Index" },
  EWJ: { name: "Japan ETF", sector: "Equity Index" },
  EWT: { name: "Taiwan ETF", sector: "Equity Index" },
  EWY: { name: "South Korea ETF", sector: "Equity Index" },
  EWZ: { name: "Brazil ETF", sector: "Equity Index" },
  KORU: { name: "Korea Bull 3x ETF", sector: "Equity Index" },
};
export const INDEX_TICKERS = new Set<string>(Object.keys(INDEX_META));

// Not single-name equities or equity indices → excluded from Bourse v1.
// Commodities · FX · rates · volatility · pre-IPO (verified against the live set).
export const EXCLUDE_TICKERS = new Set<string>([
  // commodities
  "GOLD", "SILVER", "PLATINUM", "PALLADIUM", "COPPER", "ALUMINIUM", "URANIUM",
  "BRENTOIL", "CL", "WTI", "OIL", "NATGAS", "TTF", "CORN", "WHEAT", "SUGAR",
  "COFFEE", "COCOA", "DRAM", "XAU", "XAG",
  // FX
  "EUR", "GBP", "JPY", "KRW", "NOK", "CNY", "CHF", "AUD", "CAD",
  // rates / index-of-things / volatility
  "DXY", "VIX", "VOL",
  // pre-IPO / non-listed / ambiguous synthetic
  "SPCX", "H100",
]);
