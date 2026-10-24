import type { BrokerContractRef, PriceBasis } from "./instrument";

export interface TickerPosition {
  portfolio: string;
  shares: number;
  /** Absent when the source did not provide a finite cost; explicit zero is retained. */
  avgCost?: number;
  priceBasis?: PriceBasis;
  currency?: string;
  dateAcquired?: string;
  /**
   * What one unit of the lot's `currency` cost in `costFxCurrency` when it was
   * bought: entered with the position, or the FX close of its purchase date.
   * Valued in that currency, the lot's cost converts at this rate rather than
   * today's, so its P&L carries the currency's move since.
   */
  costFxRate?: number;
  /** The currency `costFxRate` converts the cost into: the portfolio's when it was entered. */
  costFxCurrency?: string;
  broker: string; // "manual" | future broker plugin IDs
  side?: "long" | "short";
  marketValue?: number;
  unrealizedPnl?: number;
  /** Contract multiplier (e.g. 100 for options) */
  multiplier?: number;
  /** Last known mark price from broker snapshot */
  markPrice?: number;
  brokerInstanceId?: string;
  brokerAccountId?: string;
  brokerContractId?: number;
  /** Source-declared fallback contract identity when no canonical conId was supplied. */
  brokerContractIdentity?: string;
}

export interface TickerMetadata {
  ticker: string;
  exchange: string;
  currency: string;
  name: string;
  sector?: string;
  industry?: string;
  assetCategory?: string; // STK, ETF, OPT, FUT, BOND, etc.
  isin?: string;
  cusip?: string;
  portfolios: string[];
  watchlists: string[];
  positions: TickerPosition[];
  broker_contracts?: BrokerContractRef[];
  custom: Record<string, unknown>;
  tags: string[];
  /**
   * Lots this listing's row took from rows saved under a vendor's suffixed
   * key (GARAN.IS:BIST into GARAN:BIST), by that key, each as the fields sync
   * keeps: a copy an older build or sync brings back is not counted twice.
   * Bookkeeping, never shown, and no reason on its own to keep a row.
   */
  mergedLots?: Record<string, string[]>;
}

export interface TickerRecord {
  metadata: TickerMetadata;
}

export interface Portfolio {
  id: string;
  name: string;
  description?: string;
  currency: string;
  brokerId?: string;
  brokerInstanceId?: string;
  brokerAccountId?: string;
  lastSyncedAt?: number;
  /** Set on paper portfolios shared with a team; the server holds the items. */
  teamId?: string;
  /**
   * Cash held beside the positions, entered by hand. A broker account that
   * reports its own cash is shown instead of this.
   */
  cash?: PortfolioCash;
  /**
   * Target weights in percent of the total value, cash included, or of the
   * gross exposure in a book that holds a short (allocation.ts WeightBasis),
   * keyed by ticker symbol; `CASH` is the cash line.
   */
  targetWeights?: Record<string, number>;
  /** Where the positions were imported from, such as a manager's 13F; they are not the user's own holdings. */
  importedFrom?: PortfolioImportSource;
}

/** A manager's 13F filing a portfolio was imported from (`portfolio import --13f`). */
export interface PortfolioImportSource {
  kind: "13f";
  /** The manager's SEC CIK and name as filed. */
  cik: string;
  name: string;
  /** The quarter end the filing reports, YYYY-MM-DD. */
  period: string;
  /** The day it was filed, YYYY-MM-DD: `PORT --since filed` measures from that day's close. */
  filed: string;
  /**
   * The 13F's own weights of the imported holdings, by ticker: each line's
   * reported value over the imported lines' total. `PORT --since filed` buys
   * them at the filing-date close and holds them. Absent on portfolios
   * imported before they were stored.
   */
  weights?: Record<string, number>;
}

export interface PortfolioCash {
  amount: number;
  currency: string;
}

export interface Watchlist {
  id: string;
  name: string;
  description?: string;
  /** Set on watchlists shared with a team; the server holds the items. */
  teamId?: string;
}
