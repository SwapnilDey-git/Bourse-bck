import { SEEDED_LOGOS } from "./logos.seeded";

// Ticker → hosted logo URL. SEEDED_LOGOS is auto-generated (Massive/Finnhub,
// US-market only — see logos.seeded.ts and scripts/seed-logos.mjs). Neither
// free tier covers foreign/private listings, so the 8 below are hand-curated
// from Wikimedia Commons (search "<company> logo", first File: result,
// resolved via the imageinfo API) — the same asset host trade[XYZ]'s own
// terminal CSP whitelists (commons/upload/thumb.wikimedia.org) alongside
// *.hyperliquid.xyz. Commons search is fuzzy and false-positives easily on
// non-company queries (e.g. "S&P 500 logo" → unrelated files), so this is NOT
// wired into the automated seed script as a general fallback — each entry
// below was resolved and visually verified by hand. Indices/ETFs (SP500,
// XYZ100, EWJ, SMH, ...) intentionally have no entry here or in the seed
// block; they have no company to have a logo, and the StockLogo monogram
// fallback is correct for them.
const WIKI_LOGOS: Record<string, string> = {
  SKHX: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/24/SK_Hynix.svg/250px-SK_Hynix.svg.png",
  KIOXIA: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e8/Kioxia.svg/250px-Kioxia.svg.png",
  IBIDEN: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/76/Ibiden_company_logo.svg/250px-Ibiden_company_logo.svg.png",
  SOFTBANK: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a7/SoftBank_Group_logo.svg/250px-SoftBank_Group_logo.svg.png",
  SMSN: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4e/Samsung_Electronics_logo_%28english%29.svg/250px-Samsung_Electronics_logo_%28english%29.svg.png",
  UNITREE: "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fc/Unitree.svg/250px-Unitree.svg.png",
  SHEIN: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c5/Shein_Logo_2017.svg/250px-Shein_Logo_2017.svg.png",
  HYUNDAI: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/44/Hyundai_Motor_Company_logo.svg/250px-Hyundai_Motor_Company_logo.svg.png",
};

export const LOGOS: Record<string, string> = { ...SEEDED_LOGOS, ...WIKI_LOGOS };
