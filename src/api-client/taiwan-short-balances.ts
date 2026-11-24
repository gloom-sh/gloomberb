export type TaiwanVenue = "TWSE" | "TPEX";

export interface TaiwanShortBalance {
  day: string;
  observedAt: string;
  sourceUrl: string;
  marginBalance: number;
  marginSold: number;
  sblBalance: number;
  sblSold: number;
}

export interface TaiwanShortBalances {
  exchange: TaiwanVenue;
  symbol: string;
  reportsReviewed: number;
  newestReport: string | null;
  points: TaiwanShortBalance[];
}
