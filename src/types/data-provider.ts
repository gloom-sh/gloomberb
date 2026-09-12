import type { ExchangeRateSnapshot } from "./exchange-rate";
import type {
  AnalystResearchData,
  CorporateActionsData,
  Quote,
  QuoteMetadata,
  TickerFinancials,
  PricePoint,
  OptionsChain,
  HolderData,
} from "./financials";
import type { TimeRange } from "../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../time-series/resolution";
import type { BrokerContractRef, InstrumentSearchResult } from "./instrument";
import type { CachePolicyMap } from "./persistence";
import type { CachedQueryHandle } from "../data/cached-query";

export type CachedAssetMethod = "getExchangeRate" | "getHolders" | "getAnalystResearch" | "getCorporateActions"
  | "getOptionsChain" | "getSecFilings" | "getSecFilingDocuments" | "getSecFilingContent" | "getArticleSummary";
export type CachedAssetArgs<K extends CachedAssetMethod> = Parameters<NonNullable<AssetDataProvider[K]>>;
export type CachedAssetValue<K extends CachedAssetMethod> = Awaited<ReturnType<NonNullable<AssetDataProvider[K]>>>;

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  summary?: string;
}

export interface SecFilingItem {
  accessionNumber: string;
  form: string;
  filingDate: Date;
  acceptedAt?: Date;
  /** Unmodified SEC acceptanceDateTime; a missing timezone is not inferred. */
  acceptedAtRaw?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  items?: string;
  cik: string;
  companyName?: string;
  filingUrl: string;
  primaryDocumentUrl?: string;
}

export interface SecFilingDocument {
  sequence?: string;
  type: string;
  description?: string;
  document: string;
  url: string;
  size?: string;
  isPrimary: boolean;
}

export type EarningsEstimateField =
  | "epsEstimate" | "epsLow" | "epsHigh" | "epsYearAgo" | "epsGrowth" | "epsAnalysts"
  | "epsTrend7dAgo" | "epsTrend30dAgo"
  | "epsRevisionUp7d" | "epsRevisionUp30d" | "epsRevisionDown7d" | "epsRevisionDown30d"
  | "revenueEstimate" | "revenueLow" | "revenueHigh" | "revenueYearAgo" | "revenueGrowth" | "revenueAnalysts";

export interface EarningsEstimateBasis {
  source: "earningsTrend" | "calendarEvents";
  /** Selected provider number before any explicit minor-unit normalization. */
  sourceValue: number;
  /** Provider forecast label, not a derived fiscal quarter or announcement date. */
  period: string | null;
  periodEndDate: string | null;
  /** Explicit currency for monetary values only; ratios/counts have none. */
  currency?: string | null;
  sourceCurrency?: string | null;
}

export interface EarningsEvent {
  symbol: string;
  name: string;
  earningsDate: Date;
  earningsCallDate?: Date | null;
  isDateEstimate?: boolean | null;
  estimateBasis?: Partial<Record<EarningsEstimateField, EarningsEstimateBasis>>;
  epsEstimate: number | null;
  epsLow?: number | null;
  epsHigh?: number | null;
  epsYearAgo?: number | null;
  epsGrowth?: number | null;
  epsAnalysts?: number | null;
  epsTrend7dAgo?: number | null;
  epsTrend30dAgo?: number | null;
  epsRevisionUp7d?: number | null;
  epsRevisionUp30d?: number | null;
  epsRevisionDown7d?: number | null;
  epsRevisionDown30d?: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueLow?: number | null;
  revenueHigh?: number | null;
  revenueYearAgo?: number | null;
  revenueGrowth?: number | null;
  revenueAnalysts?: number | null;
  revenueActual: number | null;
  surprise: number | null;
  timing: "BMO" | "AMC" | "TNS" | "";
}

export interface MarketDataRequestContext {
  brokerId?: string;
  brokerInstanceId?: string;
  instrument?: BrokerContractRef | null;
  cacheMode?: "default" | "refresh";
  statementHistory?: "extended";
}

export interface CachedFinancialsTarget {
  statementHistory?: "extended";
  symbol: string;
  exchange?: string;
  brokerId?: string;
  brokerInstanceId?: string;
  instrument?: BrokerContractRef | null;
}

