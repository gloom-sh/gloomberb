import type { Quote, TickerFinancials, PricePoint, OptionsChain } from "./financials";
import type { TimeRange } from "../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../time-series/resolution";
import type { BrokerInstanceConfig } from "./config";
import type { QuoteSubscriptionTarget } from "./data-provider";
import type { BrokerContractRef, InstrumentSearchResult } from "./instrument";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderPreview,
  BrokerOrderRequest,
  BrokerPortfolioPerformance,
} from "./trading";
import type { CachePolicy, CachePolicyMap } from "./persistence";

export interface BrokerPosition {
  ticker: string;
  exchange: string;
  shares: number;
  avgCost?: number;
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
  updatedAt: number;
}

export interface BrokerProfileAction {
  id: string;
  label: string;
  paneId?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface BrokerAdapter {
  readonly id: string;
  readonly name: string;
  readonly cachePolicy?: CachePolicyMap;
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
  ): Promise<PricePoint[]>;
  /** Fetch higher-resolution price data for a specific date window (e.g. when zoomed in). */
  getDetailedPriceHistory?(ticker: string, instance: BrokerInstanceConfig, exchange: string, startDate: Date, endDate: Date, barSize: string, instrument?: BrokerContractRef | null): Promise<PricePoint[]>;
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
  subscribeQuotes?(
    instance: BrokerInstanceConfig,
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void;
  listOpenOrders?(instance: BrokerInstanceConfig): Promise<BrokerOrder[]>;
  listExecutions?(instance: BrokerInstanceConfig): Promise<BrokerExecution[]>;
  previewOrder?(instance: BrokerInstanceConfig, request: BrokerOrderRequest): Promise<BrokerOrderPreview>;
  placeOrder?(instance: BrokerInstanceConfig, request: BrokerOrderRequest): Promise<BrokerOrder>;
  modifyOrder?(instance: BrokerInstanceConfig, orderId: number, request: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder?(instance: BrokerInstanceConfig, orderId: number): Promise<void>;
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
