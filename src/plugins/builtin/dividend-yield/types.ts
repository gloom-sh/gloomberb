import type { DividendLapse } from "../../../utils/forward-dividend";
import type { DistributionCadence, TrailingPayments } from "../../../utils/trailing-dividend";

export interface DividendPayment {
  exDate: Date;
  recordDate: Date | null;
  paymentDate: Date | null;
  declarationDate: Date | null;
  amount: number;
  currency: string;
  type: "cash" | "special" | "stock" | "unknown";
}

/** A short year a growth figure would compare: its payments, and the day it ends (absent for the trailing year). */
export interface GrowthPayments extends TrailingPayments {
  /** YYYY-MM-DD; absent when the short year is the trailing one. */
  yearTo?: string;
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
  /** Trailing EPS is zero or negative, so a payout ratio says nothing: shown "N/M", never a ratio. */
  payoutNotMeaningful?: boolean;
  /** A regular payer's trailing year holds fewer payments than its cadence: the yield counts only these. */
  trailingPayments?: TrailingPayments | null;
  growth1Y: number | null;
  growth3Y: number | null;
  /** Set when one of the two years 1Y growth compares holds fewer payments than the cadence pays: no growth, and how many it holds. */
  growth1YPayments?: GrowthPayments | null;
  /** The same for the two years the 3Y rate compares. */
  growth3YPayments?: GrowthPayments | null;
  paymentFrequency: DistributionCadence | null;
  lastExDividendDate: Date | null;
  /** Announced ex-date after now, from the summary or a future-dated history record. */
  nextExDividendDate: Date | null;
  nextPayDate: Date | null;
}
