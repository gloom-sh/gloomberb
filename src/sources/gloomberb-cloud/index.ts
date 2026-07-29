import type { TimeRange } from "../../time-series/range";
import {
  normalizeChartResolutionSupport,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { assetDataProvider, newsProvider, type PluginCapability } from "../../capabilities";
import type {
  AssetDataProvider,
  CachedFinancialsTarget,
  MarketDataRequestContext,
  QuoteBatchResult,
  QuoteSubscriptionTarget,
  SearchRequestContext,
  TickerFinancialsBatchResult,
} from "../../types/data-provider";
import type { AnalystResearchData, CorporateActionsData, HolderData, OptionsChain, PricePoint, Quote, TickerFinancials } from "../../types/financials";
import type { InstrumentSearchResult } from "../../types/instrument";
import {
  apiClient,
  type CloudAnalystResearchPayload,
  type CloudCorporateActionsPayload,
  type CloudHoldersPayload,
  type CloudMarketResponse,
} from "../../api-client";
import type { NewsArticle, NewsQuery } from "../../types/news-source";
import { resolvePriceHistoryCurrencyUnit } from "../../utils/currency-units";
import { canonicalTickerKey } from "../../utils/exchanges";
import { createProviderMiss } from "../provider-errors";
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
  { resolution: "1d", maxRange: "ALL" },
  { resolution: "1wk", maxRange: "ALL" },
  { resolution: "1mo", maxRange: "ALL" },
]);
const CLOUD_PROVIDER_MISS_PATTERNS = [
  /data not found/i,
  /symbol.*missing or invalid/i,
  /figi.*missing or invalid/i,
  /error in the query/i,
];

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

