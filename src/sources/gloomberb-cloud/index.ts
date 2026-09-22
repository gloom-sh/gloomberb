import { assertTradingPriceHistory } from "../listing-history";
import { exchangeRateMetadata } from "../../utils/exchange-rate-snapshot";
import type { ExchangeRateSnapshot } from "../../types/exchange-rate";
import type { TimeRange } from "../../time-series/range";
import { hasShellCoverageRestriction, HistoryCoverageError, isShellLondonTarget, SHELL_VERIFIED_LINEAGE_START } from "../history-coverage";
import {
  normalizeChartResolutionSupport,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { assetDataProvider, newsProvider, type PluginCapability } from "../../capabilities";
import type {
  AssetDataProvider,
  CachedFinancialsTarget,
  SecFilingDocument,
  SecFilingItem,
  MarketDataRequestContext,
  QuoteBatchResult,
  QuoteSubscriptionTarget,
  SearchRequestContext,
  TickerFinancialsBatchResult,
} from "../../types/data-provider";
import type { AnalystResearchData, CorporateActionsData, HolderData, OptionsChain, PricePoint, Quote, QuoteMetadata, TickerFinancials } from "../../types/financials";
import type { PriceHistoryResult } from "../../types/price-history";
import { parseHistorySession } from "../../market-data/history-session";
import { quoteMetadataFromQuote, quoteMetadataMatchesTarget } from "../../market-data/quotes/metadata";
import type { InstrumentSearchResult } from "../../types/instrument";
import {
  apiClient,
  type CloudAnalystResearchPayload,
  type CloudCorporateActionsPayload,
  type CloudHoldersPayload,
  type CloudMarketResponse,
  type CloudPricePointPayload,
} from "../../api-client";
import type { NewsArticle, NewsQuery } from "../../types/news-source";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { canonicalExchange, canonicalTickerKey, parsePublicTickerKey } from "../../utils/exchanges";
import { normalizePriceHistory } from "../../utils/price-history";
import { createProviderMiss } from "../provider-errors";
import { publicListingTarget } from "../listing-target";
import { canonicalHistoryInterval, HistoryRetentionError, parseHistoryRecoveryCandidate, parseHistoryRetention, type HistoryRetention } from "../history-retention";
import { getRouterEntityKey } from "../provider-router/cache";
import { tickerHasYahooSuffix } from "../yahoo-finance/symbols";
import { hasMalformedIntradayHistory } from "../../time-series/history-quality";
import {
  cloudNewsParams,
  mapCloudNewsArticle,
} from "./news";
import {
  GLOOMBERB_CLOUD_PROVIDER_ID,
  formatCloudDateTime,
  getRangeStartDate,
  isEmptyCloudStatus,
  mapBatchError,
  mapCloudFinancials,
  mapOptionsChain,
  mapPricePoint,
  mapQuote,
  toCloudInterval,
  toHistoryRequest,
} from "./normalizers";

const providerId = GLOOMBERB_CLOUD_PROVIDER_ID;
const CLOUD_RESOLUTION_SUPPORT = normalizeChartResolutionSupport([
  { resolution: "1m", maxRange: "1W" },
  { resolution: "5m", maxRange: "1M" },
  { resolution: "15m", maxRange: "3M" },
  { resolution: "30m", maxRange: "6M" },
  { resolution: "1h", maxRange: "1Y" },
  { resolution: "1d", maxRange: "5Y" },
  { resolution: "1wk", maxRange: "5Y" },
  { resolution: "1mo", maxRange: "ALL" },
]);
const CLOUD_PROVIDER_MISS_PATTERNS = [
  /data not found/i,
  /symbol.*missing or invalid/i,
  /figi.*missing or invalid/i,
  /error in the query/i,
];

function mapCloudSecFiling(item: {
  accessionNumber: string;
  form: string;
  filingDate: string;
  acceptedAt?: string;
  /** Unmodified SEC acceptanceDateTime; a missing timezone is not inferred. */
  acceptedAtRaw?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  items?: string;
  cik: string;
  companyName?: string;
  filingUrl: string;
  primaryDocumentUrl?: string;
}): SecFilingItem {
  return {
    accessionNumber: item.accessionNumber,
    form: item.form,
    filingDate: new Date(`${item.filingDate}T00:00:00Z`),
    acceptedAt: item.acceptedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(item.acceptedAt)
      ? new Date(item.acceptedAt) : undefined,
    acceptedAtRaw: item.acceptedAtRaw ?? item.acceptedAt,
    primaryDocument: item.primaryDocument,
    primaryDocDescription: item.primaryDocDescription,
    items: item.items,
    cik: item.cik,
    companyName: item.companyName,
    filingUrl: item.filingUrl,
    primaryDocumentUrl: item.primaryDocumentUrl,
  };
}

function isCloudProviderMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CLOUD_PROVIDER_MISS_PATTERNS.some((pattern) => pattern.test(message));
}

