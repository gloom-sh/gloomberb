import type { AssetDataProvider } from "../types/data-provider";
import type { NewsDataProvider } from "../types/capability-route-source";
import type {
  AssetDataCapability,
  CapabilityOperation,
  ChartSeriesCapability,
  ChartSeriesProvider,
  NewsCapability,
} from "./types";

function op(handler: CapabilityOperation["handler"], kind: CapabilityOperation["kind"] = "read"): CapabilityOperation {
  return { kind, rendererSafe: true, handler };
}

function stream(subscribe: CapabilityOperation["subscribe"]): CapabilityOperation {
  return { kind: "stream", rendererSafe: true, subscribe };
}

export function assetDataProvider(provider: AssetDataProvider): AssetDataCapability {
  return {
    id: `asset-data.${provider.id}`,
    sourceId: provider.id,
    kind: "asset-data",
    name: provider.name,
    priority: provider.priority,
    cachePolicy: provider.cachePolicy,
    provider,
    operations: {
      canProvide: op((input: any) => provider.canProvide?.(input.ticker, input.exchange, input.context) ?? true, "query"),
      getCachedFinancialsForTargets: op((input: any) => provider.getCachedFinancialsForTargets?.(input.targets ?? [], input.options) ?? new Map()),
      getQuotesBatch: op((input: any) => provider.getQuotesBatch?.(input.targets ?? [], input.options) ?? Promise.resolve([])),
      getTickerFinancialsBatch: op((input: any) => provider.getTickerFinancialsBatch?.(input.targets ?? [], input.options) ?? Promise.resolve([])),
      getTickerFinancials: op((input: any) => provider.getTickerFinancials(input.ticker, input.exchange, input.context)),
      getQuote: op((input: any) => provider.getQuote(input.ticker, input.exchange, input.context)),
      getExchangeRate: op((input: any) => provider.getExchangeRate(input.fromCurrency)),
      search: op((input: any) => provider.search(input.query, input.context), "query"),
      getSecFilings: op((input: any) => {
        if (!provider.getSecFilings) throw new Error(`${provider.name} does not provide SEC filings.`);
        return provider.getSecFilings(input.ticker, input.count, input.exchange, input.context);
      }, "query"),
      getHolders: op((input: any) => {
        if (!provider.getHolders) throw new Error(`${provider.name} does not provide holders.`);
        return provider.getHolders(input.ticker, input.exchange, input.context);
      }, "query"),
      getAnalystResearch: op((input: any) => {
        if (!provider.getAnalystResearch) throw new Error(`${provider.name} does not provide analyst research.`);
        return provider.getAnalystResearch(input.ticker, input.exchange, input.context);
      }, "query"),
      getCorporateActions: op((input: any) => {
        if (!provider.getCorporateActions) throw new Error(`${provider.name} does not provide corporate actions.`);
        return provider.getCorporateActions(input.ticker, input.exchange, input.context);
      }, "query"),
      getEarningsCalendar: op((input: any) => {
        if (!provider.getEarningsCalendar) throw new Error(`${provider.name} does not provide earnings calendar.`);
        return provider.getEarningsCalendar(input.symbols ?? [], input.context);
      }, "query"),
      getSecFilingDocuments: op((input: any) => {
        if (!provider.getSecFilingDocuments) throw new Error(`${provider.name} does not provide SEC filing documents.`);
        return provider.getSecFilingDocuments(input.filing);
      }, "query"),
      getSecFilingContent: op((input: any) => {
        if (!provider.getSecFilingContent) throw new Error(`${provider.name} does not provide SEC filing content.`);
        return provider.getSecFilingContent(input.filing);
      }, "query"),
      getArticleSummary: op((input: any) => provider.getArticleSummary(input.url), "query"),
      getPriceHistory: op((input: any) => provider.getPriceHistory(input.ticker, input.exchange, input.range, input.context), "query"),
      getPriceHistoryForResolution: op((input: any) => {
        if (!provider.getPriceHistoryForResolution) throw new Error(`${provider.name} does not provide resolution price history.`);
        return provider.getPriceHistoryForResolution(input.ticker, input.exchange, input.bufferRange, input.resolution, input.context);
      }, "query"),
      getDetailedPriceHistory: op((input: any) => {
        if (!provider.getDetailedPriceHistory) throw new Error(`${provider.name} does not provide detailed price history.`);
        return provider.getDetailedPriceHistory(input.ticker, input.exchange, input.startDate, input.endDate, input.barSize, input.context);
      }, "query"),
      getChartResolutionSupport: op((input: any) => provider.getChartResolutionSupport?.(input.ticker, input.exchange, input.context) ?? [], "query"),
      getChartResolutionCapabilities: op((input: any) => provider.getChartResolutionCapabilities?.(input.ticker, input.exchange, input.context) ?? [], "query"),
      getOptionsChain: op((input: any) => {
        if (!provider.getOptionsChain) throw new Error(`${provider.name} does not provide options.`);
        return provider.getOptionsChain(input.ticker, input.exchange, input.expirationDate, input.context);
      }, "query"),
      subscribeQuotes: stream((input: any, emit) => {
        if (!provider.subscribeQuotes) throw new Error(`${provider.name} does not provide quote streaming.`);
        return provider.subscribeQuotes(input.targets ?? [], (target, quote) => emit({ target, quote }));
      }),
    },
  };
}

export function chartSeriesProvider(options: {
  id: string;
  name: string;
  priority?: number;
  provider: ChartSeriesProvider;
}): ChartSeriesCapability {
  return {
    id: options.id,
    kind: "chart-series",
    name: options.name,
    priority: options.priority,
    provider: options.provider,
    operations: {
      catalog: op((input: any) => options.provider.catalog?.(input) ?? [], "query"),
      search: op((input: any) => options.provider.search?.(input) ?? options.provider.catalog?.(input) ?? [], "query"),
      resolve: op((input: any) => options.provider.resolve(input), "query"),
    },
  };
}

export function newsProvider(options: {
  id: string;
  name: string;
  priority?: number;
  provider: NewsDataProvider;
}): NewsCapability {
  return {
    id: `news.${options.id}`,
    sourceId: options.id,
    kind: "news",
    name: options.name,
    priority: options.priority,
    provider: options.provider,
    operations: {
      supports: op((input: any) => options.provider.supports?.(input.query) ?? true, "query"),
      getCachedNews: op((input: any) => options.provider.getCachedNews?.(input.query) ?? [], "query"),
      fetchNews: op((input: any) => options.provider.fetchNews(input.query), "query"),
      fetchNewsStory: op((input: any) => options.provider.fetchNewsStory?.(input.storyId) ?? null, "query"),
    },
  };
}
