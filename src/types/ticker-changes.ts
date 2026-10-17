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
  /**
   * The issuer that last held the symbol merged into another company: GOGL
   * was Golden Ocean Group Ltd until 2025-08-20, and CMB.Tech, which it merged
   * into, trades as CMBT. Null or absent when none is on record.
   */
  formerIssuer?: FormerIssuerRecord | null;
}

/** A merged issuer as Gloom Cloud records it, from the SEC filings that name both companies. */
export interface FormerIssuerRecord {
  /** What it traded as: GOGL. */
  symbol: string;
  name: string;
  /** YYYY-MM-DD: the day its shares were removed from the exchange. */
  until: string;
  /** The company it merged into, as it trades today. */
  successor: { symbol: string; name: string | null };
  /** The filing that names both. */
  source: string | null;
}
