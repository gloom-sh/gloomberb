import type { CreditLevelKind } from "../credit-boards";

/** One publicly disseminated single-name CDS transaction report. */
export interface CloudCdsTradePayload {
  disseminationId: string;
  originalDisseminationId: string | null;
  actionType: string;
  eventTimestamp: string;
  executionTimestamp: string | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  maturityDate: string | null;
  issuerName: string | null;
  underlierId: string | null;
  underlierIdSource: string | null;
  upi: string | null;
  upiFisn: string | null;
  upiUnderlierName: string | null;
  notionalAmount: number | null;
  /** Reported notional is a regulatory cap, so the real trade was at least this size. */
  notionalCapped: boolean;
  notionalCurrency: string | null;
  fixedRate: number | null;
  reportedSpread: number | null;
  /** Unit of `reportedSpread`, e.g. basis points or percent. */
  spreadNotation: string | null;
  upfrontAmount: number | null;
  upfrontCurrency: string | null;
}

export interface CloudCdsResponse {
  source: string;
  asOf: string | null;
  trades: CloudCdsTradePayload[];
}

/** One New York trade date of an issuer's on-the-run 5Y spread. */
export interface CloudCdsHistoryPointPayload {
  date: string;
  /** Median of the day's prints in basis points. */
  spreadBp: number;
  prints: number;
  /** Prints that reported the spread; the rest were converted from their upfront. */
  reported: number;
  /** The contract on the run that day, e.g. "2031-12-20". */
  maturity: string;
  /** For a line quoted upfront: that day's level in points on the line's coupon. */
  upfrontPts?: number;
  /** The day's trades, or the settlement price on a day without enough of them (`prints` 0). */
  kind?: CreditLevelKind;
}

/**
 * Past 2,000bp a name is quoted in points upfront on its running coupon, the
 * level and its moves alike; `spreadBp` and the bp moves stay beside them.
 * Absent from servers before it, which read as `spread`.
 */
interface CloudCdsUpfrontQuote {
  quote?: "spread" | "upfront";
  /** The line's running coupon, bp. */
  couponBp?: number | null;
  upfrontPts?: number | null;
  change1WPts?: number | null;
  change1MPts?: number | null;
}

export interface CloudCdsHistoryResponse extends CloudCdsUpfrontQuote {
  source: string;
  /** The matched reference entity, or null when nothing on the tape matched. */
  issuer: string | null;
  tenor: string;
  currency: string | null;
  asOf: string | null;
  points: CloudCdsHistoryPointPayload[];
  /**
   * The last point's move over a week and a month in bp, on one contract and
   * chained through the contract before across a roll, as the index board's.
   * Null without a comparable level, or once the level is more than 5 trading
   * days behind the tape; absent from servers before them.
   */
  change1W?: number | null;
  change1M?: number | null;
  /**
   * Why the line has no level in the month to its newest print, when one
   * cause explains it: `upfront-side-unknown` when the prints carry an
   * upfront without the side that paid it and nothing else places the level.
   */
  noLevelReason?: string | null;
}

/** An issuer's latest 5Y level: the last point of its history over the last month. */
export interface CloudCdsLevelPayload extends CloudCdsUpfrontQuote {
  /** The reference entity as the history response names it. */
  issuer: string;
  spreadBp: number;
  date: string;
  /** As the history response's last point. */
  kind?: CreditLevelKind;
  /** As the history response's moves for the same name. */
  change1W?: number | null;
  change1M?: number | null;
}

export interface CloudCdsLevelsResponse {
  source: string;
  tenor: string;
  asOf: string | null;
  /** Every issuer traded in the last month whose 5Y line has a level in it. */
  levels: CloudCdsLevelPayload[];
}
