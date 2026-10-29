/**
 * Index CDS (CDX IG, HY, EM, iTraxx Main and Crossover) and sovereign 5Y CDS
 * as daily levels built from DTCC public dissemination.
 */

/**
 * What a day's level rests on: the day's trades, or the clearing house's
 * end-of-day settlement price on a day without enough agreeing trades (its
 * `prints` is then 0). Absent from a server that predates it, which read as
 * `traded`.
 */
export type CreditLevelKind = "traded" | "settlement";

export interface CreditBoardPoint {
  date: string;
  level: number;
  prints: number;
  kind?: CreditLevelKind;
  /** The contract that was on the run that day, e.g. "2031-12-20". */
  maturity: string;
  /**
   * HY and EM: the day's price as a conventional spread in bp (ISDA standard
   * model at the index's coupon and standard recovery). Absent from a server
   * that predates it and on spread-quoted indexes; null where no spread fits.
   */
  spreadBp?: number | null;
}

/** IG and iTraxx trade on spread (bp); HY and EM on price. */
export type CreditIndexQuote = "spread" | "price";

export interface CdxBoardIndex {
  id: string;
  name: string;
  quote: CreditIndexQuote;
  currency: string;
  couponBp: number;
  /** The recovery the spread equivalent assumes (HY 30%, EM 25%). Absent from a server that predates it. */
  recovery?: number;
  date: string | null;
  maturity: string | null;
  level: number | null;
  prints: number | null;
  /** What the latest level rests on, as on each point; null without a level. */
  kind?: CreditLevelKind | null;
  /** HY and EM: the latest level as a conventional spread in bp, as on each point. */
  spreadBp?: number | null;
  /**
   * The latest day is today's New York trade date, still trading: its level
   * and prints are so far and the moves run to `changeDate`. Absent from a
   * server that predates it, which the board then works out from the date.
   */
  partial?: boolean;
  /** When the latest day's last print on its contract was executed, ISO UTC. */
  lastPrintAt?: string | null;
  /** The last complete day, which the moves run to. */
  changeDate?: string | null;
  /** In the quote's unit, on one contract across a roll, between complete days. */
  change1D: number | null;
  change1W: number | null;
  /** Absent from a server that predates it. */
  change1M?: number | null;
  /** Oldest first, the on-the-run 5Y contract each day. */
  points: CreditBoardPoint[];
}

export interface CdxBoardPayload {
  source: string;
  asOf: string | null;
  tenor: "5Y";
  indexes: CdxBoardIndex[];
}

export interface SovrBoardSovereign {
  id: string;
  name: string;
  /** Local currency, for the FX move beside the spread. */
  currency: string;
  date: string;
  maturity: string;
  /** 5Y spread in bp. */
  level: number;
  prints: number;
  reported: number;
  /** What the latest level rests on, as on each point. */
  kind?: CreditLevelKind;
  change1W: number | null;
  change1M: number | null;
  points: CreditBoardPoint[];
}

export interface SovrBoardPayload {
  source: string;
  asOf: string | null;
  tenor: "5Y";
  /** Widest 1M move first. */
  sovereigns: SovrBoardSovereign[];
}

export interface CloudCreditBoardParams {
  days?: number;
}
