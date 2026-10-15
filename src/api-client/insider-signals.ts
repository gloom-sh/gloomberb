/**
 * Companies ranked by recent open-market insider buying, as
 * `GET /cloud/sec/insider-signals` returns them. Only Form 4 purchases (code
 * P) by officers, directors and 10% owners count. Dates are `YYYY-MM-DD`,
 * values USD.
 */

type InsiderSignalRole =
  | "CEO"
  | "CFO"
  | "COO"
  | "President"
  | "Chair"
  | "Officer"
  | "Director"
  | "10% owner";

interface InsiderSignalBuyer {
  name: string;
  role: InsiderSignalRole;
  value: number;
  /** Days the insider bought in the window. */
  buys: number;
  lastBuy: string;
}

export interface InsiderSignalRow {
  ticker: string;
  issuerCik: string;
  company: string;
  /** 0 to 100. */
  score: number;
  /** Why the company ranks, strongest first, in plain words. */
  reasons: string[];
  /** Distinct insiders who bought in the window. */
  insiders: number;
  /** Insider buy days in the window. */
  buys: number;
  value: number;
  shares: number;
  firstBuy: string;
  lastBuy: string;
  lastFiled: string;
  signals: {
    clusterInsiders: number;
    repeatBuys: number;
    usualRatio: number | null;
    stakeIncreasePct: number | null;
    newPosition: boolean;
  };
  /** The biggest buyers, up to five. */
  buyers: InsiderSignalBuyer[];
}

export interface InsiderSignalsPayload {
  /** Days of buying each row covers, ending `through`. */
  window: number;
  through: string;
  /** The newest filing day read. */
  asOf: string | null;
  /** Days whose filings have all been read. */
  coverage: { from: string | null; through: string | null };
  rows: InsiderSignalRow[];
}

export interface CloudInsiderSignalsParams {
  /** Days, 1 to 90; the server reads 30 when left out. */
  window?: number;
  /** Rows, 1 to 200; the server reads 50 when left out. */
  limit?: number;
}
