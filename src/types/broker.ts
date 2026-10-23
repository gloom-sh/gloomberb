import type { Quote, TickerFinancials, PricePoint, OptionsChain } from "./financials";
import type { TimeRange } from "../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../time-series/resolution";
import type { BrokerInstanceConfig } from "./config";
import type { QuoteSubscriptionTarget } from "./data-provider";
import type { BrokerContractRef, InstrumentSearchResult, PriceBasis } from "./instrument";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderPreview,
  BrokerOrderRequest,
  BrokerPortfolioPerformance,
  BrokerTradingCapabilities,
} from "./trading";
import type { CachePolicy, CachePolicyMap } from "./persistence";

export interface BrokerPosition {
  ticker: string;
  exchange: string;
  shares: number;
  avgCost?: number;
  priceBasis?: PriceBasis;
  currency: string;
  dateAcquired?: string;
  /** Optional account/portfolio identifier from the broker */
  accountId?: string;
  /** Full security name from broker */
  name?: string;
  /** Asset type: STK, ETF, OPT, FUT, BOND, etc. */
  assetCategory?: string;
  /** ISIN identifier */
  isin?: string;
  /** Current market price from broker snapshot */
  markPrice?: number;
  /** Total market value from broker */
  marketValue?: number;
  /** Unrealized P&L from broker */
  unrealizedPnl?: number;
  /** FX rate to account base currency */
  fxRateToBase?: number;
  /** Position side: "long" or "short" */
  side?: "long" | "short";
  /** Contract multiplier (e.g. 100 for options) */
  multiplier?: number;
  /** Percentage of portfolio NAV */
  percentOfNav?: number;
  /** Serializable broker contract metadata */
  brokerContract?: BrokerContractRef;
}

interface BrokerConfigFieldOption {
  label: string;
  value: string;
  description?: string;
}

export interface BrokerConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "file" | "select" | "number";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: BrokerConfigFieldOption[];
  dependsOn?: { key: string; value: string };
}

export interface BrokerConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "error";
  message?: string;
  mode?: string;
  /**
   * Timeliness of the quotes this session streams, when the broker knows it.
   * A "delayed" session never outranks a real-time cloud quote.
   */
  quoteData?: "realtime" | "delayed";
  updatedAt: number;
}

export interface BrokerProfileAction {
  id: string;
  label: string;
  paneId?: string;
  disabled?: boolean;
  disabledReason?: string;
}

/** How a chart asks a broker for history beyond the regular session. */
export interface BrokerHistoryOptions {
  /** Include pre-market and after-hours bars. Only a broker that sets `extendedHoursHistory` is asked. */
  session?: "extended";
}

/** What a broker's order stream calls. */
export interface BrokerOrderListener {
  /**
   * An order as the broker now reports it: placed, partly or wholly filled,
   * replaced, cancelled, rejected or expired. The same `orderId` names the
   * order through all of them, as `getOrderStatus` and `cancelOrder` take it.
   */
  order(order: BrokerOrder): void;
  /**
   * Whether changes are being pushed now. While false, as before the first
   * call, the host polls open orders instead; on true it reconciles once.
   */
  live?(live: boolean): void;
}