export interface SearchRequestContext {
  preferBroker?: boolean;
  brokerId?: string;
  brokerInstanceId?: string;
  /**
   * A person is waiting on this result, so a slow source should be abandoned in
   * well under a second rather than given the batch budget.
   */
  interactive?: boolean;
  /**
   * Called when a later source improves the result the search already returned,
   * typically a broker adding contract detail to a symbol the cloud found
   * first. Receives the full merged list, not a delta.
   */
  onPartial?: (results: InstrumentSearchResult[]) => void;
}

export interface QuoteSubscriptionTarget {
  symbol: string;
  exchange?: string;
  context?: MarketDataRequestContext;
  route?: "auto" | "provider" | "broker";
  surface?: "portfolio" | "watchlist" | "detail" | "monitor" | "inline" | "options" | "screener" | "unknown";
  visible?: boolean;
  selected?: boolean;
  weight?: number;
}

export interface QuoteBatchResult {
  target: QuoteSubscriptionTarget;
  quote: Quote | null;
  error?: unknown;
}

export interface TickerFinancialsBatchResult {
  target: CachedFinancialsTarget;
  financials: TickerFinancials | null;
  error?: unknown;
}

export interface AssetDataProvider {
  readonly id: string;
  readonly name: string;
  readonly priority?: number;
  readonly cachePolicy?: CachePolicyMap;

  /** Optional shared query owner. Consumers observe its age and refreshes instead of caching its values again. */
  getCachedQuery?<K extends CachedAssetMethod>(method: K, args: CachedAssetArgs<K>): CachedQueryHandle<CachedAssetValue<K>>;

  canProvide?(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<boolean> | boolean;
  getCachedFinancialsForTargets?(targets: CachedFinancialsTarget[], options?: { allowExpired?: boolean; includeStaleQuotes?: boolean }): Map<string, TickerFinancials> | Promise<Map<string, TickerFinancials>>;
  getQuotesBatch?(targets: QuoteSubscriptionTarget[], options?: { forceRefresh?: boolean }): Promise<QuoteBatchResult[]>;
  getTickerFinancialsBatch?(targets: CachedFinancialsTarget[], options?: { forceRefresh?: boolean }): Promise<TickerFinancialsBatchResult[]>;
  getTickerFinancials(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<TickerFinancials>;
  getQuote(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<Quote>;
  /** Listing facts may outlive the quote price; this method never returns price/session values. */
  getQuoteMetadata?(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<QuoteMetadata | null>;
  getExchangeRate(fromCurrency: string): Promise<number>;
  getExchangeRateSnapshot?(fromCurrency: string): Promise<ExchangeRateSnapshot>;
  search(query: string, context?: SearchRequestContext): Promise<InstrumentSearchResult[]>;
  getSecFilings?(ticker: string, count?: number, exchange?: string, context?: MarketDataRequestContext): Promise<SecFilingItem[]>;
  getHolders?(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<HolderData>;
  getAnalystResearch?(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<AnalystResearchData>;
  getCorporateActions?(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<CorporateActionsData>;
  getEarningsCalendar?(symbols: string[], context?: MarketDataRequestContext): Promise<EarningsEvent[]>;
  getSecFilingDocuments?(filing: SecFilingItem): Promise<SecFilingDocument[]>;
  getSecFilingContent?(filing: SecFilingItem): Promise<string | null>;
  /** Fetch article summary/description by URL (lazy-loaded on selection) */
  getArticleSummary(url: string): Promise<string | null>;
  getPriceHistory(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PricePoint[]>;
  getPriceHistoryForResolution?(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]>;
  /** Fetch higher-resolution price data for a specific date window (e.g. when zoomed in). */
  getDetailedPriceHistory?(ticker: string, exchange: string, startDate: Date, endDate: Date, barSize: string, context?: MarketDataRequestContext): Promise<PricePoint[]>;
  getChartResolutionSupport?(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ChartResolutionSupport[]> | ChartResolutionSupport[];
  getChartResolutionCapabilities?(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ManualChartResolution[]> | ManualChartResolution[];
  getOptionsChain?(ticker: string, exchange?: string, expirationDate?: number, context?: MarketDataRequestContext): Promise<OptionsChain>;
  subscribeQuotes?(
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void;
}

export type DataProvider = AssetDataProvider;
