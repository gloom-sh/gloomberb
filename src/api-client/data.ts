import type { AttentionPayload, AttentionWindow } from "./attention";
import type { HiringBoard, HiringBuildingBoard, HiringBuildingFilter, HiringCompanyBuilding, HiringCompanyMoves, HiringCompanySignals, HiringMovesBoard, HiringMovesFilter, HiringPayload, HiringSignalGroup, HiringSignalsBoard, HiringSignalsFilter } from "./hiring";
import type { AppAttentionFilter, AppAttentionPayload, AppRankPayload } from "./app-attention";
import type { CatalystResponse, CatalystDetail, CatalystFilters, CatalystStatus, CatalystChanges } from "./catalysts";
import type { KpisPayload, GuidancePayload, KpiQueryOptions } from "./company-kpis";
import { companyDisclosurePath } from "./company-kpis";
import { cloudExchangeAnnouncementsPath } from "./exchange-announcements";
import type { PowerBoard, PowerDetail, PowerFilter, PowerHistory } from "./power";
import type { PerpBoardPayload, PerpEquitiesPayload, PerpEquityListing, PerpHistoryPayload, PerpRankingsPayload, PerpBoardQuery, PerpHistoryQuery,
  PerpMarketPayload, PerpLiquidationsPayload, PerpDepthPayload } from "./perps";
import type { ExposureRequest, ExposurePayload, ExposureScenario } from "./exposure";
import type { SupplyChainPayload, SupplyOptions } from "./supply-chain";
import { supplyGraphQuery, type GraphOptions, type GraphPayload } from "./supply-chain-graph";
import type { AwardDetailPayload, AwardFilter, AwardsPayload } from "./awards";
import type { EarningsEvent } from "../types/data-provider";
import type { MarketDividendsPayload, MarketHeatmapResult, MarketHeatmapUniverseId, MarketMoversPayload } from "./market-discovery";
import type { BankFiguresPayload } from "./bank-figures";
import type { DebtMaturitiesPayload } from "./debt-maturities";
import type { RevenueBreakdownPayload, RevenueBreakdownView } from "./revenue-breakdown";
import type { MnaDealPayload, MnaDealsParams, MnaDealsPayload } from "./mna";
import {
  distressQuery,
  type DistressDesignationsParams,
  type DistressFilingsParams,
  type GoingConcernParams,
  type InsolvencyNoticesParams,
} from "./distress";
import type { LettersParams } from "./letters";
import type { IpoCalendarParams, IpoCalendarPayload } from "./ipo";
import type { TickerChanges } from "../types/ticker-changes";
import type { IssuerListings } from "../types/issuer-listings";
import type { OrganizationTickersResponse } from "./organization-tickers";
import type { CryptoMarketsPayload, DefiTvlPayload, StablecoinSupplyHistoryPayload, StablecoinSupplyPayload } from "./crypto-markets";
import type { CryptoEtfFlowAsset, CryptoEtfFlowsPayload } from "./crypto-etf-flows";
import type { CentralBankRatesPayload } from "./central-bank-rates";
import type { EstimateRevisionsPayload } from "./estimate-revisions";
import type { MoneyMarketsPayload } from "./money-markets";
import type { CloudCurveHistory, CloudCurveId, CloudCurveView, CloudWorldCurves } from "./yield-curves";
import type { SwapCurvePayload, SwapTenor } from "./swap-curve";
import type { CdxBoardPayload, CloudCreditBoardParams, SovrBoardPayload } from "./credit-boards";
import type { ShortVolumePayload, ShortVolumeScope } from "./short-volume";
import type { FailsToDeliverPayload, OtcVolumePayload } from "./short-side-publications";
import type { BeneficialOwnersPayload, CloudBeneficialOwnersParams } from "./beneficial-owners";
import type { CloudInsiderSignalsParams, InsiderSignalsPayload } from "./insider-signals";
import type { SocialMentionDayPosts, SocialMentionsPayload, SocialMentionsRange } from "./social-mentions";
import type { FuturesContractTermsPayload, FuturesCurveAsOfPayload, FuturesCurvePayload } from "./futures-curve";
import type { CotBoardPayload, CotContractPayload, CotFamily, CotClass, CotPositions } from "./cot";
import type { DoeBoardPayload, DoePricesPayload } from "./doe";
import type { JodiBoardPayload, PsdBoardPayload } from "./commodity-balances";
import type { CarbonBoard, CarbonHistory, EuropePowerBoard, EuropePowerHistory, GasStorageBoard, GasStorageHistory, GasStorageSeasonal } from "./europe-energy";
import type { GpuBoardPayload, GpuEventsPayload, GpuHistoryPayload, GpuHistoryQuery } from "./gpu";
import type { CpiBoardPayload } from "./cpi";
import type { TapeRange, TapeSnapshot } from "./tape";
import { LIVE_SCAN_PATH, type LiveScanPayload, type LiveScanWireDefinition } from "./live-scan";
import { signalWithTimeout } from "../utils/async-deadline";
import { ApiRequestError } from "./errors";
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
  cloudEarningsCallAudioPath,
  cloudEarningsTranscriptPath,
  cloudJobsMoversPath,
  cloudJobsPath,
  cloudJobsPostingPath,
  cloudJobsPostingsPath,
  type CloudJobsPostingsParams,
  type IssuerListingParams,
  cloudProxyStatementPath,
  cloudBankFiguresPath,
  cloudDebtMaturitiesPath,
  cloudFilingEventsPath,
  cloudRiskReportPath,
  cloudRiskReportsPath,
  cloudProxyStatementsPath,
  cloudRevenueBreakdownPath,
  cloudExchangeRatePath,
  cloudSec13FPath,
  cloudSecBeneficialOwnersPath,
  cloudSecInsiderSignalsPath,
  cloudSecFilingContentPath,
  cloudSecFilingDocumentsPath,
  cloudSecFilingsPath,
  cloudFredSeriesPath,
  cloudShillerPath,
  cloudHistoryPath,
  cloudMarketSearchPath,
  cloudMarketSymbolPath,
  cloudNewsPath,
  cloudNewsSearchPath,
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
  CloudCdsLevelsResponse,
  CloudCdsResponse,
  CloudCongressHousePayload,
  CloudEarningsCallListPayload,
  CloudEarningsCallAudioPayload,
  CloudEarningsTranscriptPayload,
  CloudJobsMoversPayload,
  CloudJobsPostingDetail,
  CloudJobsPostingsPayload,
  CloudJobsResponse,
  CloudProxyStatementListPayload,
  CloudProxyStatementPayload,
  CloudFilingEventPayload,
  CloudRiskReportListPayload,
  CloudRiskReportPayload,
  CloudCorporateActionsPayload,
  CloudEconEventPayload,
  CloudShortRatesPayload,
  CloudMacroReleaseDaysPayload,
  CloudEquityDiagnosticMode,
  CloudEquityDiagnosticResult,
  CloudFredSeriesCatalogPayload,
  CloudFredSeriesPayload,
  CloudShillerPayload,
  CloudFinancialsPayload,
  CloudHoldersPayload,
  CloudMarketBatchPayload,
  CloudMarketBatchTarget,
  CloudMarketResponse,
  CloudMarketScreenerCategory,
  CloudMarketScreenerPayload,
  CloudMoverSession,
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

