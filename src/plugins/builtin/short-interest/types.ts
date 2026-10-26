export interface ShortInterestRecord {
  settlementDate: Date;
  sharesShort: number;
  shortRatio: number | null;
  averageDailyVolume: number | null;
  shortPercentFloat: number | null;
  /**
   * The 10-K or 10-Q cover share count known when FINRA published the
   * settlement, which its percent of float is read on; null when none was.
   */
  sharesOutstanding?: number | null;
  /** YYYY-MM-DD that count was taken. */
  sharesOutstandingAsOf?: string | null;
  /** YYYY-MM-DD of the share count `shortPercentFloat` is read on, when that count is dated. */
  floatAsOf?: string | null;
}
