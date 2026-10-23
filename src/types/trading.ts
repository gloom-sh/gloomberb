import type { BrokerContractRef } from "./instrument";

type BrokerOrderAction = "BUY" | "SELL";
/** `TRAIL` is a trailing stop: its trigger follows the market by `trailingAmount` or `trailingPercent`. */
export type BrokerOrderType = "MKT" | "LMT" | "STP" | "STP LMT" | "TRAIL";
/**
 * Orders a broker holds together as one, and runs itself.
 * - `bracket`: the order is an entry, with a take-profit limit and a stop-loss stop (one or both) on the other side
 *   for the same quantity. They work once the entry fills, and one filling cancels the other.
 * - `oco`: a limit order and a stop order on the same side for the same quantity; one filling cancels the other.
 */
export type BrokerOrderClass = "bracket" | "oco";
/** A trailing stop's distance, in price or in percent of the price. */
export type BrokerTrailingUnit = "amount" | "percent";
/** What an order is to the others the broker holds it with. */
export type BrokerOrderLinkRole = "entry" | "takeProfit" | "stopLoss";

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
  /** Broker-reported price increment for this instrument/order. Omit if unknown. */
  priceStep?: number;
  modify?: boolean;
  cancel?: boolean;
  executionKind?: "fills" | "order-summaries";
  /**
   * Multi-leg option orders take up to this many legs (at least 2). Declared
   * for a combo contract (`secType: "BAG"`); omit when the broker takes none.
   */
  maxLegs?: number;
  /**
   * Linked orders the broker places and runs itself. The ticket never makes one
   * from separate orders: a class missing here is shown unavailable, and an
   * adapter that omits it never receives it.
   */
  orderClasses?: BrokerOrderClass[];
  /** How a trailing stop (`TRAIL` in `orderTypes`) can be set: by price, by percent or both. */
  trailing?: BrokerTrailingUnit[];
  /**
   * Why the broker takes no bracket, OCO or trailing stop here, when there is
   * more to say than that it takes none.
   */
  unavailableReasons?: Partial<Record<BrokerOrderClass | "trailing", string>>;
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
  /**
   * The account's own number at its brokerage, for one held through an
   * aggregator (SnapTrade). Another profile that holds that number keeps it.
   */
  brokerageAccountId?: string;
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

/**
 * One leg of a multi-leg option order. The action is what happens to this
 * contract when the order fills; the ratio is its contracts per spread.
 */
export interface BrokerOrderLeg {
  contract: BrokerContractRef;
  action: BrokerOrderAction;
  ratio: number;
}

export interface BrokerOrderRequest {
  brokerInstanceId?: string;
  accountId?: string;
  /** A combo contract (`secType: "BAG"`, the underlying's symbol) when the order has legs. */
  contract: BrokerContractRef;
  /**
   * BUY pays a net debit and SELL receives a net credit. With legs, the
   * legs' own actions say which contracts are bought and sold.
   */
  action: BrokerOrderAction;
  orderType: BrokerOrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  tif?: string;
  outsideRth?: boolean;
  /**
   * 2 or more option legs filled as one order. `quantity` counts spreads and
   * `limitPrice` is the positive net price of one spread.
   */
  legs?: BrokerOrderLeg[];
  /** A trailing stop's distance in price. Exactly one of this and `trailingPercent` with `TRAIL`. */
  trailingAmount?: number;
  /** A trailing stop's distance in percent, such as 2 for 2%. */
  trailingPercent?: number;
  /**
   * Orders placed with this one and held together by the broker. A bracket
   * takes `takeProfitPrice`, `stopLossPrice` or both; an OCO is this limit order
   * (`orderType: "LMT"`) with a stop at `stopLossPrice`.
   */
  orderClass?: BrokerOrderClass;
  /** A bracket's take-profit limit. */
  takeProfitPrice?: number;
  /** A bracket's stop-loss trigger, or an OCO's stop. */
  stopLossPrice?: number;
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
  /**
   * Where the figures come from, for a broker that says: its own preview, or none for this order
   * (the ticket then names each figure "Not available", never zero). Omitted by a broker that does not say.
   */
  impactSource?: "broker" | "unavailable";
  /** Whom the figures are credited to, e.g. "Robinhood via SnapTrade". */
  impactSourceLabel?: string;
  cashBefore?: number;
  cashAfter?: number;
  /** The broker's terms for these figures, shown with them before the order is confirmed. */
  disclosure?: string;
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
  /** A multi-leg order's legs, as on its request. */
  legs?: BrokerOrderLeg[];
  trailingAmount?: number;
  trailingPercent?: number;
  /**
   * Orders the broker holds together (a bracket's entry and exits, an OCO
   * pair) share this id; the broker cancels or activates them as one fills.
   */
  linkGroup?: string;
  linkRole?: BrokerOrderLinkRole;
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
