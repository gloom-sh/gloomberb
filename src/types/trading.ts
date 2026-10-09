import type { BrokerContractRef } from "./instrument";

type BrokerOrderAction = "BUY" | "SELL";
export type BrokerOrderType = "MKT" | "LMT" | "STP" | "STP LMT";

/** Explicit account classification for order confirmation. Missing values are treated as unknown. */
export type BrokerTradingMode = "simulation" | "live" | "unknown";

/** Synchronous ticket metadata. Adapters may vary this by contract and order type. */
export interface BrokerTradingCapabilities {
  enabled: boolean;
  disabledReason?: string;
  orderTypes: BrokerOrderType[];
  tif: string[];
  extendedHours?: boolean;
  /** When set, extended hours are available only for these time-in-force values. */
  extendedHoursTif?: string[];
  fractionalQuantity?: boolean;
  /** Explicitly permits sells beyond a known long position. Omission blocks short sales. */
  shortSelling?: boolean;
  minQuantity?: number;
  quantityStep?: number;
  priceDecimals?: number;
  modify?: boolean;
  cancel?: boolean;
  executionKind?: "fills" | "order-summaries";
}

export interface BrokerCashBalance {
  currency: string;
  quantity: number;
  baseValue?: number;
  baseCurrency?: string;
}

export interface BrokerAccount {
  accountId: string;
  name: string;
  tradingMode?: BrokerTradingMode;
  /** Broker-reported account classification, such as Cash or Margin. Omit when unavailable. */
  accountType?: string;
  currency?: string;
  /** "cloud" is a connection held by the user's Gloom Cloud account. */
  source?: "gateway" | "flex" | "cloud";
  updatedAt?: number;
  asOfDate?: string;
  netLiquidation?: number;
  grossPositionValue?: number;
  totalCashValue?: number;
  settledCash?: number;
  buyingPower?: number;
  availableFunds?: number;
  excessLiquidity?: number;
  initMarginReq?: number;
  maintMarginReq?: number;
  dailyPnl?: number;
  /** Net liquidation at the previous close, when the broker reports its own day return. */
  previousNetLiquidation?: number;
  /** When the broker computed `dailyPnl`, if that differs from `updatedAt`. */
  dailyPnlAsOf?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  cashBalances?: BrokerCashBalance[];
}

export interface BrokerPortfolioPerformancePoint {
  date: string;
  value?: number;
  cumulativeReturn?: number;
  /** This day's return alone, as a decimal fraction. */
  dailyReturn?: number;
  /** Deposits (positive) and withdrawals (negative) on this day, valued at its close. */
  externalFlow?: number;
}

export interface BrokerPortfolioPerformance {
  accountId: string;
  source: "flex" | "cloud";
  period: string;
  currency?: string;
  fetchedAt: number;
  startDate?: string;
  endDate?: string;
  lastSuccessfulUpdate?: string;
  stale?: boolean;
  /** How the broker computes returns: time-weighted or money-weighted. */
  measure?: "TWR" | "MWR";
  /** Whether `externalFlow` was reported by the broker or implied from NAV and a time-weighted return. */
  flowBasis?: "reported" | "derived";
  points: BrokerPortfolioPerformancePoint[];
}

export interface BrokerOrderRequest {
  brokerInstanceId?: string;
  accountId?: string;
  contract: BrokerContractRef;
  action: BrokerOrderAction;
  orderType: BrokerOrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  tif?: string;
  outsideRth?: boolean;
}

export interface BrokerOrderPreview {
  currency?: string;
  estimatedCost?: number;
  fees?: number;
  buyingPowerBefore?: number;
  buyingPowerAfter?: number;
  buyingPowerImpact?: number;
  warnings?: string[];
  /** Blocking broker validation errors. A ticket must not submit when these are present. */
  errors?: string[];
  initMarginBefore?: number;
  initMarginAfter?: number;
  maintMarginBefore?: number;
  maintMarginAfter?: number;
  equityWithLoanBefore?: number;
  equityWithLoanAfter?: number;
  commission?: number;
  commissionCurrency?: string;
  warningText?: string;
}

export interface BrokerOrder {
  orderId: number;
  /** Broker-native identity, scoped to profile and account. Numeric orderId remains the mutation handle. */
  brokerOrderId?: string;
  brokerInstanceId?: string;
  accountId?: string;
  status: string;
  action: BrokerOrderAction;
  orderType: string;
  quantity: number;
  filled: number;
  remaining: number;
  avgFillPrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  tif?: string;
  warningText?: string;
  /** Set when the order is an instruction the user still reviews and submits at the broker. */
  reviewUrl?: string;
  updatedAt: number;
  contract: BrokerContractRef;
}

export interface BrokerExecution {
  execId: string;
  brokerInstanceId?: string;
  orderId?: number;
  brokerOrderId?: string;
  accountId?: string;
  side: string;
  shares: number;
  price: number;
  time: number;
  exchange?: string;
  commission?: number;
  commissionCurrency?: string;
  realizedPnl?: number;
  netAmount?: number;
  contract: BrokerContractRef;
}
