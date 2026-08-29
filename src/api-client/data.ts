import type { TickerFinancials } from "../types/financials";
import type { InstrumentSearchResult } from "../types/instrument";
import { normalizeTweetSearchResponse } from "./normalizers";
import {
  cloudCdsPath,
  cloudCongressHousePath,
  cloudExchangeRatePath,
  cloudSec13FPath,
  cloudSecFilingContentPath,
  cloudSecFilingDocumentsPath,
  cloudSecFilingsPath,
  cloudFredSeriesPath,
  cloudHistoryPath,
  cloudMarketSearchPath,
  cloudMarketSymbolPath,
  cloudNewsPath,
  cloudOptionsChainPath,
  cloudStatementsPath,
  cloudTickerTweetsPath,
  cloudTweetSearchPath,
  type CloudCdsParams,
  type CloudCongressHouseParams,
  type CloudFredSeriesParams,
  type CloudHistoryParams,
  type CloudNewsParams,
  type CloudSecFilingParams,
  type CloudSecFilingsParams,
  type CloudTickerTweetsParams,
  type CloudTweetSearchParams,
} from "./paths";
import type {
  CloudAnalystResearchPayload,
  CloudShortInterestPayload,
  CloudCdsResponse,
  CloudCompanyProfile,
  CloudCongressHousePayload,
  CloudCorporateActionsPayload,
  CloudEconEventPayload,
  CloudEquityDiagnosticMode,
  CloudEquityDiagnosticResult,
  CloudFredSeriesPayload,
  CloudFundamentals,
  CloudHoldersPayload,
  CloudMarketBatchPayload,
  CloudMarketBatchTarget,
  CloudMarketResponse,
  CloudMarketScreenerCategory,
  CloudMarketScreenerPayload,
  CloudNewsListResponse,
  CloudNewsPayload,
  CloudSecContentResponse,
  CloudSecDocumentsResponse,
  CloudSecFilingsResponse,
  CloudOptionsChainPayload,
  CloudPricePointPayload,
  CloudQuotePayload,
  CloudTweetSearchResponse,
  CloudWorldVenueMapPayload,
  CloudYieldPointPayload,
} from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export class CloudDataApi {
  constructor(private readonly request: CloudApiRequest) {}

  private requestMarketSymbol<T>(path: string, symbol: string, exchange?: string): Promise<CloudMarketResponse<T>> {
    return this.request<CloudMarketResponse<T>>(cloudMarketSymbolPath(path, symbol, exchange));
  }

  private postMarketBatch<T>(
    path: string,
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<T>>> {
    return this.request<CloudMarketResponse<CloudMarketBatchPayload<T>>>(path, {
      method: "POST",
      body: JSON.stringify({ targets, mode }),
    });
  }

  async searchInstruments(query: string, limit = 10): Promise<InstrumentSearchResult[]> {
    const response = await this.request<CloudMarketResponse<InstrumentSearchResult[]>>(cloudMarketSearchPath(query, limit));
    return response.data ?? [];
  }

  async getCloudQuote(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudQuotePayload>> {
    return this.requestMarketSymbol("/market/quote", symbol, exchange);
  }

  async getCloudQuotesBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudQuotePayload>>> {
    return this.postMarketBatch("/market/quotes/batch", targets, mode);
  }

  async getCloudWorldVenues(): Promise<CloudMarketResponse<CloudWorldVenueMapPayload>> {
    return this.request<CloudMarketResponse<CloudWorldVenueMapPayload>>("/market/venues");
  }

  async getCloudMarketScreener(
    category: CloudMarketScreenerCategory,
    count = 25,
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketScreenerPayload>> {
    const requestedCount = Number.isFinite(count) ? Math.round(count) : 25;
    const params = new URLSearchParams({
      category,
      count: String(Math.max(1, Math.min(50, requestedCount))),
      mode,
    });
    return this.request<CloudMarketResponse<CloudMarketScreenerPayload>>(
      `/market/screener?${params.toString()}`,
    );
  }

  async getCloudOptionsChain(
    symbol: string,
    exchange?: string,
    expirationDate?: number,
  ): Promise<CloudMarketResponse<CloudOptionsChainPayload>> {
    return this.request<CloudMarketResponse<CloudOptionsChainPayload>>(cloudOptionsChainPath(symbol, exchange, expirationDate));
  }

  async getCloudProfile(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudCompanyProfile>> {
    return this.requestMarketSymbol("/market/profile", symbol, exchange);
  }

  async getCloudFundamentals(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudFundamentals>> {
    return this.requestMarketSymbol("/market/fundamentals", symbol, exchange);
  }

  async getCloudFinancials(symbol: string, exchange?: string): Promise<CloudMarketResponse<TickerFinancials>> {
    return this.requestMarketSymbol("/market/financials", symbol, exchange);
  }

  async getCloudFinancialsBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<TickerFinancials>>> {
    return this.postMarketBatch("/market/financials/batch", targets, mode);
  }

  async getCloudHolders(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudHoldersPayload>> {
    return this.requestMarketSymbol("/market/holders", symbol, exchange);
  }

  async getCloudAnalystResearch(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudAnalystResearchPayload>> {
    return this.requestMarketSymbol("/market/analyst", symbol, exchange);
  }

  async getCloudShortInterest(symbol: string, years?: number): Promise<CloudMarketResponse<CloudShortInterestPayload>> {
    const params = new URLSearchParams({ symbol: symbol.toUpperCase() });
    if (years != null) params.set("years", String(years));
    return this.request<CloudMarketResponse<CloudShortInterestPayload>>(`/market/short-interest?${params}`);
  }

  async getCloudCorporateActions(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudCorporateActionsPayload>> {
    return this.requestMarketSymbol("/market/corporate-actions", symbol, exchange);
  }

  async getCloudStatements(
    symbol: string,
    exchange?: string,
    period: "annual" | "quarterly" | "both" = "both",
  ): Promise<CloudMarketResponse<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">>> {
    return this.request<CloudMarketResponse<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">>>(
      cloudStatementsPath(symbol, exchange, period),
    );
  }

  async getCloudHistory(
    symbol: string,
    exchange: string,
    params: CloudHistoryParams = {},
  ): Promise<CloudMarketResponse<CloudPricePointPayload[]>> {
    return this.request<CloudMarketResponse<CloudPricePointPayload[]>>(cloudHistoryPath(symbol, exchange, params));
  }

  async getCloudExchangeRate(fromCurrency: string): Promise<CloudMarketResponse<{ rate: number }>> {
    return this.request<CloudMarketResponse<{ rate: number }>>(cloudExchangeRatePath(fromCurrency));
  }

  /**
   * On-demand single-company evidence review. This is a cloud product endpoint,
   * not a market-data capability, so it is called directly instead of routed
   * through the asset-data provider.
   */
  async getCloudEquityDiagnostic(
    symbol: string,
    exchange?: string,
    mode: CloudEquityDiagnosticMode = "cache-first",
  ): Promise<CloudEquityDiagnosticResult> {
    return this.request<CloudEquityDiagnosticResult>("/research/equity-diagnostic", {
      method: "POST",
      body: JSON.stringify({
        symbol: symbol.trim().toUpperCase(),
        ...(exchange ? { exchange } : {}),
        mode,
      }),
    });
  }

  async getCloudEconomicCalendar(): Promise<CloudEconEventPayload[]> {
    return this.request<CloudEconEventPayload[]>("/cloud/econ/calendar");
  }

  async getCloudFredSeries(
    seriesId: string,
    params: CloudFredSeriesParams = {},
  ): Promise<CloudFredSeriesPayload> {
    return this.request<CloudFredSeriesPayload>(cloudFredSeriesPath(seriesId, params));
  }

  async getCloudYieldCurve(): Promise<CloudYieldPointPayload[]> {
    return this.request<CloudYieldPointPayload[]>("/cloud/econ/yield-curve");
  }

  async getCloudCds(params: CloudCdsParams = {}): Promise<CloudCdsResponse> {
    return this.request<CloudCdsResponse>(cloudCdsPath(params));
  }

  async getCloudCongressHouse(params: CloudCongressHouseParams = {}): Promise<CloudCongressHousePayload> {
    return this.request<CloudCongressHousePayload>(cloudCongressHousePath(params));
  }

  async getCloudSecFilings(params: CloudSecFilingsParams): Promise<CloudSecFilingsResponse> {
    return this.request<CloudSecFilingsResponse>(cloudSecFilingsPath(params));
  }

  async getCloudSecFilingDocuments(params: CloudSecFilingParams): Promise<CloudSecDocumentsResponse> {
    return this.request<CloudSecDocumentsResponse>(cloudSecFilingDocumentsPath(params));
  }

  async getCloudSecFilingContent(params: CloudSecFilingParams): Promise<CloudSecContentResponse> {
    return this.request<CloudSecContentResponse>(cloudSecFilingContentPath(params));
  }

  async getCloudSec13F(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    return this.request<unknown>(cloudSec13FPath(path, params));
  }

  async getCloudNews(params: CloudNewsParams = {}): Promise<CloudNewsListResponse> {
    return this.request<CloudNewsListResponse>(cloudNewsPath(params));
  }

  async getCloudNewsStory(storyId: string): Promise<CloudNewsPayload> {
    return this.request<CloudNewsPayload>(`/news/${encodeURIComponent(storyId)}`);
  }

  async getCloudTickerTweets(params: CloudTickerTweetsParams): Promise<CloudTweetSearchResponse> {
    const response = await this.request<CloudTweetSearchResponse>(cloudTickerTweetsPath(params));
    return normalizeTweetSearchResponse(response);
  }

  async searchCloudTweets(params: CloudTweetSearchParams): Promise<CloudTweetSearchResponse> {
    const response = await this.request<CloudTweetSearchResponse>(cloudTweetSearchPath(params));
    return normalizeTweetSearchResponse(response);
  }
}