function quoteTargetKey(symbol: string, exchange?: string): string {
  return canonicalTickerKey(symbol, exchange);
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
    return !!(await apiClient.ensureVerifiedSession());
  }

  async getTickerFinancials(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<TickerFinancials> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudFinancials(ticker, exchange);
      if (isStaleCloudResponse(response)) {
        throw createProviderMiss(`Cloud financials are stale for ${ticker}`);
      }
      return mapCloudFinancials(
        unwrapRequiredCloudResponse(response, `Cloud financials are unavailable for ${ticker}`),
        response.providerMeta,
      );
    }, `Cloud financials are unavailable for ${ticker}`);
  }

  async getTickerFinancialsBatch(
    targets: CachedFinancialsTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<TickerFinancialsBatchResult[]> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudFinancialsBatch(
        targets.map((target) => ({
          symbol: target.symbol,
          exchange: target.exchange,
        })),
        options.forceRefresh ? "refresh" : "cache-first",
      );
      const payload = unwrapRequiredCloudResponse(response, "Cloud financials are unavailable");
      return payload.items.map((item, index) => {
        const target = targets[index] ?? {
          symbol: item.symbol,
          exchange: item.exchange,
        };
        if ((item.status === "success" || item.status === "partial") && item.data) {
          return {
            target,
            financials: mapCloudFinancials(item.data),
          };
        }
        return {
          target,
          financials: null,
          error: mapBatchError(item, `Cloud financials are unavailable for ${target.symbol}`),
        };
      });
    }, "Cloud financials are unavailable");
  }

  async getQuote(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<Quote> {
    await requireVerifiedSession();
    return withCloudFallback(
      async () => {
        const response = await apiClient.getCloudQuote(ticker, exchange);
        if (isStaleCloudResponse(response)) {
          throw createProviderMiss(`Cloud quotes are stale for ${ticker}`);
        }
        return mapQuote(
          unwrapRequiredCloudResponse(response, `Cloud quotes are unavailable for ${ticker}`),
          response.providerMeta,
        );
      },
      `Cloud quotes are unavailable for ${ticker}`,
    );
  }

  async getQuotesBatch(
    targets: QuoteSubscriptionTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QuoteBatchResult[]> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudQuotesBatch(
        targets.map((target) => ({
          symbol: target.symbol,
          exchange: target.exchange,
        })),
        options.forceRefresh ? "refresh" : "cache-first",
      );
      const payload = unwrapRequiredCloudResponse(response, "Cloud quotes are unavailable");
      return payload.items.map((item, index) => {
        const target = targets[index] ?? {
          symbol: item.symbol,
          exchange: item.exchange,
        };
        if ((item.status === "success" || item.status === "partial") && item.data) {
          return {
            target,
            quote: mapQuote(item.data),
          };
        }
        return {
          target,
          quote: null,
          error: mapBatchError(item, `Cloud quotes are unavailable for ${target.symbol}`),
        };
      });
    }, "Cloud quotes are unavailable");
  }

  async getExchangeRate(fromCurrency: string): Promise<number> {
    await requireVerifiedSession();
    const response = await apiClient.getCloudExchangeRate(fromCurrency);
    return unwrapRequiredCloudResponse(response, `Cloud exchange rate is unavailable for ${fromCurrency}`).rate;
  }

  async search(query: string, _context?: SearchRequestContext): Promise<InstrumentSearchResult[]> {
    await requireVerifiedSession();
    return withCloudFallback(
      () => apiClient.searchInstruments(query, 10),
      "Cloud search is unavailable",
    );
  }

  async getHolders(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<HolderData> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudHolders(ticker, exchange);
      return unwrapRequiredCloudResponse(response, `Cloud holders are unavailable for ${ticker}`) as CloudHoldersPayload;
    }, `Cloud holders are unavailable for ${ticker}`);
  }

  async getAnalystResearch(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<AnalystResearchData> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudAnalystResearch(ticker, exchange);
      return unwrapRequiredCloudResponse(response, `Cloud analyst research is unavailable for ${ticker}`) as CloudAnalystResearchPayload;
    }, `Cloud analyst research is unavailable for ${ticker}`);
  }

  async getCorporateActions(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<CorporateActionsData> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudCorporateActions(ticker, exchange);
      return unwrapRequiredCloudResponse(response, `Cloud corporate actions are unavailable for ${ticker}`) as CloudCorporateActionsPayload;
    }, `Cloud corporate actions are unavailable for ${ticker}`);
  }

  async getArticleSummary(_url: string): Promise<string | null> {
    throw createProviderMiss("Cloud article summaries are not available");
  }

  async getPriceHistory(ticker: string, exchange: string, range: TimeRange, _context?: MarketDataRequestContext): Promise<PricePoint[]> {
    await requireVerifiedSession();
    const request = toHistoryRequest(range);
    const response = await withCloudFallback(
      () => apiClient.getCloudHistory(ticker, exchange, request),
      `Cloud chart data is unavailable for ${ticker}`,
    );
    if (isStaleCloudResponse(response)) {
      throw createProviderMiss(`Cloud chart data is stale for ${ticker}`);
    }
    const { divisor } = resolvePriceHistoryCurrencyUnit(response.currency ?? response.providerMeta?.currency, exchange);
    return unwrapRequiredCloudResponse(response, `Cloud chart data is unavailable for ${ticker}`)
      .map((point) => mapPricePoint(point, divisor, exchange));
  }

  async getPriceHistoryForResolution(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    _context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    await requireVerifiedSession();
    const interval = toCloudInterval(resolution);
    const endDate = new Date();
    const startDate = getRangeStartDate(bufferRange, endDate);
    const includeTime = /(min|h)$/i.test(interval);
    const response = await withCloudFallback(
      () => apiClient.getCloudHistory(ticker, exchange, {
        interval,
        startDate: formatCloudDateTime(startDate, includeTime, exchange),
        endDate: formatCloudDateTime(endDate, includeTime, exchange),
      }),
      `Cloud chart data is unavailable for ${ticker}`,
    );
    if (isStaleCloudResponse(response)) {
      throw createProviderMiss(`Cloud chart data is stale for ${ticker}`);
    }
    const { divisor } = resolvePriceHistoryCurrencyUnit(response.currency ?? response.providerMeta?.currency, exchange);
    return unwrapRequiredCloudResponse(response, `Cloud chart data is unavailable for ${ticker}`)
      .map((point) => mapPricePoint(point, divisor, exchange));
  }

  async getDetailedPriceHistory(
    ticker: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    _context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    await requireVerifiedSession();
    const interval = toCloudInterval(barSize);
    const includeTime = /(min|h)$/i.test(interval);
    const response = await withCloudFallback(
      () => apiClient.getCloudHistory(ticker, exchange, {
        interval,
        startDate: formatCloudDateTime(startDate, includeTime, exchange),
        endDate: formatCloudDateTime(endDate, includeTime, exchange),
      }),
      `Cloud detailed chart history is unavailable for ${ticker}`,
    );
    if (isStaleCloudResponse(response)) {
      throw createProviderMiss(`Cloud detailed chart history is stale for ${ticker}`);
    }
    const { divisor } = resolvePriceHistoryCurrencyUnit(response.currency ?? response.providerMeta?.currency, exchange);
    return unwrapRequiredCloudResponse(response, `Cloud detailed chart history is unavailable for ${ticker}`)
      .map((point) => mapPricePoint(point, divisor, exchange));
  }

  async getOptionsChain(ticker: string, exchange?: string, expirationDate?: number, _context?: MarketDataRequestContext): Promise<OptionsChain> {
    await requireVerifiedSession();
    return withCloudFallback(async () => {
      const response = await apiClient.getCloudOptionsChain(ticker, exchange, expirationDate);
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
    if (apiClient.getSessionToken()) {
      void apiClient.ensureVerifiedSession().catch(() => {});
    }
    const targetMap = new Map<string, QuoteSubscriptionTarget[]>();
    for (const target of targets) {
      const key = quoteTargetKey(target.symbol, target.exchange);
      const matches = targetMap.get(key) ?? [];
      matches.push(target);
      targetMap.set(key, matches);
    }

    return apiClient.subscribeQuotes(
      targets.map((target) => ({
        symbol: target.symbol,
        exchange: target.exchange,
        surface: target.surface,
        visible: target.visible,
        selected: target.selected,
        weight: target.weight,
      })),
      (target, quote) => {
        const key = quoteTargetKey(target.symbol, target.exchange);
        const matches = targetMap.get(key) ?? [{
          symbol: target.symbol,
          exchange: target.exchange,
        }];
        const mappedQuote = mapQuote(quote);
        for (const match of matches) {
          onQuote(match, mappedQuote);
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
