import type { Quote } from "../../types/financials";

export interface CloudQuotePayload extends Omit<Quote, "change" | "changePercent" | "priceBasis" | "priceObservation"> {
  /** The service labels daily NAV here; the app separates observation kind from price units. */
  priceBasis?: Quote["priceBasis"] | "nav";
  // JSON encodes the provider's unavailable numeric values as null.
  change?: number | null;
  changePercent?: number | null;
  providerId: "gloomberb-cloud";
  dataSource: "live" | "delayed";
}

export interface QuoteStreamTarget {
  symbol: string;
  exchange?: string;
  surface?:
    | "portfolio"
    | "watchlist"
    | "detail"
    | "monitor"
    | "inline"
    | "options"
    | "screener"
    | "unknown";
  visible?: boolean;
  selected?: boolean;
  weight?: number;
}