export interface BrokerAdapter {
  readonly id: string;
  readonly name: string;
  readonly cachePolicy?: CachePolicyMap;
  /**
   * Intraday history includes pre-market and after-hours bars when its
   * `BrokerHistoryOptions` ask for the extended session. The chart then
   * starts the day at the pre-market open; without it, the regular session.
   */
  readonly extendedHoursHistory?: boolean;
  /**
   * The quotes and bars this broker supplies stay on the user's device: Gloom Cloud sync never
   * uploads them, for a broker whose terms restrict redistributing its market data. Its accounts
   * sync like any broker's, unless the user keeps a connection on the device (`localOnly` on the
   * profile). Hosts that honor it export `LOCAL_BROKER_MARKET_DATA` from `gloomberb/broker`.
   */
  readonly localMarketData?: boolean;
  /**
   * `getQuote` answers the order ticket only, so the market data router never asks this broker:
   * for a broker whose quotes count against a small request allowance (SnapTrade, signed in).
   */
  readonly ticketQuotesOnly?: boolean;
  validate(instance: BrokerInstanceConfig): Promise<boolean>;
  importPositions(instance: BrokerInstanceConfig): Promise<BrokerPosition[]>;
  importPortfolioSnapshot?(instance: BrokerInstanceConfig): Promise<{ accounts: BrokerAccount[]; positions: BrokerPosition[] }>;
  configSchema: BrokerConfigField[];
  connect?(instance: BrokerInstanceConfig): Promise<void>;
  disconnect?(instance: BrokerInstanceConfig): Promise<void>;
  getStatus?(instance: BrokerInstanceConfig): BrokerConnectionStatus;
  subscribeStatus?(instance: BrokerInstanceConfig, listener: () => void): () => void;
  getPersistedConfigUpdate?(instance: BrokerInstanceConfig): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  getAccountCacheSourceKey?(instance: BrokerInstanceConfig): string;
  getAccountCachePolicy?(instance: BrokerInstanceConfig): CachePolicy;
  getProfileActions?(instance: BrokerInstanceConfig): BrokerProfileAction[];
  toConfigValues?(instance: BrokerInstanceConfig): Record<string, unknown>;
  fromConfigValues?(values: Record<string, unknown>, previous?: BrokerInstanceConfig): Record<string, unknown>;
  listAccounts?(instance: BrokerInstanceConfig): Promise<BrokerAccount[]>;
  getPortfolioPerformance?(instance: BrokerInstanceConfig, accountId: string): Promise<BrokerPortfolioPerformance | null>;
  searchInstruments?(query: string, instance: BrokerInstanceConfig): Promise<InstrumentSearchResult[]>;
  getTickerFinancials?(ticker: string, instance: BrokerInstanceConfig, exchange?: string, instrument?: BrokerContractRef | null): Promise<TickerFinancials>;
  getQuote?(ticker: string, instance: BrokerInstanceConfig, exchange?: string, instrument?: BrokerContractRef | null): Promise<Quote>;
  getPriceHistory?(ticker: string, instance: BrokerInstanceConfig, exchange: string, range: TimeRange, instrument?: BrokerContractRef | null): Promise<PricePoint[]>;
  getPriceHistoryForResolution?(
    ticker: string,
    instance: BrokerInstanceConfig,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    instrument?: BrokerContractRef | null,
    options?: BrokerHistoryOptions,
  ): Promise<PricePoint[]>;
  /** Fetch higher-resolution price data for a specific date window (e.g. when zoomed in). */
  getDetailedPriceHistory?(ticker: string, instance: BrokerInstanceConfig, exchange: string, startDate: Date, endDate: Date, barSize: string, instrument?: BrokerContractRef | null, options?: BrokerHistoryOptions): Promise<PricePoint[]>;
  getChartResolutionSupport?(
    ticker: string,
    instance: BrokerInstanceConfig,
    exchange?: string,
    instrument?: BrokerContractRef | null,
  ): Promise<ChartResolutionSupport[]> | ChartResolutionSupport[];
  getChartResolutionCapabilities?(
    ticker: string,
    instance: BrokerInstanceConfig,
    exchange?: string,
    instrument?: BrokerContractRef | null,
  ): Promise<ManualChartResolution[]> | ManualChartResolution[];
  getOptionsChain?(ticker: string, instance: BrokerInstanceConfig, exchange?: string, expirationDate?: number, instrument?: BrokerContractRef | null): Promise<OptionsChain>;
  /**
   * Whether this profile can stream quotes at all. Return false for modes that
   * only sync statements, so their positions stream from the cloud instead.
   * Quotes are also only routed to a broker whose status is "connected".
   * Answer from the profile's configuration, not from session state: the
   * desktop app asks in its view, while the session lives in the backend.
   */
  canStreamQuotes?(instance: BrokerInstanceConfig): boolean;
  subscribeQuotes?(
    instance: BrokerInstanceConfig,
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void;
  listOpenOrders?(instance: BrokerInstanceConfig): Promise<BrokerOrder[]>;
  /**
   * Pushes order changes as the broker reports them, for every account the
   * profile includes. The host baselines from `listOpenOrders` and polls it
   * while `live` is false or never called; see BrokerOrderListener.
   */
  subscribeOrders?(instance: BrokerInstanceConfig, listener: BrokerOrderListener): () => void;
  /** Explicit status, including terminal orders. Null means unconfirmed, never cancelled by absence. */
  getOrderStatus?(instance: BrokerInstanceConfig, orderId: number): Promise<BrokerOrder | null>;
  listExecutions?(instance: BrokerInstanceConfig): Promise<BrokerExecution[]>;
  /** Opt into the shared ticket with supported combinations and current trading permission. */
  getTradingCapabilities?(instance: BrokerInstanceConfig, contract?: BrokerContractRef, orderType?: BrokerOrderRequest["orderType"]): BrokerTradingCapabilities;
  /** Config patch for the host's explicit enable/disable trading confirmation. Must not perform I/O. */
  getTradingConfigUpdate?(instance: BrokerInstanceConfig, enabled: boolean): Record<string, unknown>;
  previewOrder?(instance: BrokerInstanceConfig, request: BrokerOrderRequest): Promise<BrokerOrderPreview>;
  /**
   * Place, change and cancel throw when the broker did not take the action. An error with `refused: true` says the
   * broker answered no, or nothing was sent: the order is as it was, and its message is one short line the app shows as
   * it is ("Aries cannot find this order"). Any other error is a lost answer, whose outcome the app treats as unknown.
   */
  placeOrder?(instance: BrokerInstanceConfig, request: BrokerOrderRequest): Promise<BrokerOrder>;
  modifyOrder?(instance: BrokerInstanceConfig, orderId: number, request: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder?(instance: BrokerInstanceConfig, orderId: number): Promise<void>;
  /**
   * How the Brokers pane names a profile, for adapters that front more than
   * one broker: `{brokerName} · {method}` instead of adapter name and mode.
   */
  describeInstance?(instance: BrokerInstanceConfig): { brokerName: string; method: string };
  /**
   * The broker a profile's portfolios belong to, when it is not the adapter id.
   * A portfolio keeps its broker when the user switches connection method.
   */
  portfolioBrokerId?(instance: BrokerInstanceConfig): string;
}

export function resolveBrokerConfigFields(
  adapter: BrokerAdapter,
  values: Record<string, unknown> = {},
): BrokerConfigField[] {
  return adapter.configSchema.filter((field) => {
    if (!field.dependsOn) return true;
    return String(values[field.dependsOn.key] ?? "") === field.dependsOn.value;
  });
}
