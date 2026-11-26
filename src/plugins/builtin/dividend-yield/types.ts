import type { DividendLapse } from "../../../utils/forward-dividend";
import type { DistributionCadence, TrailingPayments } from "../../../utils/trailing-dividend";
import type { DividendCashEstimate, DividendNoticeSource } from "../../../types/financials";

export interface DividendPayment {
  exDate: Date;
  recordDate: Date | null;
  paymentDate: Date | null;
  declarationDate: Date | null;
  amount: number;
  currency: string;
  type: "cash" | "special" | "stock" | "unknown";
  /** The amount as the company declared it, in another currency than `currency` (BP's dollars beside the pence its London line paid). */
  declared?: { amount: number; currency: string };
  cashEstimate?: DividendCashEstimate;
  source?: DividendNoticeSource;
  /** The amount is a regular payment and an extra one on the same ex-date, which the history keeps as one row (combinedPaymentTimes). */
  combined?: true;
  /** The issuer's own dividend announcement form says it is a special (CashDistribution.special). */
  special?: true;
  /** The issuer's own form says what it is: one of the dividends a history row holds (DividendAction.parts). */
  formTyped?: true;
  /** That form's dividend type: "Final", "Interim (Semi-annual)", "Other Special Dividend". */
  formType?: string;
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
  /** The ex-date of the distribution the forward rate annualizes, YYYY-MM-DD; with `forwardBasis`, the latest of the year's payments. */
  forwardRateAsOf: string | null;
  forwardEstimate?: DividendCashEstimate;
  trailingEstimates?: DividendCashEstimate[];
  /** `uneven`: the year's regular payments differ widely, so the forward rate is their total rather than one annualized (unevenRegularPayments). */
  forwardBasis?: "uneven" | null;
  /** Set once the dividend has stopped (lapsedDividend), when there is no forward rate or yield. */
  lapse?: DividendLapse | null;
  payoutRatio: number | null;
  /** Trailing EPS is zero or negative, so a payout ratio says nothing: shown "N/M", never a ratio. */
  payoutNotMeaningful?: boolean;
  /** A regular payer's trailing year holds fewer payments than its cadence: the yield counts only these. */
  trailingPayments?: TrailingPayments | null;
  /** The specials the issuer's forms type in the trailing year, summed: the trailing rate counts them, the forward rate never does. */
  trailingSpecial?: number;
  growth1Y: number | null;
  growth3Y: number | null;
  /** Set when one of the two years 1Y growth compares holds fewer payments than the cadence pays: no growth, and how many it holds. */
  growth1YPayments?: GrowthPayments | null;
  /** The same for the two years the 3Y rate compares. */
  growth3YPayments?: GrowthPayments | null;
  /** Set when the earlier year 1Y growth compares paid no cash and the trailing year did (a resumed dividend): growth off zero, N/M. */
  growth1YNotMeaningful?: boolean;
  /** The same for the 3Y rate. */
  growth3YNotMeaningful?: boolean;
  paymentFrequency: DistributionCadence | null;
  lastExDividendDate: Date | null;
  /** Announced ex-date after now, from the summary or a future-dated history record. */
  nextExDividendDate: Date | null;
  nextPayDate: Date | null;
  /** The company's other listing (HSBA:LSE) nextExDividendDate is stated by, where this listing states none. */
  nextExDividendDateListing?: string;
  /** The company's other listing nextPayDate is stated by: 0005:HKEX's 17 Dec pay date is HSBA:LSE's. */
  nextPayDateListing?: string;
}
