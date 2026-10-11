/**
 * US ticker symbol changes: FB became META on 2022-06-09. Gloom Cloud serves
 * them signed out too; its history starts in April 2017.
 */

/** One change: `from` became `to` on `date` (YYYY-MM-DD). */
export interface TickerChangeHop {
  from: string;
  to: string;
  date: string;
}

export interface TickerChanges {
  symbol: string;
  /**
   * The issuer that last held the symbol left it: the symbol it trades as now,
   * its name when known, and each change on the way, oldest first.
   */
  moved: { symbol: string; name: string | null; hops: TickerChangeHop[] } | null;
  /** The symbols the symbol's current holder traded as before, newest first. */
  formerly: TickerChangeHop[] | null;
  /** What lists under the symbol today, when the service knows its name. */
  listedName: string | null;
  /** Every change on either side of the symbol, newest first. */
  changes: TickerChangeHop[];
}
