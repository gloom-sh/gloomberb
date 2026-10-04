import type { AttentionPayload, AttentionWindow } from "./attention";
import type { SupplyChainPayload } from "./supply-chain";
import type { EarningsEvent } from "../types/data-provider";
import type { MarketDividendsPayload, MarketHeatmapResult, MarketHeatmapUniverseId, MarketMoversPayload } from "./market-discovery";
import type { DebtMaturitiesPayload } from "./debt-maturities";
import type { RevenueBreakdownPayload, RevenueBreakdownView } from "./revenue-breakdown";
import type { MnaDealPayload, MnaDealsParams, MnaDealsPayload } from "./mna";
import type { IpoCalendarParams, IpoCalendarPayload } from "./ipo";
import type { CryptoMarketsPayload } from "./crypto-markets";
import type { CentralBankRatesPayload } from "./central-bank-rates";
import type { EstimateRevisionsPayload } from "./estimate-revisions";
import type { MoneyMarketsPayload } from "./money-markets";
import type { CloudCurveId, CloudCurveView, CloudWorldCurves } from "./yield-curves";
import type { CdxBoardPayload, CloudCreditBoardParams, SovrBoardPayload } from "./credit-boards";
import type { ShortVolumePayload, ShortVolumeScope } from "./short-volume";
import type { SocialMentionDayPosts, SocialMentionsPayload, SocialMentionsRange } from "./social-mentions";
import type { FuturesCurveAsOfPayload, FuturesCurvePayload } from "./futures-curve";
import type { CotBoardPayload, CotContractPayload, CotFamily, CotClass } from "./cot";
import type { DoeBoardPayload } from "./doe";
import type { GpuBoardPayload, GpuEventsPayload, GpuHistoryPayload, GpuHistoryQuery } from "./gpu";
import type { CpiBoardPayload } from "./cpi";
import type { TapeSnapshot } from "./tape";
import type { ExchangeRateSnapshot } from "../types/exchange-rate";
import type { RatePathPayload } from "./rates";
import type { EarningsCalendarPayload, EarningsCalendarQuery, EarningsHistoryPayload } from "./earnings";
import type { InstrumentSearchResult } from "../types/instrument";
import {
  isSessionMoversCategory,
  type CloudSessionMoversCategory,
  type CloudSessionMoversPayload,
  type CloudSessionMoversSide,
} from "./market-movers";
import {
  normalizeSavedSearchResponse,
  normalizeSearchResponse,
  normalizeTweetSearchResponse,
} from "./normalizers";
import {
  cloudCdsHistoryPath,
  cloudCreditBoardPath,
  cloudCdsPath,
  cloudCongressHousePath,
  cloudEarningsCallsPath,
  cloudEarningsTranscriptPath,
  cloudJobsMoversPath,
  cloudJobsPath,
  cloudJobsPostingsPath,
  type CloudJobsPostingsParams,
  cloudProxyStatementPath,
  cloudFilingEventsPath,
  cloudRiskReportPath,
  cloudRiskReportsPath,
  cloudProxyStatementsPath,
  cloudExchangeRatePath,
  cloudSec13FPath,
  cloudSecFilingContentPath,
  cloudSecFilingDocumentsPath,
  cloudSecFilingsPath,
  cloudFredSeriesPath,
  cloudShillerPath,
  cloudHistoryPath,
  cloudMarketSearchPath,
  cloudMarketSymbolPath,
  cloudNewsPath,
  cloudOptionsChainPath,
  cloudSavedSearchPath,
  cloudSavedSearchesPath,
  cloudSearchDocumentPath,
  cloudSearchPath,
  cloudTickerTweetsPath,
  cloudTweetSearchPath,
  type CloudCdsHistoryParams,
  type CloudCdsParams,
  type CloudCongressHouseParams,
  type CloudEarningsCallsParams,
  type CloudFredSeriesParams,
  type CloudHistoryParams,
  type CloudNewsParams,
  type CloudSearchParams,
  type CloudSecFilingParams,
  type CloudSecFilingsParams,
  type CloudTickerTweetsParams,
  type CloudTweetSearchParams,
} from "./paths";
import type {
  CloudAnalystResearchPayload,
  CloudShortInterestPayload,
  CloudCdsHistoryResponse,
  CloudCdsResponse,
  CloudCongressHousePayload,
  CloudEarningsCallListPayload,
  CloudEarningsTranscriptPayload,
  CloudJobsMoversPayload,
  CloudJobsPostingsPayload,
  CloudJobsResponse,
  CloudProxyStatementListPayload,
  CloudProxyStatementPayload,
  CloudFilingEventPayload,
  CloudRiskReportListPayload,
  CloudRiskReportPayload,
  CloudCorporateActionsPayload,
  CloudEconEventPayload,
  CloudEquityDiagnosticMode,
  CloudEquityDiagnosticResult,
  CloudFredSeriesPayload,
  CloudShillerPayload,
  CloudFinancialsPayload,
  CloudHoldersPayload,
  CloudMarketBatchPayload,
  CloudMarketBatchTarget,
  CloudMarketResponse,
  CloudMarketScreenerCategory,
  CloudMarketScreenerPayload,
  CloudNewsListResponse,
  CloudNewsPayload,
  CloudSavedSearch,
  CloudSavedSearchInput,
  CloudSavedSearchListResponse,
  CloudSearchDocType,
  CloudSearchDocument,
  CloudSearchDocumentResponse,
  CloudSearchResponse,
  CloudSecContentResponse,
  CloudSecDocumentsResponse,
  CloudSecFilingsResponse,
  CloudOptionsChainPayload,
  CloudPricePointPayload,
  CloudQuotePayload,
  CloudTweetSearchResponse,
  CloudWorldVenueMapPayload,
  CloudYieldPointPayload,
  ScannerFlowHistoryPage,
} from "./types";
import type { CloudApiRequest } from "./request";