async function withCloudFallback<T>(load: () => Promise<T>, message: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isCloudProviderMiss(error)) {
      throw createProviderMiss(message);
    }
    throw error;
  }
}

function isStaleCloudResponse(response: CloudMarketResponse<unknown>): boolean {
  return response.stale === true || response.providerMeta?.stale === true;
}

function mapCloudPriceHistory(
  response: CloudMarketResponse<CloudPricePointPayload[]>,
  ticker: string,
  exchange: string,
  interval: string,
  requestedStart: Date,
  requestedEnd?: Date,
): PriceHistoryResult {
  if (response.status === "empty" && isShellLondonTarget(ticker, exchange)
    && requestedStart.getTime() < Date.parse(SHELL_VERIFIED_LINEAGE_START)
    && hasShellCoverageRestriction(response.coverage)) throw new HistoryCoverageError(response.coverage.source);
  if (isStaleCloudResponse(response)) {
    throw createProviderMiss(`Cloud chart data is stale for ${ticker}`);
  }
  if (response.status === "unsupported" && response.reasonCode === "HISTORY_RETENTION" && requestedEnd) {
    const retention = parseHistoryRetention(response.historyRetention);
    const target = cloudInstrumentTarget(ticker, exchange);
    if (retention && retention.symbol === target.symbol && retention.exchange === (target.exchange ?? "")
      && retention.interval === canonicalHistoryInterval(interval)
      && retention.requestedStart === Math.floor(requestedStart.getTime() / 1000) * 1000
      && retention.requestedEnd === Math.floor(requestedEnd.getTime() / 1000) * 1000) {
      throw new HistoryRetentionError(retention);
    }
  }
  // Cloud history is already in major currency units unless the response
  // explicitly declares a raw subunit. The exchange alone cannot set its scale.
  const { divisor } = resolveCurrencyUnit(
    response.currency ?? response.providerMeta?.currency,
  );
  const points = normalizePriceHistory(
    unwrapRequiredCloudResponse(
      response,
      `Cloud chart data is unavailable for ${ticker}`,
    ).map((point) => mapPricePoint(point, divisor, exchange)),
  );
  const upstream = (
    response.providerMeta?.provider
    ?? response.providerMeta?.upstream
    ?? ""
  ).trim().toLowerCase();
  if (
    /^\d+(min|h)$/i.test(interval)
    && upstream !== "yahoo"
    && hasMalformedIntradayHistory(points)
  ) {
    throw createProviderMiss(`Cloud chart data failed OHLC validation for ${ticker}`);
  }
  const matchingInterval = [response.providerMeta?.servedResolution, response.providerMeta?.requestedResolution]
    .every((declared) => declared === undefined || canonicalHistoryInterval(declared) === canonicalHistoryInterval(interval));
  const resolution = matchingInterval ? cloudHistoryResolution(interval) : null;
  const session = resolution ? parseHistorySession(response.historySession, { symbol: ticker, exchange, interval }) : null;
  const matchingSource = [response.providerMeta?.provider, response.providerMeta?.upstream].every((source) =>
    source === undefined || source === "cache" || source === session?.source);
  const matchingIdentity = (response.providerMeta?.normalizedSymbol === undefined || response.providerMeta.normalizedSymbol === ticker)
    && (response.providerMeta?.normalizedExchange === undefined || canonicalExchange(response.providerMeta.normalizedExchange) === canonicalExchange(exchange))
    && [response.currency, response.providerMeta?.currency].every((currency) => currency === undefined || currency === "USD");
  if (response.historySession !== undefined && (!session || !matchingSource || !matchingIdentity || !matchingInterval)) {
    throw createProviderMiss(`Cloud chart session metadata does not match the requested history for ${ticker}`);
  }
  return {
    points: assertTradingPriceHistory(points, { symbol: ticker, exchange }, "provider:gloomberb-cloud"),
    resolution,
    ...(session && matchingSource && matchingIdentity ? { session } : {}),
  };
}

