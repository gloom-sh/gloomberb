export type TaiwanVenue = "TWSE" | "TPEX";
export type MainlandVenue = "SSE" | "SZSE";
export type KoreanVenue = "KRX" | "KOSDAQ";
export type BalanceVenue = TaiwanVenue | MainlandVenue | KoreanVenue;

interface DailyReport<Venue, Measures> {
  exchange: Venue;
  symbol: string;
  reportsReviewed: number;
  newestReport: string | null;
  points: Array<{ day: string; observedAt: string; sourceUrl: string } & Measures>;
}

export type TaiwanShortBalances = DailyReport<TaiwanVenue, {
  marginBalance: number; marginSold: number; sblBalance: number; sblSold: number;
}>;
export type MainlandLendingBalances = DailyReport<MainlandVenue, { outstanding: number; sold: number }>;
export type KoreanShortPositions = DailyReport<KoreanVenue, {
  netShort: number; listedShares: number; valueKrw: number; percent: number;
}>;

export type SgxShortSales = DailyReport<"SGX", {
  shortVolume: number; shortValue: number; currency: string; security: string;
}>;