export class CloudDataApi {
  constructor(private readonly request: CloudApiRequest) {}

  private requestMarketSymbol<T>(
    path: string,
    symbol: string,
    exchange?: string,
  ): Promise<CloudMarketResponse<T>> {
    return this.request<CloudMarketResponse<T>>(
      cloudMarketSymbolPath(path, symbol, exchange),
    );
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

  /** EQS endpoints live in the plugin client; one prefix-scoped method keeps the shared client small. */
  equityScreener<T>(path: string, init?: RequestInit) {
    return this.request<T>(`/cloud/equity-screener/${path}`, init);
  }

  /** Stored implied volatility (HIVG, VCA, OVDV dates); one prefix-scoped method, like EQS. */
  impliedVolatility<T>(path: string, init?: RequestInit) {
    return this.request<T>(`/cloud/iv/${path}`, init);
  }

  /** Options positioning (OPX): open interest by strike and expiry, max pain, dealer gamma. */
  optionsPositioning<T>(path: string, init?: RequestInit) {
    return this.request<T>(`/cloud/options/${path}`, init);
  }

  async searchInstruments(
    query: string,
    limit = 10,
  ): Promise<InstrumentSearchResult[]> {
    const response = await this.request<
      CloudMarketResponse<InstrumentSearchResult[]>
    >(cloudMarketSearchPath(query, limit));
    return response.data ?? [];
  }

  async getCloudEstimateRevisions(symbol: string, exchange: string): Promise<EstimateRevisionsPayload> {
    return this.request<EstimateRevisionsPayload>(`/cloud/research/estimates/${encodeURIComponent(symbol)}?exchange=${encodeURIComponent(exchange)}`, { signal: AbortSignal.timeout(45_000) });
  }

  async getCloudEarningsCalendar(query: EarningsCalendarQuery): Promise<EarningsCalendarPayload> {
    const params = new URLSearchParams({ from: query.from, to: query.to });
    if (query.perDay != null) params.set("perDay", String(query.perDay));
    if (query.symbols?.length) params.set("symbols", query.symbols.join(","));
    return this.request<EarningsCalendarPayload>(`/cloud/earnings/calendar?${params}`, { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudEarningsHistory(symbol: string): Promise<EarningsHistoryPayload> {
    const params = new URLSearchParams({ symbol, limit: "13" });
    return this.request<EarningsHistoryPayload>(`/cloud/earnings/history?${params}`, { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudQuote(
    symbol: string,
    exchange?: string,
  ): Promise<CloudMarketResponse<CloudQuotePayload>> {
    return this.requestMarketSymbol("/market/quote", symbol, exchange);
  }

  async getCloudQuotesBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudQuotePayload>>> {
    return this.postMarketBatch("/market/quotes/batch", targets, mode);
  }

  async getCloudWorldVenues(): Promise<
    CloudMarketResponse<CloudWorldVenueMapPayload>
  > {
    return this.request<CloudMarketResponse<CloudWorldVenueMapPayload>>(
      "/market/venues",
    );
  }

  getMarketEarningsCalendar(symbols: string[]): Promise<CloudMarketResponse<Array<Omit<EarningsEvent, "earningsDate" | "earningsCallDate"> & { earningsDate: string; earningsCallDate?: string | null }>>> {
    return this.request(`/market/earnings-calendar?${new URLSearchParams({ symbols: symbols.join(",") })}`);
  }

  getCloudArticleSummary(url: string): Promise<{ summary: string | null }> {
    return this.request(`/news/article-summary?${new URLSearchParams({ url })}`);
  }

  getMarketMovers(category: "day_gainers" | "day_losers" | "most_actives", count = 25, refresh = false): Promise<CloudMarketResponse<MarketMoversPayload>> {
    const params = new URLSearchParams({ category, count: String(count), mode: refresh ? "refresh" : "cache-first" });
    return this.request(`/market/movers?${params}`);
  }

  getMarketTrending(count = 25): Promise<CloudMarketResponse<Array<{ symbol: string }>>> {
    return this.request(`/market/trending?count=${encodeURIComponent(count)}`);
  }

  getMarketHeatmap(universe: MarketHeatmapUniverseId, count = 80): Promise<CloudMarketResponse<MarketHeatmapResult>> {
    return this.request(`/market/heatmap?${new URLSearchParams({ universe, count: String(count) })}`);
  }

  getMarketDividends(symbol: string, exchange = ""): Promise<CloudMarketResponse<MarketDividendsPayload>> {
    return this.requestMarketSymbol("/market/dividends", symbol, exchange);
  }

  /** Gainers, losers and most active, or the pre-market, after-hours and gap lists with a `side`. */
  async getCloudMarketScreener<Category extends CloudMarketScreenerCategory | CloudSessionMoversCategory>(
    category: Category,
    count = 25,
    mode: "cache-first" | "refresh" = "cache-first",
    side?: CloudSessionMoversSide,
  ): Promise<CloudMarketResponse<Category extends CloudSessionMoversCategory ? CloudSessionMoversPayload : CloudMarketScreenerPayload>> {
    const requestedCount = Number.isFinite(count) ? Math.round(count) : 25;
    const params = new URLSearchParams({
      category,
      count: String(Math.max(1, Math.min(50, requestedCount))),
      mode,
    });
    if (side && isSessionMoversCategory(category)) params.set("side", side);
    return this.request(`/market/screener?${params.toString()}`);
  }

  async getCloudOptionsChain(
    symbol: string,
    exchange?: string,
    expirationDate?: number,
  ): Promise<CloudMarketResponse<CloudOptionsChainPayload>> {
    return this.request<CloudMarketResponse<CloudOptionsChainPayload>>(
      cloudOptionsChainPath(symbol, exchange, expirationDate),
    );
  }

  async getCloudFinancials(
    symbol: string,
    exchange?: string,
    statementHistory?: "extended",
  ): Promise<CloudMarketResponse<CloudFinancialsPayload>> {
    const path = cloudMarketSymbolPath("/market/financials", symbol, exchange);
    return this.request(statementHistory === "extended" ? `${path}&statementHistory=extended` : path);
  }

  async getCloudFinancialsBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudFinancialsPayload>>> {
    return this.postMarketBatch("/market/financials/batch", targets, mode);
  }

  async getCloudHolders(
    symbol: string,
    exchange?: string,
  ): Promise<CloudMarketResponse<CloudHoldersPayload>> {
    return this.requestMarketSymbol("/market/holders", symbol, exchange);
  }

  async getCloudAnalystResearch(
    symbol: string,
    exchange?: string,
  ): Promise<CloudMarketResponse<CloudAnalystResearchPayload>> {
    return this.requestMarketSymbol("/market/analyst", symbol, exchange);
  }

  async getCloudShortInterest(
    symbol: string,
    years?: number,
  ): Promise<CloudMarketResponse<CloudShortInterestPayload>> {
    const params = new URLSearchParams({ symbol: symbol.toUpperCase() });
    if (years != null) params.set("years", String(years));
    return this.request<CloudMarketResponse<CloudShortInterestPayload>>(
      `/market/short-interest?${params}`,
    );
  }

  async getCloudCorporateActions(
    symbol: string,
    exchange?: string,
  ): Promise<CloudMarketResponse<CloudCorporateActionsPayload>> {
    return this.requestMarketSymbol(
      "/market/corporate-actions",
      symbol,
      exchange,
    );
  }

  async getCloudHistory(
    symbol: string,
    exchange: string,
    params: CloudHistoryParams = {},
  ): Promise<CloudMarketResponse<CloudPricePointPayload[]>> {
    return this.request<CloudMarketResponse<CloudPricePointPayload[]>>(
      cloudHistoryPath(symbol, exchange, params),
    );
  }

  async getCloudExchangeRate(
    fromCurrency: string,
  ): Promise<CloudMarketResponse<Partial<ExchangeRateSnapshot> & { rate: number }>> {
    return this.request<CloudMarketResponse<Partial<ExchangeRateSnapshot> & { rate: number }>>(
      cloudExchangeRatePath(fromCurrency),
    );
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
    return this.request<CloudEquityDiagnosticResult>(
      "/research/equity-diagnostic",
      {
        method: "POST",
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          ...(exchange ? { exchange } : {}),
          mode,
        }),
      },
    );
  }

  async getCloudEconomicCalendar(): Promise<CloudEconEventPayload[]> {
    return this.request<CloudEconEventPayload[]>("/cloud/econ/calendar");
  }

  async getCloudFredSeries(
    seriesId: string,
    params: CloudFredSeriesParams = {},
  ): Promise<CloudFredSeriesPayload> {
    return this.request<CloudFredSeriesPayload>(
      cloudFredSeriesPath(seriesId, params),
    );
  }

  async getCloudShiller(): Promise<CloudShillerPayload> {
    return this.request<CloudShillerPayload>(cloudShillerPath());
  }

  async getCloudCotBoard(report: CotFamily, traderClass: CotClass): Promise<CotBoardPayload> {
    return this.request<CotBoardPayload>(`/cloud/cot/board?${new URLSearchParams({ report, traderClass })}`);
  }

  async getCloudCotContract(code: string, report: CotFamily): Promise<CotContractPayload> {
    return this.request<CotContractPayload>(`/cloud/cot/contracts/${encodeURIComponent(code)}?${new URLSearchParams({ report })}`);
  }

  /** Credit-document paths stay with their pane; keep the shared client small. */
  creditDocuments<T>(path: string): Promise<T> {
    return this.request<T>(`/cloud/credit-documents/${path}`);
  }

  async getCloudSupplyChain(symbol: string): Promise<SupplyChainPayload> {
    return this.request<SupplyChainPayload>(`/cloud/supply-chain/${encodeURIComponent(symbol)}`);
  }

  async getCloudDoeBoard(): Promise<DoeBoardPayload> {
    return this.request<DoeBoardPayload>("/cloud/doe/board");
  }

  async getCloudAttention(window: AttentionWindow = "now", symbol?: string): Promise<AttentionPayload> {
    const path = symbol ? `/cloud/attention/${encodeURIComponent(symbol)}` : "/cloud/attention";
    return this.request<AttentionPayload>(`${path}?window=${window}`);
  }

  async getCloudGpuBoard(): Promise<GpuBoardPayload> {
    return this.request<GpuBoardPayload>("/cloud/gpu/board");
  }

  async getCloudGpuHistory(query: GpuHistoryQuery = {}): Promise<GpuHistoryPayload> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<GpuHistoryPayload>(`/cloud/gpu/history?${params}`);
  }

  async getCloudGpuEvents(gpuModel?: string): Promise<GpuEventsPayload> {
    const params = new URLSearchParams({ limit: "1000", ...(gpuModel ? { gpuModel } : {}) });
    return this.request<GpuEventsPayload>(`/cloud/gpu/events?${params}`);
  }

  async getCloudCpiBoard(): Promise<CpiBoardPayload> {
    return this.request<CpiBoardPayload>("/cloud/cpi/board");
  }

  async getCloudTape(symbol: string, exchange: string, signal?: AbortSignal): Promise<TapeSnapshot> {
    return this.request<TapeSnapshot>(`/cloud/tape/${encodeURIComponent(symbol)}?exchange=${encodeURIComponent(exchange)}`, { signal: signal ?? AbortSignal.timeout(30_000) });
  }

  async getCloudYieldCurve(): Promise<CloudYieldPointPayload[]> {
    return this.request<CloudYieldPointPayload[]>("/cloud/econ/yield-curve");
  }

  /** A curve's session on or before `date` (latest without one), with look-backs and spreads. */
  async getCloudCurve(curve: CloudCurveId, date?: string | null): Promise<CloudCurveView> {
    const query = date ? `?${new URLSearchParams({ date })}` : "";
    return this.request<CloudCurveView>(`/cloud/econ/curves/${encodeURIComponent(curve)}${query}`, { signal: AbortSignal.timeout(30_000) });
  }

  /** Each market's latest curve and the session before, each on its own date. */
  async getCloudWorldCurves(): Promise<CloudWorldCurves> {
    return this.request<CloudWorldCurves>("/cloud/econ/curves", { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudCryptoMarkets(): Promise<CryptoMarketsPayload> {
    return this.request<CryptoMarketsPayload>("/cloud/crypto/markets", { signal: AbortSignal.timeout(45_000) });
  }

  async getCloudCentralBankRates(): Promise<CentralBankRatesPayload> {
    return this.request<CentralBankRatesPayload>("/cloud/econ/central-bank-rates", { signal: AbortSignal.timeout(45_000) });
  }

  /** Recorded FLOW prints older than the live tape (Pro); the plugin builds `search`. */
  getScannerFlowHistory(search: string, signal?: AbortSignal) {
    return this.request<ScannerFlowHistoryPage>(`/market/scanner/flow/history?${search}`, { signal });
  }

  getMobileAlertHistory<T>(offset = 0) {
    return this.request<T>(`/mobile/alerts/history?offset=${offset}`);
  }

  async getCloudMoneyMarkets(): Promise<MoneyMarketsPayload> {
    return this.request<MoneyMarketsPayload>("/cloud/econ/money-markets", { signal: AbortSignal.timeout(45_000) });
  }

  async getCloudDebtMaturities(symbol: string): Promise<DebtMaturitiesPayload> {
    const params = new URLSearchParams({ symbol });
    return this.request<DebtMaturitiesPayload>(`/cloud/debt-maturities?${params}`, { signal: AbortSignal.timeout(45_000) });
  }

  async getCloudRevenueBreakdown(symbol: string, view?: RevenueBreakdownView): Promise<RevenueBreakdownPayload> {
    const params = new URLSearchParams({ symbol, ...(view ? { view } : {}) });
    return this.request<RevenueBreakdownPayload>(`/cloud/revenue-breakdown?${params}`, { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudMnaDeals(params: MnaDealsParams = {}, options?: { signal?: AbortSignal }): Promise<MnaDealsPayload> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const text = query.toString();
    const suffix = text ? `?${text}` : "";
    return this.request<MnaDealsPayload>(`/cloud/mna/deals${suffix}`, { signal: options?.signal ?? AbortSignal.timeout(30_000) });
  }

  async getCloudMnaDeal(id: string, options?: { signal?: AbortSignal }): Promise<MnaDealPayload> {
    return this.request<MnaDealPayload>(`/cloud/mna/deals/${encodeURIComponent(id)}`, { signal: options?.signal ?? AbortSignal.timeout(30_000) });
  }

  async getCloudIpoCalendar(params: IpoCalendarParams = {}, options?: { signal?: AbortSignal }): Promise<IpoCalendarPayload> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const text = query.toString();
    const suffix = text ? `?${text}` : "";
    return this.request<IpoCalendarPayload>(`/cloud/ipo/calendar${suffix}`, { signal: options?.signal ?? AbortSignal.timeout(30_000) });
  }

  async getCloudShortVolume(symbol: string, scope: ShortVolumeScope = "nms"): Promise<ShortVolumePayload> {
    const params = new URLSearchParams({ symbol, scope });
    return this.request<ShortVolumePayload>(`/cloud/short-volume?${params}`, { signal: AbortSignal.timeout(20_000) });
  }

  async getCloudSocialMentions(symbol: string, range: SocialMentionsRange = "1y"): Promise<SocialMentionsPayload> {
    const params = new URLSearchParams({ symbol, range });
    return this.request<SocialMentionsPayload>(`/cloud/social-mentions?${params}`, { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudSocialMentionPosts(symbol: string, day: string): Promise<SocialMentionDayPosts> {
    const params = new URLSearchParams({ symbol, day });
    return this.request<SocialMentionDayPosts>(`/cloud/social-mentions/posts?${params}`, { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudFuturesCurve(root: string): Promise<FuturesCurvePayload> {
    return this.request<FuturesCurvePayload>(`/cloud/futures/curve/${encodeURIComponent(root)}`, { signal: AbortSignal.timeout(60_000) });
  }

  async getCloudFuturesCurveAsOf(root: string, date: string): Promise<FuturesCurveAsOfPayload> {
    return this.request<FuturesCurveAsOfPayload>(`/cloud/futures/curve/${encodeURIComponent(root)}/as-of/${encodeURIComponent(date)}`,
      { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudRatePath(): Promise<RatePathPayload> {
    return this.request<RatePathPayload>("/cloud/econ/rate-path", { signal: AbortSignal.timeout(45_000) });
  }

  async getCloudCds(params: CloudCdsParams = {}): Promise<CloudCdsResponse> {
    return this.request<CloudCdsResponse>(cloudCdsPath(params));
  }

  async getCloudCdsHistory(params: CloudCdsHistoryParams): Promise<CloudCdsHistoryResponse> {
    return this.request<CloudCdsHistoryResponse>(cloudCdsHistoryPath(params), { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudCdxBoard(params: CloudCreditBoardParams = {}): Promise<CdxBoardPayload> {
    return this.request<CdxBoardPayload>(cloudCreditBoardPath("cdx", params), { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudSovrBoard(params: CloudCreditBoardParams = {}): Promise<SovrBoardPayload> {
    return this.request<SovrBoardPayload>(cloudCreditBoardPath("sovr", params), { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudCongressHouse(
    params: CloudCongressHouseParams = {},
    options?: { signal?: AbortSignal },
  ): Promise<CloudCongressHousePayload> {
    return this.request<CloudCongressHousePayload>(
      cloudCongressHousePath(params),
      options,
    );
  }

  async getCloudJobs(ticker: string, name?: string | null): Promise<CloudJobsResponse> {
    return this.request<CloudJobsResponse>(cloudJobsPath(ticker, name));
  }

  async getCloudJobsPostings(
    ticker: string,
    params: CloudJobsPostingsParams = {},
  ): Promise<CloudJobsPostingsPayload> {
    return this.request<CloudJobsPostingsPayload>(cloudJobsPostingsPath(ticker, params));
  }

  async getCloudJobsMovers(limit?: number, offset?: number): Promise<CloudJobsMoversPayload> {
    return this.request<CloudJobsMoversPayload>(cloudJobsMoversPath(limit, offset));
  }

  async getCloudEarningsCalls(
    params: CloudEarningsCallsParams = {},
  ): Promise<CloudEarningsCallListPayload> {
    return this.request<CloudEarningsCallListPayload>(
      cloudEarningsCallsPath(params),
    );
  }

  async getCloudEarningsTranscript(
    id: string,
  ): Promise<CloudEarningsTranscriptPayload> {
    return this.request<CloudEarningsTranscriptPayload>(
      cloudEarningsTranscriptPath(id),
    );
  }

  async getProxyStatements(
    ticker: string,
  ): Promise<CloudProxyStatementListPayload> {
    return this.request<CloudProxyStatementListPayload>(
      cloudProxyStatementsPath(ticker),
    );
  }

  async getProxyStatement(
    ticker: string,
    year: number,
  ): Promise<CloudProxyStatementPayload> {
    return this.request<CloudProxyStatementPayload>(
      cloudProxyStatementPath(ticker, year),
    );
  }

  async getFilingEvents(
    ticker: string,
    limit?: number,
  ): Promise<{ ticker: string; events: CloudFilingEventPayload[] }> {
    return this.request<{ ticker: string; events: CloudFilingEventPayload[] }>(
      cloudFilingEventsPath(ticker, limit),
    );
  }

  async getRiskReports(ticker: string): Promise<CloudRiskReportListPayload> {
    return this.request<CloudRiskReportListPayload>(
      cloudRiskReportsPath(ticker),
    );
  }

  async getRiskReport(
    ticker: string,
    year: number,
  ): Promise<CloudRiskReportPayload> {
    return this.request<CloudRiskReportPayload>(
      cloudRiskReportPath(ticker, year),
    );
  }

  async getCloudSecFilings(
    params: CloudSecFilingsParams,
  ): Promise<CloudSecFilingsResponse> {
    return this.request<CloudSecFilingsResponse>(cloudSecFilingsPath(params));
  }

  async getCloudSecFilingDocuments(
    params: CloudSecFilingParams,
  ): Promise<CloudSecDocumentsResponse> {
    return this.request<CloudSecDocumentsResponse>(
      cloudSecFilingDocumentsPath(params),
    );
  }

  async getCloudSecFilingContent(
    params: CloudSecFilingParams,
  ): Promise<CloudSecContentResponse> {
    return this.request<CloudSecContentResponse>(
      cloudSecFilingContentPath(params),
    );
  }

  async getCloudSec13F(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    return this.request<unknown>(cloudSec13FPath(path, params));
  }

  /**
   * Cross-document full-text search. Pro-gated: unentitled accounts get a 402,
   * which the caller turns into the access gate rather than an empty result.
   */
  async searchCloudDocuments(
    params: CloudSearchParams,
    options?: { signal?: AbortSignal },
  ): Promise<CloudSearchResponse> {
    return normalizeSearchResponse(
      await this.request<CloudSearchResponse>(cloudSearchPath(params), {
        signal: options?.signal,
      }),
    );
  }

  async getCloudSearchDocument(
    docType: CloudSearchDocType,
    sourceId: string,
    options?: { signal?: AbortSignal },
  ): Promise<CloudSearchDocument> {
    const response = await this.request<CloudSearchDocumentResponse>(
      cloudSearchDocumentPath(docType, sourceId),
      { signal: options?.signal },
    );
    return response.document;
  }

  async getCloudSavedSearches(options?: {
    signal?: AbortSignal;
  }): Promise<CloudSavedSearch[]> {
    const response = await this.request<CloudSavedSearchListResponse>(
      cloudSavedSearchesPath(),
      {
        signal: options?.signal,
      },
    );
    return response.searches ?? [];
  }

  async createCloudSavedSearch(
    input: CloudSavedSearchInput,
  ): Promise<CloudSavedSearch> {
    return normalizeSavedSearchResponse(
      await this.request<unknown>(cloudSavedSearchesPath(), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async updateCloudSavedSearch(
    id: string,
    update: Partial<CloudSavedSearchInput>,
  ): Promise<CloudSavedSearch> {
    return normalizeSavedSearchResponse(
      await this.request<unknown>(cloudSavedSearchPath(id), {
        method: "PATCH",
        body: JSON.stringify(update),
      }),
    );
  }

  async deleteCloudSavedSearch(id: string): Promise<void> {
    await this.request<void>(cloudSavedSearchPath(id), { method: "DELETE" });
  }

  async getCloudNews(
    params: CloudNewsParams = {},
  ): Promise<CloudNewsListResponse> {
    return this.request<CloudNewsListResponse>(cloudNewsPath(params));
  }

  async getCloudNewsStory(storyId: string): Promise<CloudNewsPayload> {
    return this.request<CloudNewsPayload>(
      `/news/${encodeURIComponent(storyId)}`,
    );
  }

  async getCloudTickerTweets(
    params: CloudTickerTweetsParams,
  ): Promise<CloudTweetSearchResponse> {
    const response = await this.request<CloudTweetSearchResponse>(
      cloudTickerTweetsPath(params),
    );
    return normalizeTweetSearchResponse(response);
  }

  async searchCloudTweets(
    params: CloudTweetSearchParams,
  ): Promise<CloudTweetSearchResponse> {
    const response = await this.request<CloudTweetSearchResponse>(
      cloudTweetSearchPath(params),
    );
    return normalizeTweetSearchResponse(response);
  }
}