function cloudHistoryResolution(interval: string): ManualChartResolution | null {
  const canonical = canonicalHistoryInterval(interval);
  return (["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"] as const)
    .find((resolution) => canonicalHistoryInterval(resolution) === canonical) ?? null;
}

function quoteTargetKey(symbol: string, exchange?: string): string {
  const target = publicListingTarget(symbol, exchange);
  const base = target.exchange && tickerHasYahooSuffix(target.symbol) ? target.symbol.slice(0, target.symbol.indexOf(".")) : target.symbol;
  return canonicalTickerKey(base, target.exchange);
}

function cloudResponseTargetKey(key: string, requested: Set<string>): string | undefined {
  if (requested.has(key)) return key;
  const symbol = parsePublicTickerKey(key).symbol;
  // A venue-less request may discover one listing. Never guess between two
  // requested listings or erase an unresolved suffix to make it match.
  return requested.has(symbol) && [...requested].filter((candidate) => parsePublicTickerKey(candidate).symbol === symbol).length === 1
    ? symbol : undefined;
}

const cloudInstrumentTarget = publicListingTarget;

function cloudHistoryRecovery(
  context: MarketDataRequestContext | undefined,
  ticker: string, symbol: string, exchange: string, interval: string, start: Date, end: Date,
): HistoryRetention | undefined {
  if (!context?.historyRecovery) return undefined;
  const candidate = parseHistoryRecoveryCandidate(context.historyRecovery);
  const from = start.getTime();
  const to = end.getTime();
  if (!candidate || candidate.sourceKey !== `provider:${providerId}`
    || !Number.isFinite(from) || !Number.isFinite(to)
    || candidate.request.symbol !== symbol || candidate.request.exchange !== exchange
    || candidate.request.interval !== canonicalHistoryInterval(interval)
    || candidate.request.entityKey !== getRouterEntityKey(ticker, context.instrument)
    || candidate.request.brokerId !== (context.instrument?.brokerId ?? context.brokerId)
    || candidate.request.brokerInstanceId !== (context.instrument?.brokerInstanceId ?? context.brokerInstanceId)
    || from < candidate.retention.availableStart || from < candidate.retention.requestedStart
    || to > candidate.retention.requestedEnd || from >= to
    || (from === candidate.retention.requestedStart && to === candidate.retention.requestedEnd)) {
    throw new Error("Invalid history recovery request");
  }
  return candidate.retention;
}

function cloudBatchTargets<T extends { symbol: string; exchange?: string }>(targets: T[]) {
  const valid: Array<{ target: T; request: ReturnType<typeof cloudInstrumentTarget> }> = [];
  const invalid: Array<{ target: T; error: unknown }> = [];
  for (const target of targets) {
    try { valid.push({ target, request: cloudInstrumentTarget(target.symbol, target.exchange) }); }
    catch (error) { invalid.push({ target, error }); }
  }
  return { valid, invalid };
}

function matchCloudBatchItems<T extends { symbol: string; exchange?: string }, I extends { symbol: string; exchange?: string }>(targets: T[], items: I[]) {
  const pending = new Map<string, T[]>();
  for (const target of targets) {
    const key = quoteTargetKey(target.symbol, target.exchange);
    pending.set(key, [...(pending.get(key) ?? []), target]);
  }
  const matched: Array<{ target: T; item: I }> = [];
  const requested = new Set(pending.keys());
  const responses = items.flatMap((item) => {
    try { return [{ item, key: quoteTargetKey(item.symbol, item.exchange) }]; }
    catch { return []; }
  });
  for (const { item, key: responseKey } of responses) {
    const key = cloudResponseTargetKey(responseKey, requested);
    if (!key) continue;
    if (key !== responseKey && new Set(responses.filter((response) => parsePublicTickerKey(response.key).symbol === key).map((response) => response.key)).size !== 1) continue;
    for (const target of pending.get(key) ?? []) matched.push({ target, item });
    pending.delete(key);
  }
  return { matched, missing: [...pending.values()].flat() };
}