/** A batched lookup's answer: one item per key asked, with that key's own status. */
type CloudBatchAnswer<K extends string, T> = {
  items?: Array<{ status?: string; data?: T | null } & Record<K, string>>;
};

/**
 * A batched lookup's items by the key each was asked as: the data of an item
 * that has some, null for one with nothing on record, and none for one the
 * service could not answer (rate limited, an upstream failure).
 */
function batchAnswers<K extends string, T>(response: CloudMarketResponse<CloudBatchAnswer<K, T>>, key: K): Map<string, T | null> {
  const answers = new Map<string, T | null>();
  for (const item of response.data?.items ?? []) {
    if (typeof item?.[key] !== "string") continue;
    if (item.status === "success" || item.status === "partial") answers.set(item[key], item.data ?? null);
    else if (item.status === "empty") answers.set(item[key], null);
  }
  return answers;
}

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
    signal?: AbortSignal,
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<T>>> {
    return this.request<CloudMarketResponse<CloudMarketBatchPayload<T>>>(path, {
      method: "POST",
      body: JSON.stringify({ targets, mode }),
      ...(signal ? { signal } : {}),
    });
  }

  /** EQS endpoints live in the plugin client; one prefix-scoped method keeps the shared client small. */
  equityScreener<T>(path: string, init?: RequestInit) {
    return this.request<T>(`/cloud/equity-screener/${path}`, init);
  }

  getMemberFunds() {
    return this.request<import("./members").MemberFundsPayload>("/cloud/members");
  }

  getFundMembers(fund: string) {
    return this.request<import("./members").FundMembersPayload>(`/cloud/members/${encodeURIComponent(fund)}`);
  }

  /** A company's recent announcements on its exchange (ASX only); another exchange answers 404. */
  getCloudExchangeAnnouncements(params: { symbol: string; exchange: string; limit?: number }) {
    return this.request<import("./exchange-announcements").ExchangeAnnouncementsPayload>(
      cloudExchangeAnnouncementsPath(params),
    );
  }

  /** A US-listed fund's fee, NAV, premium and net assets as its sponsor publishes them. */
  getFundFacts(ticker: string, options: { signal?: AbortSignal } = {}) {
    return this.request<import("./fund-facts").FundFactsPayload>(`/cloud/fund-facts/${encodeURIComponent(ticker)}`, options.signal ? { signal: options.signal } : undefined);
  }

  getFundBreadth(fund: string) {
    return this.request<import("./members").FundBreadthPayload>(`/cloud/members/${encodeURIComponent(fund)}/breadth`);
  }

  getFundChanges(fund: string) {
    return this.request<import("./members").FundChangesPayload>(`/cloud/members/${encodeURIComponent(fund)}/changes`);
  }

  getCloudThemes() {
    return this.request<import("./themes").ThemesPayload>("/cloud/themes");
  }

  getCloudThemeMembers(id: string) {
    return this.request<import("./themes").ThemeMembersPayload>(`/cloud/themes/${encodeURIComponent(id)}`);
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
    // A search the service could not run (its catalogue rate limited, say) is no answer, not an empty one.
    if (response.status === "retryable_error" || response.status === "fatal_error") {
      throw new ApiRequestError(response.reasonCode ?? "Cloud search failed", undefined, undefined, response.status);
    }
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

  async getCloudEarningsHistory(symbol: string, limit = 13): Promise<EarningsHistoryPayload> {
    const params = new URLSearchParams({ symbol, limit: String(limit) });
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
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudQuotePayload>>> {
    return this.postMarketBatch("/market/quotes/batch", targets, mode, options.signal);
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

  /** `session` is what Gainers and Losers are ranked by (see CloudMoverSession). */
  getMarketMovers(category: "day_gainers" | "day_losers" | "most_actives", count = 25, refresh = false, session?: CloudMoverSession): Promise<CloudMarketResponse<MarketMoversPayload>> {
    const params = new URLSearchParams({ category, count: String(count), mode: refresh ? "refresh" : "cache-first" });
    if (session && category !== "most_actives") params.set("session", session);
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

  /**
   * Gainers, losers and most active, or the pre-market, after-hours and gap
   * lists with a `side`. `session` is what Gainers and Losers are ranked by
   * (see CloudMoverSession).
   */
  async getCloudMarketScreener<Category extends CloudMarketScreenerCategory | CloudSessionMoversCategory>(
    category: Category,
    count = 25,
    mode: "cache-first" | "refresh" = "cache-first",
    side?: CloudSessionMoversSide,
    session?: CloudMoverSession,
  ): Promise<CloudMarketResponse<Category extends CloudSessionMoversCategory ? CloudSessionMoversPayload : CloudMarketScreenerPayload>> {
    const requestedCount = Number.isFinite(count) ? Math.round(count) : 25;
    const params = new URLSearchParams({
      category,
      count: String(Math.max(1, Math.min(50, requestedCount))),
      mode,
    });
    if (side && isSessionMoversCategory(category)) params.set("side", side);
    if (session && (category === "gainers" || category === "losers")) params.set("session", session);
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

  /** Where the issuer that held a US symbol trades now, or what the symbol's holder was called before. */
  async getCloudTickerChanges(
    symbol: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudMarketResponse<TickerChanges>> {
    return this.request<CloudMarketResponse<TickerChanges>>(
      `/market/ticker-changes?${new URLSearchParams({ symbol: symbol.trim().toUpperCase() })}`,
      options.signal ? { signal: options.signal } : undefined,
    );
  }

  /**
   * `getCloudTickerChanges` for several symbols in one request: by symbol as
   * asked, null for one with no change on record. A symbol the service could
   * not answer for is left out.
   */
  async getCloudTickerChangesBatch(
    symbols: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, TickerChanges | null>> {
    const response = await this.request<CloudMarketResponse<CloudBatchAnswer<"symbol", TickerChanges>>>(
      "/market/ticker-changes/batch",
      { method: "POST", body: JSON.stringify({ symbols }), ...options.signal ? { signal: options.signal } : {} },
    );
    return batchAnswers(response, "symbol");
  }

  /**
   * Several searches in one request, each answered as `searchInstruments`
   * answers it: by query as asked, a query the service could not search left out.
   */
  async searchInstrumentsBatch(
    queries: readonly string[],
    limit = 10,
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, InstrumentSearchResult[]>> {
    const response = await this.request<CloudMarketResponse<CloudBatchAnswer<"query", InstrumentSearchResult[]>>>(
      "/market/search/batch",
      { method: "POST", body: JSON.stringify({ queries, limit }), ...options.signal ? { signal: options.signal } : {} },
    );
    const answers = new Map<string, InstrumentSearchResult[]>();
    for (const [query, rows] of batchAnswers(response, "query")) answers.set(query, rows ?? []);
    return answers;
  }

  /** Every listing of the company a listing belongs to (RCI and RCI.B:TSX are Rogers); empty for one the service does not hold. */
  async getCloudIssuerListings(
    symbol: string,
    exchange = "",
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudMarketResponse<IssuerListings>> {
    const params = new URLSearchParams({ symbol: symbol.trim().toUpperCase() });
    if (exchange.trim()) params.set("exchange", exchange.trim().toUpperCase());
    return this.request<CloudMarketResponse<IssuerListings>>(
      `/market/issuer-listings?${params}`,
      options.signal ? { signal: options.signal } : undefined,
    );
  }

  /** The listed company each organization name resolves to, if any: a trial's lead sponsors, a page at a time. */
  async getCloudOrganizationTickers(names: readonly string[], signal?: AbortSignal): Promise<OrganizationTickersResponse> {
    return this.request<OrganizationTickersResponse>("/market/organization-tickers", {
      method: "POST",
      body: JSON.stringify({ names }),
      signal,
    });
  }

  async getCloudHistory(
    symbol: string,
    exchange: string,
    params: CloudHistoryParams = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudMarketResponse<CloudPricePointPayload[]>> {
    return this.request<CloudMarketResponse<CloudPricePointPayload[]>>(
      cloudHistoryPath(symbol, exchange, params),
      options.signal ? { signal: options.signal } : undefined,
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

  /** The calendar from a UTC day, past events included, and the first day the stored calendar holds. */
  async getCloudEconomicCalendarFrom(from: string): Promise<{ events: CloudEconEventPayload[]; storedFrom: string | null }> {
    return this.request<{ events: CloudEconEventPayload[]; storedFrom: string | null }>(`/cloud/econ/calendar/history?from=${encodeURIComponent(from)}`);
  }

  /** Each currency's short rate and its day, for forwards implied by covered interest parity. */
  async getCloudShortRates(): Promise<CloudShortRatesPayload> {
    return this.request<CloudShortRatesPayload>("/cloud/econ/short-rates");
  }

  async getCloudMacroReleaseDays(): Promise<CloudMacroReleaseDaysPayload> {
    return this.request<CloudMacroReleaseDaysPayload>("/cloud/econ/release-days");
  }

  async getCloudFredSeries(
    seriesId: string,
    params: CloudFredSeriesParams = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudFredSeriesPayload> {
    return this.request<CloudFredSeriesPayload>(
      cloudFredSeriesPath(seriesId, params),
      options.signal ? { signal: options.signal } : undefined,
    );
  }

  /** Every series `getCloudFredSeries` serves. A server older than the list answers 404. */
  async getCloudFredSeriesCatalog(): Promise<CloudFredSeriesCatalogPayload> {
    return this.request<CloudFredSeriesCatalogPayload>("/cloud/econ/series");
  }

  async getCloudShiller(): Promise<CloudShillerPayload> {
    return this.request<CloudShillerPayload>(cloudShillerPath());
  }

  /** Futures-only positions unless `positions` asks for futures and options combined; the default request is unchanged. */
  async getCloudCotBoard(report: CotFamily, traderClass: CotClass, positions: CotPositions = "futures-only"): Promise<CotBoardPayload> {
    const query = new URLSearchParams({ report, traderClass, ...(positions === "combined" ? { scope: positions } : {}) });
    return this.request<CotBoardPayload>(`/cloud/cot/board?${query}`);
  }

  async getCloudCotContract(code: string, report: CotFamily, positions: CotPositions = "futures-only"): Promise<CotContractPayload> {
    const query = new URLSearchParams({ report, ...(positions === "combined" ? { scope: positions } : {}) });
    return this.request<CotContractPayload>(`/cloud/cot/contracts/${encodeURIComponent(code)}?${query}`);
  }

  /** Geo layers (the map's layers, entities and series); one prefix-scoped method, like EQS. */
  geo<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(`/cloud/geo/${path}`, init);
  }

  /** Credit-document paths stay with their pane; keep the shared client small. */
  creditDocuments<T>(path: string): Promise<T> {
    return this.request<T>(`/cloud/credit-documents/${path}`);
  }

  async getCloudHiring(symbol?: string, query: { limit?: number; offset?: number } = {}, signal?: AbortSignal): Promise<HiringBoard | HiringPayload> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100), offset: String(query.offset ?? 0) });
    return this.request<HiringBoard | HiringPayload>(symbol ? `/cloud/hiring/${encodeURIComponent(symbol)}` : `/cloud/hiring?${params}`, { signal });
  }

  /** HIRE's moves: the board of the latest computed week, or one company's weeks. */
  async getCloudHiringMoves(symbol?: string, query: { limit?: number; offset?: number; signal?: HiringMovesFilter } = {}, signal?: AbortSignal): Promise<HiringMovesBoard | HiringCompanyMoves> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100), offset: String(query.offset ?? 0), signal: query.signal ?? "moves" });
    return this.request<HiringMovesBoard | HiringCompanyMoves>(symbol ? `/cloud/hiring/moves/${encodeURIComponent(symbol)}` : `/cloud/hiring/moves?${params}`, { signal });
  }

  /** HIRE's Expansion or Anomalies board of the latest computed week. */
  async getCloudHiringSignals(group: HiringSignalGroup, query: { limit?: number; offset?: number; kind?: HiringSignalsFilter } = {}, signal?: AbortSignal): Promise<HiringSignalsBoard> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100), offset: String(query.offset ?? 0), kind: query.kind ?? "all" });
    return this.request<HiringSignalsBoard>(`/cloud/hiring/signals/${group}?${params}`, { signal });
  }

  /** One company's expansion and anomaly signals, both groups. */
  async getCloudHiringCompanySignals(symbol: string, signal?: AbortSignal): Promise<HiringCompanySignals> {
    return this.request<HiringCompanySignals>(`/cloud/hiring/signals/company/${encodeURIComponent(symbol)}`, { signal });
  }

  /** HIRE's Building board: role-family and theme shifts of the latest computed week. */
  async getCloudHiringBuilding(query: { limit?: number; offset?: number; dimension?: HiringBuildingFilter } = {}, signal?: AbortSignal): Promise<HiringBuildingBoard> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100), offset: String(query.offset ?? 0), dimension: query.dimension ?? "all" });
    return this.request<HiringBuildingBoard>(`/cloud/hiring/building?${params}`, { signal });
  }

  /** One company's mix by role family and theme, and its shifts. */
  async getCloudHiringCompanyBuilding(symbol: string, signal?: AbortSignal): Promise<HiringCompanyBuilding> {
    return this.request<HiringCompanyBuilding>(`/cloud/hiring/building/${encodeURIComponent(symbol)}`, { signal });
  }

  async getCloudAppRankHistory(store: "app-store" | "google-play", appId: string, query: AppAttentionFilter = {}, signal?: AbortSignal): Promise<AppRankPayload> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<AppRankPayload>(`/cloud/app-attention/app/${store}/${encodeURIComponent(appId)}?${params}`, { signal });
  }

  async getCloudAppAttention(query: AppAttentionFilter = {}, signal?: AbortSignal): Promise<AppAttentionPayload> {
    const { symbol, ...filters } = query;
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<AppAttentionPayload>(`/cloud/app-attention/${symbol ? encodeURIComponent(symbol) : "board"}?${params}`, { signal });
  }

  async getCloudCatalysts(query: CatalystFilters = {}, signal?: AbortSignal): Promise<CatalystResponse> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const route = query.litigation && query.symbol ? `/cloud/catalysts/litigation/${encodeURIComponent(query.symbol)}` : "/cloud/catalysts";
    return this.request<CatalystResponse>(`${route}?${params}`, { signal });
  }

  async getCloudCatalystChanges(query: { since: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<CatalystChanges> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<CatalystChanges>(`/cloud/catalysts/changes?${params}`, { signal });
  }

  async getCloudCatalystEvent(id: string, signal?: AbortSignal, query: { offset?: number; limit?: number } = {}): Promise<CatalystDetail> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<CatalystDetail>(`/cloud/catalysts/events/${encodeURIComponent(id)}?${params}`, { signal });
  }

  async getCloudCatalystStatus(): Promise<CatalystStatus> {
    return this.request<CatalystStatus>("/cloud/catalysts/status");
  }

  /** `listing` names a listing abroad's venue and company; a US listing needs neither. */
  async getCloudCompanyKpis(symbol: string, options: KpiQueryOptions = {}, listing: IssuerListingParams = {}, request?: { signal?: AbortSignal }): Promise<KpisPayload> {
    return this.request<KpisPayload>(companyDisclosurePath("kpis", symbol, options, listing), request);
  }

  async getCloudCompanyGuidance(symbol: string, options: KpiQueryOptions = {}, listing: IssuerListingParams = {}, request?: { signal?: AbortSignal }): Promise<GuidancePayload> {
    return this.request<GuidancePayload>(companyDisclosurePath("guidance", symbol, options, listing), request);
  }
  async getCloudPerpsBoard(query: PerpBoardQuery = {}): Promise<PerpBoardPayload> {
    return this.request(`/cloud/perps/board?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`);
  }
  async getCloudPerpsHistory(query: PerpHistoryQuery): Promise<PerpHistoryPayload> {
    return this.request(`/cloud/perps/history?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`);
  }
  async getCloudPerpsRankings(): Promise<PerpRankingsPayload> { return this.request("/cloud/perps/rankings"); }
  async getCloudPerpsCompare(baseAsset: string): Promise<PerpBoardPayload> { return this.request(`/cloud/perps/compare?${new URLSearchParams({ baseAsset })}`); }
  async getCloudPerpsLiquidations(baseAsset: string): Promise<PerpLiquidationsPayload> { return this.request(`/cloud/perps/liquidations?${new URLSearchParams({ baseAsset })}`); }
  async getCloudPerpsDepth(baseAsset: string): Promise<PerpDepthPayload> { return this.request(`/cloud/perps/depth?${new URLSearchParams({ baseAsset })}`); }
  async getCloudPerpsEquity(symbol: string, exchange?: string): Promise<PerpBoardPayload> {
    const query = exchange === undefined ? "" : `?${new URLSearchParams({ identity: "listing", exchange })}`;
    return this.request(`/cloud/perps/equity/${encodeURIComponent(symbol)}${query}`);
  }
  async getCloudPerpsEquities(listings: readonly PerpEquityListing[]): Promise<PerpEquitiesPayload> {
    return this.request("/cloud/perps/equities", { method: "POST", body: JSON.stringify({ listings }) });
  }
  async getCloudPerpsMarket(marketId: string): Promise<PerpMarketPayload> { return this.request(`/cloud/perps/market?${new URLSearchParams({ marketId })}`); }

  async analyzeCloudExposure(request: ExposureRequest): Promise<ExposurePayload> {
    return this.request<ExposurePayload>("/cloud/exposure/analyze", { method: "POST", body: JSON.stringify(request) });
  }

  async getCloudExposureScenarios(): Promise<{ scenarios: ExposureScenario[] }> {
    return this.request<{ scenarios: ExposureScenario[] }>("/cloud/exposure/scenarios");
  }

  async getCloudSupplyChain(symbol: string, options: SupplyOptions = {}): Promise<SupplyChainPayload> {
    const query = new URLSearchParams();
    if (options.tiers?.length) query.set("tiers", options.tiers.join(","));
    if (options.includeLeads) query.set("includeLeads", "1");
    return this.request<SupplyChainPayload>(`/cloud/supply-chain/${encodeURIComponent(symbol)}${query.size ? `?${query}` : ""}`);
  }

  getCloudAwards(query: AwardFilter = {}, signal?: AbortSignal): Promise<AwardsPayload> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null).map(([key, value]) => [key, `${value}`]));
    return this.request<AwardsPayload>(`/cloud/awards?${params}`, { signal });
  }

  getCloudAward(id: string, signal?: AbortSignal, revisionsCursor?: string): Promise<AwardDetailPayload> {
    const query = revisionsCursor ? `?${new URLSearchParams({ revisionsCursor })}` : "";
    return this.request<AwardDetailPayload>(`/cloud/awards/detail/${encodeURIComponent(id)}${query}`, { signal });
  }

  async getCloudSupplyGraph(symbol: string, options: Partial<GraphOptions> = {}): Promise<GraphPayload> {
    return this.request<GraphPayload>(`/cloud/supply-chain/${encodeURIComponent(symbol)}/graph?${supplyGraphQuery(options)}`);
  }

  async getCloudSupplyPaths(from: string, to: string, options: Partial<GraphOptions> = {}): Promise<GraphPayload> {
    return this.request<GraphPayload>(`/cloud/supply-chain/paths?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&${supplyGraphQuery(options)}`);
  }

  async getCloudDoeBoard(): Promise<DoeBoardPayload> {
    return this.request<DoeBoardPayload>("/cloud/doe/board");
  }

  async getCloudDoePrices(): Promise<DoePricesPayload> {
    return this.request<DoePricesPayload>("/cloud/doe/prices");
  }

  getCloudJodiBoard(signal?: AbortSignal): Promise<JodiBoardPayload> {
    return this.request<JodiBoardPayload>("/cloud/jodi/board", { signal });
  }

  getCloudPsdBoard(signal?: AbortSignal): Promise<PsdBoardPayload> {
    return this.request<PsdBoardPayload>("/cloud/psd/board", { signal });
  }

  async getCloudAttention(window: AttentionWindow = "now", symbol?: string): Promise<AttentionPayload> {
    const path = symbol ? `/cloud/attention/${encodeURIComponent(symbol)}` : "/cloud/attention";
    return this.request<AttentionPayload>(`${path}?window=${window}`);
  }

  async getCloudPowerBoard(query: PowerFilter = {}, signal?: AbortSignal): Promise<PowerBoard> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<PowerBoard>(`/cloud/power/board?${params}`, { signal });
  }

  async getCloudPowerHistory(query: PowerFilter = {}): Promise<PowerHistory> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<PowerHistory>(`/cloud/power/history?${params}`);
  }

  async getCloudPowerProject(id: string, query: Pick<PowerFilter, "offset" | "limit"> = {}, signal?: AbortSignal): Promise<PowerDetail> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request<PowerDetail>(`/cloud/power/projects/${encodeURIComponent(id)}?${params}`, { signal });
  }

  /** European day-ahead power prices by country, latest day first per market. */
  async getCloudEuropePower(): Promise<EuropePowerBoard> {
    return this.request<EuropePowerBoard>("/cloud/europe-energy/power", { signal: AbortSignal.timeout(30_000) });
  }

  /** One market's daily day-ahead prices from `from` (all of them without one), oldest first. */
  async getCloudEuropePowerHistory(code: string, from?: string | null): Promise<EuropePowerHistory> {
    const query = from ? `?${new URLSearchParams({ from })}` : "";
    return this.request<EuropePowerHistory>(
      `/cloud/europe-energy/power/${encodeURIComponent(code)}/history${query}`,
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  /** The EU carbon allowance (EUA) auction price as of its latest auction day, with the latest auctions. */
  async getCloudEuropeCarbon(): Promise<CarbonBoard> {
    return this.request<CarbonBoard>("/cloud/europe-energy/carbon", { signal: AbortSignal.timeout(30_000) });
  }

  /** The daily EUA auction price from `from` (every auction day since 2020 without one), oldest first. */
  async getCloudEuropeCarbonHistory(from?: string | null): Promise<CarbonHistory> {
    const query = from ? `?${new URLSearchParams({ from })}` : "";
    return this.request<CarbonHistory>(`/cloud/europe-energy/carbon/history${query}`, { signal: AbortSignal.timeout(30_000) });
  }

  /** European gas storage: the EU aggregate and each member state as of its latest gas day. */
  async getCloudEuropeGas(): Promise<GasStorageBoard> {
    return this.request<GasStorageBoard>("/cloud/europe-energy/gas", { signal: AbortSignal.timeout(30_000) });
  }

  /** One area's gas days from `from` (all kept without one), oldest first. */
  async getCloudEuropeGasHistory(code: string, from?: string | null): Promise<GasStorageHistory> {
    const query = from ? `?${new URLSearchParams({ from })}` : "";
    return this.request<GasStorageHistory>(
      `/cloud/europe-energy/gas/${encodeURIComponent(code)}/history${query}`,
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  /** One area's latest year against last year and its five-year range, day by day. */
  async getCloudEuropeGasSeasonal(code: string): Promise<GasStorageSeasonal> {
    return this.request<GasStorageSeasonal>(`/cloud/europe-energy/gas/${encodeURIComponent(code)}/seasonal`, { signal: AbortSignal.timeout(30_000) });
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

  /** The latest tape, or with a `range` that window of the session, read forward from its start. */
  async getCloudTape(symbol: string, exchange: string, signal?: AbortSignal, range?: TapeRange): Promise<TapeSnapshot> {
    const window = range ? `&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : "";
    return this.request<TapeSnapshot>(`/cloud/tape/${encodeURIComponent(symbol)}?exchange=${encodeURIComponent(exchange)}${window}`, { signal: signalWithTimeout(signal, 30_000) });
  }

  async getCloudYieldCurve(): Promise<CloudYieldPointPayload[]> {
    return this.request<CloudYieldPointPayload[]>("/cloud/econ/yield-curve");
  }

  /** Daily USD SOFR swap estimates, comparisons and the selected tenor's history. */
  async getCloudSwapCurve(tenor: SwapTenor = "10Y", days = 365): Promise<SwapCurvePayload> {
    const query = new URLSearchParams({ tenor, days: String(days) });
    return this.request<SwapCurvePayload>(`/cloud/econ/swap-curve?${query}`, { signal: AbortSignal.timeout(30_000) });
  }

  /** A curve's session on or before `date` (latest without one), with look-backs and spreads. */
  async getCloudCurve(curve: CloudCurveId, date?: string | null): Promise<CloudCurveView> {
    const query = date ? `?${new URLSearchParams({ date })}` : "";
    return this.request<CloudCurveView>(`/cloud/econ/curves/${encodeURIComponent(curve)}${query}`, { signal: AbortSignal.timeout(30_000) });
  }

  /** One tenor of a curve from `from` (all stored sessions without one), oldest first. */
  async getCloudCurveHistory(curve: CloudCurveId, tenor: string, from?: string | null): Promise<CloudCurveHistory> {
    const query = new URLSearchParams({ tenor, ...(from ? { from } : {}) });
    return this.request<CloudCurveHistory>(
      `/cloud/econ/curves/${encodeURIComponent(curve)}/history?${query}`,
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  /** Each market's latest curve and the session before, each on its own date. */
  async getCloudWorldCurves(): Promise<CloudWorldCurves> {
    return this.request<CloudWorldCurves>("/cloud/econ/curves", { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudCryptoMarkets(): Promise<CryptoMarketsPayload> {
    return this.request<CryptoMarketsPayload>("/cloud/crypto/markets", { signal: AbortSignal.timeout(45_000) });
  }

  /** Total stablecoin supply and the largest coins', daily, with 7D and 30D changes and shares. */
  async getCloudStablecoinSupply(): Promise<StablecoinSupplyPayload> {
    return this.request<StablecoinSupplyPayload>("/cloud/crypto/stablecoins/supply", { signal: AbortSignal.timeout(30_000) });
  }

  /** One listed stablecoin's daily supply, by symbol. */
  async getCloudStablecoinSupplyHistory(symbol: string): Promise<StablecoinSupplyHistoryPayload> {
    return this.request<StablecoinSupplyHistoryPayload>(
      `/cloud/crypto/stablecoins/supply/${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  /** Total DeFi TVL, the largest protocols and chains with 7D and 30D changes, and the total's daily history. */
  async getCloudDefiTvl(): Promise<DefiTvlPayload> {
    return this.request<DefiTvlPayload>("/cloud/crypto/defi/tvl", { signal: AbortSignal.timeout(30_000) });
  }

  /** Daily net flows of the US spot bitcoin or ether ETFs, per fund, in US$ millions. */
  async getCloudCryptoEtfFlows(asset: CryptoEtfFlowAsset): Promise<CryptoEtfFlowsPayload> {
    return this.request<CryptoEtfFlowsPayload>(
      `/cloud/crypto/etf-flows?asset=${asset.toLowerCase()}`,
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  async getCloudCentralBankRates(): Promise<CentralBankRatesPayload> {
    return this.request<CentralBankRatesPayload>("/cloud/econ/central-bank-rates", { signal: AbortSignal.timeout(45_000) });
  }

  /** A live scan's matches against Gloom Cloud's newest market-wide snapshot for this account's tier. */
  getLiveScan(definition: LiveScanWireDefinition, signal?: AbortSignal) {
    return this.request<LiveScanPayload>(LIVE_SCAN_PATH, {
      method: "POST",
      body: JSON.stringify({ scan: definition }),
      signal: signalWithTimeout(signal, 20_000),
    });
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

  async getCloudDebtMaturities(symbol: string, listing?: IssuerListingParams): Promise<DebtMaturitiesPayload> {
    return this.request<DebtMaturitiesPayload>(cloudDebtMaturitiesPath(symbol, listing), { signal: AbortSignal.timeout(45_000) });
  }

  async getCloudBankFigures(symbol: string): Promise<BankFiguresPayload> {
    return this.request<BankFiguresPayload>(cloudBankFiguresPath(symbol), { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudRevenueBreakdown(symbol: string, view?: RevenueBreakdownView, listing?: IssuerListingParams): Promise<RevenueBreakdownPayload> {
    return this.request<RevenueBreakdownPayload>(cloudRevenueBreakdownPath(symbol, view, listing), { signal: AbortSignal.timeout(30_000) });
  }

  async getCloudMnaDeals(params: MnaDealsParams = {}, options?: { signal?: AbortSignal }): Promise<MnaDealsPayload> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const text = query.toString();
    const suffix = text ? `?${text}` : "";
    return this.request<MnaDealsPayload>(`/cloud/mna/deals${suffix}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getCloudMnaDeal(id: string, options?: { signal?: AbortSignal }): Promise<MnaDealPayload> {
    return this.request<MnaDealPayload>(`/cloud/mna/deals/${encodeURIComponent(id)}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  // Public records about companies in difficulty. The answers are unchecked
  // JSON: the distress tab's parsers validate them before anything is drawn.
  async getPublicDistressFilings(params: DistressFilingsParams, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request<unknown>(`/public/events${distressQuery(params)}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getPublicGoingConcern(params: GoingConcernParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request<unknown>(`/public/going-concern${distressQuery(params)}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getPublicDistressDesignations(params: DistressDesignationsParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request<unknown>(`/public/distress-designations${distressQuery(params)}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getPublicInsolvencyNotices(params: InsolvencyNoticesParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request<unknown>(`/public/insolvency-notices${distressQuery(params)}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getPublicLetters(params: LettersParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    const { kinds, ...rest } = params;
    const query = distressQuery({ kind: kinds?.length ? kinds.join(",") : undefined, ...rest });
    return this.request<unknown>(`/public/letters${query}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getCloudIpoCalendar(params: IpoCalendarParams = {}, options?: { signal?: AbortSignal }): Promise<IpoCalendarPayload> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const text = query.toString();
    const suffix = text ? `?${text}` : "";
    return this.request<IpoCalendarPayload>(`/cloud/ipo/calendar${suffix}`, { signal: signalWithTimeout(options?.signal, 30_000) });
  }

  async getCloudFailsToDeliver(symbol: string): Promise<FailsToDeliverPayload> {
    return this.request<FailsToDeliverPayload>(`/cloud/fails-to-deliver?${new URLSearchParams({ symbol })}`, { signal: AbortSignal.timeout(20_000) });
  }

  async getCloudOtcVolume(symbol: string): Promise<OtcVolumePayload> {
    return this.request<OtcVolumePayload>(`/cloud/otc-volume?${new URLSearchParams({ symbol })}`, { signal: AbortSignal.timeout(20_000) });
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

  /** What a futures symbol (GC=F, GCZ26, CL1) trades: its contract, terms and latest confirmed settlement. */
  async getCloudFuturesContract(symbol: string): Promise<FuturesContractTermsPayload> {
    return this.request<FuturesContractTermsPayload>(`/cloud/futures/contract/${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(20_000) });
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

  /** Every listed issuer's latest 5Y level in one request. */
  async getCloudCdsLevels(): Promise<CloudCdsLevelsResponse> {
    return this.request<CloudCdsLevelsResponse>("/cloud/credit/cds/levels", { signal: AbortSignal.timeout(30_000) });
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

  async getCloudJobsPosting(ticker: string, posting: { id: number } | { externalId: string }): Promise<CloudJobsPostingDetail> {
    return this.request<CloudJobsPostingDetail>(cloudJobsPostingPath(ticker, posting));
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

  async getCloudEarningsCallAudio(
    id: string,
  ): Promise<CloudEarningsCallAudioPayload> {
    return this.request<CloudEarningsCallAudioPayload>(
      cloudEarningsCallAudioPath(id),
    );
  }

  // A listing outside the US also sends its venue and company (listingAbroad).
  async getProxyStatements(
    ticker: string,
    listing?: IssuerListingParams,
  ): Promise<CloudProxyStatementListPayload> {
    return this.request<CloudProxyStatementListPayload>(
      cloudProxyStatementsPath(ticker, listing),
    );
  }

  async getProxyStatement(
    ticker: string,
    year: number,
    listing?: IssuerListingParams,
  ): Promise<CloudProxyStatementPayload> {
    return this.request<CloudProxyStatementPayload>(
      cloudProxyStatementPath(ticker, year, listing),
    );
  }

  async getFilingEvents(
    ticker: string,
    limit?: number,
    listing?: IssuerListingParams,
  ): Promise<{ ticker: string; events: CloudFilingEventPayload[] }> {
    return this.request<{ ticker: string; events: CloudFilingEventPayload[] }>(
      cloudFilingEventsPath(ticker, limit, listing),
    );
  }

  async getRiskReports(ticker: string, listing?: IssuerListingParams): Promise<CloudRiskReportListPayload> {
    return this.request<CloudRiskReportListPayload>(
      cloudRiskReportsPath(ticker, listing),
    );
  }

  async getRiskReport(
    ticker: string,
    year: number,
    listing?: IssuerListingParams,
  ): Promise<CloudRiskReportPayload> {
    return this.request<CloudRiskReportPayload>(
      cloudRiskReportPath(ticker, year, listing),
    );
  }

  async getCloudSecFilings(
    params: CloudSecFilingsParams,
    options?: { signal?: AbortSignal },
  ): Promise<CloudSecFilingsResponse> {
    return this.request<CloudSecFilingsResponse>(cloudSecFilingsPath(params), options);
  }

  /** Schedule 13D/13G reports about an issuer. Unknown tickers answer 404; no reports is an empty `owners`. */
  async getCloudSecBeneficialOwners(
    params: CloudBeneficialOwnersParams,
    options?: { signal?: AbortSignal },
  ): Promise<BeneficialOwnersPayload> {
    return this.request<BeneficialOwnersPayload>(cloudSecBeneficialOwnersPath(params), {
      signal: options?.signal,
    });
  }

  async getCloudSecInsiderSignals(
    params: CloudInsiderSignalsParams = {},
    options?: { signal?: AbortSignal },
  ): Promise<InsiderSignalsPayload> {
    return this.request<InsiderSignalsPayload>(cloudSecInsiderSignalsPath(params), {
      signal: options?.signal,
    });
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
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    return this.request<unknown>(cloudSec13FPath(path, params), {
      signal: options?.signal,
    });
  }

  /**
   * Cross-document full-text search, open to every signed-in account; signed
   * out it answers 401. Only alerts on a saved search need Pro.
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

  async searchCloudNews(
    query: string,
    limit?: number,
    topics?: readonly string[],
  ): Promise<CloudNewsListResponse> {
    return this.request<CloudNewsListResponse>(cloudNewsSearchPath(query, limit, topics));
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
