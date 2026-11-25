export type StockConnectVenue = "HKEX" | "SSE" | "SZSE";

export interface StockConnectReport {
  symbol: string;
  exchange: StockConnectVenue;
  routes: {
    venue: "SSE" | "SZSE";
    direction: "northbound" | "southbound";
    status: "buy-sell" | "sell-only" | "not-listed" | "not-on-buy-list" | "unknown";
    publishedOn: string | null;
    checkedAt: string | null;
    sourceUrl: string;
  }[];
}
