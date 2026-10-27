import type { QuoteDataSource } from "../../../types/financials";

export type AlertCondition = "above" | "below" | "crosses";
export type AlertStatus = "active" | "triggered" | "expired";

export interface AlertRule {
  id: string;
  symbol: string;
  exchange?: string;
  condition: AlertCondition;
  targetPrice: number;
  metric?: import("./metric-model").AlertMetric;
  lastDailyClose?: string;
  lastCheckedTarget?: number;
  createdAt: number;
  /** When an edit or re-arm last armed the rule; createdAt until then. Gloom Cloud emails a trigger once per arming. */
  armedAt?: number;
  status: AlertStatus;
  triggeredAt?: number;
  lastCheckedPrice?: number;
  lastCheckedAt?: number;
  lastCheckError?: string;
  lastQuoteUpdatedAt?: number;
  lastQuoteSource?: QuoteDataSource;
  lastQuoteProviderId?: string;
  /** The currency of the quote the alert was last checked on (USD): its listing's, which lists show beside it. */
  lastQuoteCurrency?: string;
  /** The venue that quote was from (ARCA), which names the listing of a rule set by symbol alone. */
  lastQuoteExchange?: string;
  message?: string;
}
