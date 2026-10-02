/**
 * Index CDS (CDX IG, HY, EM, iTraxx Main and Crossover) and sovereign 5Y CDS
 * as daily levels built from DTCC public dissemination.
 */

export interface CreditBoardPoint {
  date: string;
  level: number;
  prints: number;
  /** The contract that was on the run that day, e.g. "2031-12-20". */
  maturity: string;
}

/** IG and iTraxx trade on spread (bp); HY and EM on price. */
export type CreditIndexQuote = "spread" | "price";

export interface CdxBoardIndex {
  id: string;
  name: string;
  quote: CreditIndexQuote;
  currency: string;
  couponBp: number;
  date: string | null;
  maturity: string | null;
  level: number | null;
  prints: number | null;
  /** In the quote's unit, on one contract across a roll. */
  change1D: number | null;
  change1W: number | null;
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