function retainRequestedQuoteSymbol(quote: Quote, ticker: string): Quote {
  return parsePublicTickerKey(ticker).exchange || tickerHasYahooSuffix(ticker) ? { ...quote, symbol: ticker } : quote;
}

function retainRequestedFinancialsSymbol(financials: TickerFinancials, ticker: string): TickerFinancials {
  return financials.quote
    ? { ...financials, quote: retainRequestedQuoteSymbol(financials.quote, ticker) }
    : financials;
}

async function requireVerifiedSession(): Promise<void> {
  const user = await apiClient.ensureVerifiedSession();
  if (!user) {
    throw createProviderMiss("Gloom Cloud requires signup and email verification");
  }
}

function unwrapRequiredCloudResponse<T>(response: CloudMarketResponse<T>, message: string): T {
  if ((response.status === "success" || response.status === "partial") && response.data != null) {
    return response.data;
  }
  if (isEmptyCloudStatus(response.status)) {
    throw createProviderMiss(response.reasonCode ?? message);
  }
  throw new Error(response.reasonCode ?? message);
}

export class GloomberbCloudProvider implements AssetDataProvider {
  readonly id = providerId;
  readonly name = "Gloom Cloud";
  readonly priority = 100;

  getChartResolutionSupport(): ChartResolutionSupport[] {
    return CLOUD_RESOLUTION_SUPPORT;
  }

  getChartResolutionCapabilities(): ManualChartResolution[] {
    return CLOUD_RESOLUTION_SUPPORT.map((entry) => entry.resolution);
  }

  async canProvide(): Promise<boolean> {
    return true;
  }

