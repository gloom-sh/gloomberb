import type { DividendLapse } from "../../../utils/forward-dividend";

export interface DividendPayment {
  exDate: Date;
  recordDate: Date | null;
  paymentDate: Date | null;
  declarationDate: Date | null;
  amount: number;
  currency: string;
  type: "cash" | "special" | "stock" | "unknown";
}

export interface DividendMetrics {
  trailingYield: number | null;
  forwardYield: number | null;
  trailingRate: number | null;
  forwardRate: number | null;
  /** The ex-date of the distribution the forward rate annualizes, YYYY-MM-DD. */
  forwardRateAsOf: string | null;
  /** Set once the dividend has stopped (lapsedDividend), when there is no forward rate or yield. */
  lapse?: DividendLapse | null;
  payoutRatio: number | null;
  growth1Y: number | null;
  growth3Y: number | null;
  paymentFrequency: "monthly" | "quarterly" | "semi-annual" | "annual" | "irregular" | null;
  lastExDividendDate: Date | null;
  /** Announced ex-date after now, from the summary or a future-dated history record. */
  nextExDividendDate: Date | null;
  nextPayDate: Date | null;
}
