import type { BrokerContractRef, PriceBasis } from "./instrument";

export interface TickerPosition {
  portfolio: string;
  shares: number;
  /** Absent when the source did not provide a finite cost; explicit zero is retained. */
  avgCost?: number;
  priceBasis?: PriceBasis;
  currency?: string;
  dateAcquired?: string;
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
   * Target weights in percent of the total value, cash included, keyed by
   * ticker symbol; `CASH` is the cash line.
   */
  targetWeights?: Record<string, number>;
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