  async getTickerFinancials(ticker: string, exchange = "", context?: MarketDataRequestContext): Promise<TickerFinancials> {
    const target = cloudInstrumentTarget(ticker, exchange);
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudFinancials(target.symbol, target.exchange, context?.statementHistory);
      if (isStaleCloudResponse(response)) {
        throw createProviderMiss(`Cloud financials are stale for ${ticker}`);
      }
      return retainRequestedFinancialsSymbol(mapCloudFinancials(
        unwrapRequiredCloudResponse(response, `Cloud financials are unavailable for ${ticker}`),
        response.providerMeta,
        target,
      ), ticker);
    }, `Cloud financials are unavailable for ${ticker}`);
  }

  async getTickerFinancialsBatch(
    targets: CachedFinancialsTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<TickerFinancialsBatchResult[]> {
    if (targets.some((target) => target.statementHistory === "extended")) {
      return Promise.all(targets.map(async (target) => {
        try { return { target, financials: await this.getTickerFinancials(target.symbol, target.exchange, target) }; }
        catch (error) { return { target, financials: null, error }; }
      }));
    }
    const { valid, invalid } = cloudBatchTargets(targets);
    const rejected = invalid.map((entry) => ({ ...entry, financials: null }));
    if (!valid.length) return rejected;
    const submitted = valid.map((entry) => entry.target);
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudFinancialsBatch(
        valid.map((entry) => entry.request),
        options.forceRefresh ? "refresh" : "cache-first",
      );
      if (isStaleCloudResponse(response)) {
        throw createProviderMiss("Cloud financials are stale");
      }
      const payload = unwrapRequiredCloudResponse(response, "Cloud financials are unavailable");
      const { matched, missing } = matchCloudBatchItems(submitted, payload.items);
      return [...rejected, ...matched.map(({ target, item }) => {
        if ((item.status === "success" || item.status === "partial") && item.data) {
          return {
            target,
            financials: retainRequestedFinancialsSymbol(mapCloudFinancials(item.data, undefined, cloudInstrumentTarget(target.symbol, target.exchange)), target.symbol),
          };
        }
        return {
          target,
          financials: null,
          error: mapBatchError(item, `Cloud financials are unavailable for ${target.symbol}`),
        };
      }), ...missing.map((target) => ({ target, financials: null, error: createProviderMiss(`Cloud financials are unavailable for ${target.symbol}`) }))];
    }, "Cloud financials are unavailable");
  }

  async getQuote(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<Quote> {
    const target = cloudInstrumentTarget(ticker, exchange);
    return withCloudFallback(
      async () => {
        const response = await apiClient.getCloudQuote(target.symbol, target.exchange);
        if (isStaleCloudResponse(response)) {
          throw createProviderMiss(`Cloud quotes are stale for ${ticker}`);
        }
        return retainRequestedQuoteSymbol(mapQuote(
          unwrapRequiredCloudResponse(response, `Cloud quotes are unavailable for ${ticker}`),
          response.providerMeta,
        ), ticker);
      },
      `Cloud quotes are unavailable for ${ticker}`,
    );
  }

  async getQuoteMetadata(ticker: string, exchange = ""): Promise<QuoteMetadata | null> {
    const target = cloudInstrumentTarget(ticker, exchange);
    const response = await apiClient.getCloudQuote(target.symbol, target.exchange);
    const quote = mapQuote(unwrapRequiredCloudResponse(response, `Cloud quote metadata is unavailable for ${ticker}`), response.providerMeta);
    const metadata = quoteMetadataFromQuote(quote);
    if (isStaleCloudResponse(response)) metadata.source.stale = true;
    return quoteMetadataMatchesTarget(metadata, ticker, target.exchange) ? metadata : null;
  }

  async getQuotesBatch(
    targets: QuoteSubscriptionTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QuoteBatchResult[]> {
    const { valid, invalid } = cloudBatchTargets(targets);
    const rejected = invalid.map((entry) => ({ ...entry, quote: null }));
    if (!valid.length) return rejected;
    const submitted = valid.map((entry) => entry.target);
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudQuotesBatch(
        valid.map((entry) => entry.request),
        options.forceRefresh ? "refresh" : "cache-first",
      );
      if (isStaleCloudResponse(response)) {
        throw createProviderMiss("Cloud quotes are stale");
      }
      const payload = unwrapRequiredCloudResponse(response, "Cloud quotes are unavailable");
      const { matched, missing } = matchCloudBatchItems(submitted, payload.items);
      return [...rejected, ...matched.map(({ target, item }) => {
        // A successful batch can contain an expired cache fallback for only
        // one listing. Match the single-quote freshness boundary and let the
        // normal router retry that item without discarding its healthy peers.
        if (item.stale === true) {
          return { target, quote: null, error: createProviderMiss(`Cloud quotes are stale for ${target.symbol}`) };
        }
        if ((item.status === "success" || item.status === "partial") && item.data) {
          return {
            target,
            quote: retainRequestedQuoteSymbol(mapQuote(item.data), target.symbol),
          };
        }
        return {
          target,
          quote: null,
          error: mapBatchError(item, `Cloud quotes are unavailable for ${target.symbol}`),
        };
      }), ...missing.map((target) => ({ target, quote: null, error: createProviderMiss(`Cloud quotes are unavailable for ${target.symbol}`) }))];
    }, "Cloud quotes are unavailable");
  }

  async getExchangeRate(fromCurrency: string): Promise<number> {
    return (await this.getExchangeRateSnapshot(fromCurrency)).rate;
  }

  async getExchangeRateSnapshot(fromCurrency: string): Promise<ExchangeRateSnapshot> {
    const currency = fromCurrency.trim().toUpperCase();
    const response = await apiClient.getCloudExchangeRate(currency);
    const data = unwrapRequiredCloudResponse(response, `Cloud exchange rate is unavailable for ${currency}`);
    exchangeRateMetadata({ ...data, asOf: data.asOf ?? response.asOf }, currency);
    // Older servers have no observation metadata. Keep asOf unknown rather than
    // presenting the request completion time as the rate's time.
    return { ...data, rate: data.rate, fromCurrency: currency, toCurrency: "USD", source: data.source ?? this.id,
      asOf: data.asOf ?? response.asOf, fetchedAt: data.fetchedAt ?? new Date().toISOString(),
      stale: data.stale === true || response.stale === true };
  }

  async search(query: string, _context?: SearchRequestContext): Promise<InstrumentSearchResult[]> {
    return withCloudFallback(
      () => apiClient.searchInstruments(query, 10),
      "Cloud search is unavailable",
    );
  }

  async getSecFilings(ticker: string, count = 15): Promise<SecFilingItem[]> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudSecFilings({ ticker, limit: count, offset: 0 });
      return response.filings.map(mapCloudSecFiling);
    }, `Cloud SEC filings are unavailable for ${ticker}`);
  }

  async getSecFilingDocuments(filing: SecFilingItem): Promise<SecFilingDocument[]> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudSecFilingDocuments({
        cik: filing.cik,
        accession: filing.accessionNumber,
        form: filing.form,
        primaryDocument: filing.primaryDocument,
        filingUrl: filing.filingUrl,
      });
      return response.documents;
    }, "Cloud SEC filing documents are unavailable");
  }

  async getSecFilingContent(filing: SecFilingItem): Promise<string | null> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudSecFilingContent({
        cik: filing.cik,
        accession: filing.accessionNumber,
        form: filing.form,
        primaryDocument: filing.primaryDocument,
        primaryDocumentUrl: filing.primaryDocumentUrl,
        filingUrl: filing.filingUrl,
      });
      return response.content;
    }, "Cloud SEC filing content is unavailable");
  }

  async getHolders(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<HolderData> {
    const target = cloudInstrumentTarget(ticker, exchange);
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudHolders(target.symbol, target.exchange);
      return unwrapRequiredCloudResponse(response, `Cloud holders are unavailable for ${ticker}`) as CloudHoldersPayload;
    }, `Cloud holders are unavailable for ${ticker}`);
  }

  async getAnalystResearch(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<AnalystResearchData> {
    const target = cloudInstrumentTarget(ticker, exchange);
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudAnalystResearch(target.symbol, target.exchange);
      return unwrapRequiredCloudResponse(response, `Cloud analyst research is unavailable for ${ticker}`) as CloudAnalystResearchPayload;
    }, `Cloud analyst research is unavailable for ${ticker}`);
  }

  async getCorporateActions(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<CorporateActionsData> {
    const target = cloudInstrumentTarget(ticker, exchange);
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudCorporateActions(target.symbol, target.exchange);
      return unwrapRequiredCloudResponse(response, `Cloud corporate actions are unavailable for ${ticker}`) as CloudCorporateActionsPayload;
    }, `Cloud corporate actions are unavailable for ${ticker}`);
  }

  async getArticleSummary(_url: string): Promise<string | null> {
    throw createProviderMiss("Cloud article summaries are not available");
  }

  async getPriceHistory(ticker: string, exchange: string, range: TimeRange, _context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return (await this.getPriceHistoryWithMetadata(ticker, exchange, range, _context)).points;
  }

  async getPriceHistoryWithMetadata(ticker: string, exchange: string, range: TimeRange, _context?: MarketDataRequestContext): Promise<PriceHistoryResult> {
    if (_context?.historyRecovery) throw new Error("History recovery requires exact bounds");
    const target = cloudInstrumentTarget(ticker, exchange);
    exchange = target.exchange ?? "";
    const request = toHistoryRequest(range);
    const response = await withCloudFallback(
      () => apiClient.getCloudHistory(target.symbol, exchange, request),
      `Cloud chart data is unavailable for ${ticker}`,
    );
    return mapCloudPriceHistory(response, target.symbol, exchange, request.interval, getRangeStartDate(range, new Date()));
  }

  async getPriceHistoryForResolution(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    _context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    return (await this.getPriceHistoryForResolutionWithMetadata(ticker, exchange, bufferRange, resolution, _context)).points;
  }

  async getPriceHistoryForResolutionWithMetadata(
    ticker: string, exchange: string, bufferRange: TimeRange, resolution: ManualChartResolution,
    _context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    if (_context?.historyRecovery) throw new Error("History recovery requires exact bounds");
    const target = cloudInstrumentTarget(ticker, exchange);
    exchange = target.exchange ?? "";
    const interval = toCloudInterval(resolution);
    const endDate = new Date();
    const startDate = getRangeStartDate(bufferRange, endDate);
    const includeTime = /^\d+(min|h)$/i.test(interval);
    const response = await withCloudFallback(
      () => apiClient.getCloudHistory(target.symbol, exchange, {
        interval,
        startDate: formatCloudDateTime(startDate, includeTime, exchange),
        endDate: formatCloudDateTime(endDate, includeTime, exchange),
      }),
      `Cloud chart data is unavailable for ${ticker}`,
    );
    return mapCloudPriceHistory(response, target.symbol, exchange, interval, startDate, endDate);
  }

  async getDetailedPriceHistory(
    ticker: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    _context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    return (await this.getDetailedPriceHistoryWithMetadata(ticker, exchange, startDate, endDate, barSize, _context)).points;
  }

  async getDetailedPriceHistoryWithMetadata(
    ticker: string, exchange: string, startDate: Date, endDate: Date, barSize: string,
    _context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    const target = cloudInstrumentTarget(ticker, exchange);
    exchange = target.exchange ?? "";
    const interval = toCloudInterval(barSize);
    const includeTime = /^\d+(min|h)$/i.test(interval);
    const historyRecovery = cloudHistoryRecovery(_context, ticker, target.symbol, exchange, interval, startDate, endDate);
    const response = await withCloudFallback(
      () => apiClient.getCloudHistory(target.symbol, exchange, {
        interval,
        startDate: formatCloudDateTime(startDate, includeTime, exchange),
        endDate: formatCloudDateTime(endDate, includeTime, exchange),
        ...(historyRecovery ? { historyRecovery } : {}),
      }),
      `Cloud detailed chart history is unavailable for ${ticker}`,
    );
    return mapCloudPriceHistory(response, target.symbol, exchange, interval, startDate, endDate);
  }

  async getOptionsChain(ticker: string, exchange?: string, expirationDate?: number, _context?: MarketDataRequestContext): Promise<OptionsChain> {
    const target = cloudInstrumentTarget(ticker, exchange);
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudOptionsChain(target.symbol, target.exchange, expirationDate);
      const chain = unwrapRequiredCloudResponse(
        response,
        `Cloud options chains are unavailable for ${ticker}`,
      );
      return mapOptionsChain(chain);
    }, `Cloud options chains are unavailable for ${ticker}`);
  }

  subscribeQuotes(
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void {
    const { valid } = cloudBatchTargets(targets);
    if (!valid.length) return () => {};
    // No-op without a session credential; covers browser cookie sessions too.
    void apiClient.ensureVerifiedSession().catch(() => {});
    const targetMap = new Map<string, QuoteSubscriptionTarget[]>();
    for (const { target } of valid) {
      const key = quoteTargetKey(target.symbol, target.exchange);
      const matches = targetMap.get(key) ?? [];
      matches.push(target);
      targetMap.set(key, matches);
    }
    const requested = new Set(targetMap.keys());

    return apiClient.subscribeQuotes(
      valid.map(({ target, request }) => ({
        ...request,
        surface: target.surface,
        visible: target.visible,
        selected: target.selected,
        weight: target.weight,
      })),
      (target, quote) => {
        let key: string;
        try { key = quoteTargetKey(target.symbol, target.exchange); }
        catch { return; }
        const matchedKey = cloudResponseTargetKey(key, requested);
        const matches = matchedKey ? targetMap.get(matchedKey) ?? [] : [];
        const mappedQuote = mapQuote(quote);
        for (const match of matches) {
          onQuote(match, retainRequestedQuoteSymbol(mappedQuote, match.symbol));
        }
      },
    );
  }
}

