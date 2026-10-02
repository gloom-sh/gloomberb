import type { QuoteDataSource } from "../../../types/financials";

export type AlertCondition = "above" | "below" | "crosses";
export type AlertStatus = "active" | "triggered" | "expired";

export interface AlertRule {
  id: string;
  symbol: string;
  exchange?: string;
  condition: AlertCondition;
  targetPrice: number;
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
  message?: string;
}
