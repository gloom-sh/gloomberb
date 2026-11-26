import { parsePublicTickerKey } from "../utils/exchanges";

type TwVenue = "TWSE" | "TPEX";

export interface TaiwanRevenuePoint {
  yearMonth: string;
  revenueTwdK: number;
  revenueTwdB: number;
  prevMonthTwdK: number | null;
  prevYearTwdK: number | null;
  momPct: number | null;
  yoyPct: number | null;
  yoyAccelPp: number | null;
  ytdTwdK: number | null;
  ytdYoyPct: number | null;
  notes: string | null;
  sourceUrl: string;
}

export interface TaiwanStockRevenuePayload {
  company: {
    code: string;
    symbol: string;
    venue: TwVenue;
    nameZh: string;
    nameEn: string | null;
    industryZh: string | null;
    industryEn: string | null;
    baskets: string[];
    linkedUsTickers: string[];
  };
  latestMonth: string;
  latest: TaiwanRevenuePoint;
  threeMonthAvgYoyPct: number | null;
  consecutiveYoyGrowthMonths: number;
  historyCount: number;
  history: TaiwanRevenuePoint[];
}

export interface TaiwanBoardRow {
  code: string;
  symbol: string;
  venue: TwVenue;
  nameZh: string;
  nameEn: string | null;
  industryEn: string | null;
  baskets: string[];
  linkedUsTickers: string[];
  yearMonth: string;
  revenueTwdK: number;
  revenueTwdB: number;
  momPct: number | null;
  yoyPct: number | null;
  priorYoyPct: number | null;
  yoyAccelPp: number | null;
  ytdTwdK: number | null;
  ytdYoyPct: number | null;
}

export interface TaiwanBasketPoint {
  yearMonth: string;
  totalRevenueTwdB: number;
  yoyPct: number | null;
  momPct: number | null;
  yoyAccelPp: number | null;
  constituentsReporting: number;
}

export interface TaiwanUsReadthroughPayload {
  usTicker: string;
  latestMonth: string | null;
  supplierCount: number;
  aggregateRevenueTwdB: number | null;
  aggregateYoyPct: number | null;
  aggregateMomPct: number | null;
  yoyAccelPp: number | null;
  series: TaiwanBasketPoint[];
  suppliers: TaiwanBoardRow[];
}

const US_READTHROUGH_TICKERS: ReadonlySet<string> = new Set([
  "NVDA",
  "AAPL",
  "AMD",
  "MSFT",
  "META",
  "AMZN",
  "GOOGL",
  "AVGO",
  "QCOM",
  "TSLA",
  "MU",
  "INTC",
  "SMCI",
  "MRVL",
  "WDC",
]);

/** Resolves a Taiwan listing (`2330:TWSE`, `2330.TW`, `6488.TWO`) to its 4-6 char MOPS code. */
export function taiwanRevenueCode(
  key: string | null | undefined,
  exchange?: string,
): string | null {
  if (!key) return null;
  const trimmed = key.trim().toUpperCase();
  const direct = /^([A-Z0-9]{4,6})(?:\.(?:TW|TWO)|:(?:TWSE|TPEX))$/.exec(trimmed);
  if (direct) return direct[1]!;
  const parsed = parsePublicTickerKey(trimmed);
  const ex = (exchange ?? parsed.exchange ?? "").trim().toUpperCase();
  if ((ex === "TWSE" || ex === "TPEX" || ex === "XTAI" || ex === "ROCO") && /^[A-Z0-9]{4,6}$/.test(parsed.symbol)) {
    return parsed.symbol;
  }
  return null;
}

/** Returns the US ticker when it has mapped Taiwan monthly revenue supply-chain read-through. */
export function taiwanUsReadthroughTicker(
  key: string | null | undefined,
  exchange?: string,
): string | null {
  if (!key) return null;
  if (taiwanRevenueCode(key, exchange)) return null;
  const parsed = parsePublicTickerKey(key.trim().toUpperCase());
  const clean = parsed.symbol.replace(/\.US$/, "");
  return US_READTHROUGH_TICKERS.has(clean) ? clean : null;
}

export function cloudTaiwanStockRevenuePath(code: string, limit = 36): string {
  return `/cloud/taiwan-revenue/stocks/${encodeURIComponent(code)}?limit=${limit}`;
}

export function cloudTaiwanUsReadthroughPath(ticker: string, months = 24): string {
  return `/cloud/taiwan-revenue/us-readthrough/${encodeURIComponent(ticker.toUpperCase())}?months=${months}`;
}