export function createGloomberbCloudProvider(): AssetDataProvider {
  return new GloomberbCloudProvider();
}

export function createGloomberbCloudCapabilities(provider = createGloomberbCloudProvider()): PluginCapability[] {
  return [
    assetDataProvider(provider),
    newsProvider({
      id: providerId,
      name: "Gloom Cloud",
      priority: 10,
      provider: {
        supports(query: NewsQuery): boolean {
          const feed = query.feed ?? (query.scope === "ticker" ? "ticker" : "latest");
          return feed === "ticker" ? !!query.ticker : true;
        },
        async fetchNewsPage(query: NewsQuery) {
          const response = await withCloudFallback(
            () => apiClient.getCloudNews(cloudNewsParams(query)),
            "Cloud news is unavailable",
          );
          return {
            articles: response.items.map((item) => mapCloudNewsArticle(item, query.ticker)),
            nextCursor: response.nextCursor ?? null,
          };
        },
        async fetchNews(query: NewsQuery): Promise<NewsArticle[]> {
          const response = await withCloudFallback(
            () => apiClient.getCloudNews(cloudNewsParams(query)),
            "Cloud news is unavailable",
          );
          return response.items.map((item) => mapCloudNewsArticle(item, query.ticker));
        },
        async fetchNewsStory(storyId: string): Promise<NewsArticle | null> {
          const story = await withCloudFallback(
            () => apiClient.getCloudNewsStory(storyId),
            "Cloud news story is unavailable",
          );
          return mapCloudNewsArticle(story);
        },
      },
    }),
  ];
}
