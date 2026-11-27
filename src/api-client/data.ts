import type { JpxShortPositions } from "./jpx-short-positions";
import type { SgxShortSales, KoreanShortPositions, KoreanVenue, MainlandLendingBalances, MainlandVenue, TaiwanShortBalances, TaiwanVenue } from "./exchange-short-balances";
import type { SfcShortPositions } from "./sfc-short-positions";
import type { BuybacksPayload } from "./buybacks";
import type {
  HkCcassBigChangesPayload,
  HkCcassConcentrationPayload,
  HkCcassParticipantPortfolioPayload,
  HkCcassSouthboundPayload,
  HkCcassStockPayload,
} from "./hk-ccass";
import {
  cloudDilutionCompanyPath,
  cloudDilutionForm144Path,
  cloudDilutionShelvesPath,
  type DilutionCompanyPayload,
  type DilutionForm144FeedPayload,
  type DilutionShelvesFeedPayload,
} from "./dilution";
import {
  cloudTaiwanStockRevenuePath,
  cloudTaiwanUsReadthroughPath,
  type TaiwanStockRevenuePayload,
  type TaiwanUsReadthroughPayload,
} from "./taiwan-revenue";
import {
  cloudHkCbbcOverviewPath,
  cloudHkCbbcUnderlyingPath,
  type HkCbbcOverviewPayload,
  type HkCbbcUnderlyingPayload,
} from "./hk-cbbc";
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
import type { SupplyChainPayload, SupplyOptions, SupplyRead } from "./supply-chain";
import { createReadCoalescer } from "./coalesce";
import { supplyGraphQuery, type GraphOptions, type GraphPayload } from "./supply-chain-graph";
import type { AwardDetailPayload, AwardFilter, AwardsPayload } from "./awards";
import type { EarningsEvent } from "../types/data-provider";
import type { MarketDividendsPayload, MarketHeatmapResult, MarketHeatmapUniverseId, MarketMoversPayload } from "./market-discovery";
import type { BankFiguresPayload } from "./bank-figures";
import type { DebtMaturitiesPayload } from "./debt-maturities";
import type { IssuerBondIssuesPayload, StoredBondPayload, StoredIssuerBondsPayload } from "./bond-trades";
import type { RevenueBreakdownPayload, RevenueBreakdownView } from "./revenue-breakdown";
import type { MnaDealPayload, MnaDealsParams, MnaDealsPayload } from "./mna";
import type {
  DistressDesignationsParams,
  DistressFilingsParams,
  GoingConcernParams,
  InsolvencyNoticesParams,
} from "./distress";
import type { LettersParams } from "./letters";
import type { IpoCalendarParams, IpoCalendarPayload } from "./ipo";
import type { TickerChanges } from "../types/ticker-changes";
import type { SplitHistory } from "../types/financials";
import type { IssuerListings } from "../types/issuer-listings";
import type { OrganizationTickersResponse } from "./organization-tickers";
import type { BitcoinNetworkPayload, CryptoMarketsPayload, DefiTvlPayload, StablecoinSupplyHistoryPayload, StablecoinSupplyPayload } from "./crypto-markets";
import type { CryptoEtfFlowAsset, CryptoEtfFlowsPayload } from "./crypto-etf-flows";
import type { CentralBankRatesPayload } from "./central-bank-rates";
import type { FxInterventionsPayload } from "./fx-interventions";
import type { HkTendersPayload } from "./hk-tenders";
import type { EstimateRevisionsPayload } from "./estimate-revisions";
import type { HongKongMoneyMarketsPayload, MoneyMarketsPayload } from "./money-markets";
import type { CloudCurveHistory, CloudCurveId, CloudCurveView, CloudWorldCurves } from "./yield-curves";
import type { SwapCurvePayload, SwapTenor } from "./swap-curve";
import type { CdxBoardPayload, CloudCreditBoardParams, SovrBoardPayload } from "./credit-boards";
import type { ShortVolumePayload, ShortVolumeScope } from "./short-volume";
import type { FailsToDeliverPayload, OtcVolumePayload } from "./short-side-publications";
import type { BeneficialOwnersPayload, CloudBeneficialOwnersParams } from "./beneficial-owners";
import type { CloudInsiderSignalsParams, InsiderSignalsPayload } from "./insider-signals";
import type { CloudSocialOutliersParams, SocialMentionDayPosts, SocialMentionsPayload, SocialMentionsRange, SocialOutliersPayload } from "./social-mentions";
import type { FuturesContractTermsPayload, FuturesCurveAsOfPayload, FuturesCurvePayload } from "./futures-curve";
import type { CotBoardPayload, CotContractPayload, CotFamily, CotClass, CotPositions } from "./cot";
import type { DoeBoardPayload, DoePricesPayload } from "./doe";
import type { JodiBoardPayload, PsdBoardPayload } from "./commodity-balances";
import type { CarbonBoard, CarbonHistory, EuropePowerBoard, EuropePowerHistory, GasStorageBoard, GasStorageHistory, GasStorageSeasonal } from "./europe-energy";
import type { GpuBoardPayload, GpuEventsPayload, GpuHistoryPayload, GpuHistoryQuery } from "./gpu";
import type { CpiBoardPayload } from "./cpi";
import type { TapeRange, TapeSnapshot } from "./tape";
import { LIVE_SCAN_PATH, type LiveScanPayload, type LiveScanWireDefinition } from "./live-scan";
import { abortable, signalWithTimeout, withDeadline } from "../utils/async-deadline";
import { ApiRequestError, isRetryableApiError, markAskedTwice } from "./errors";
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
  queryPath,
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
  CloudEconCalendarFromPayload,
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
  CloudInsiderFilingStoriesResponse,
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
  ScannerFlowSession,
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

/** How long a listing read waits before asking again after the service said its source failed. */
const LISTING_RETRY_DELAY_MS = 400;
/**
 * A company never looked at is searched while it is asked about, for a few
 * seconds at most (the search goes on and the list says pending): a list
 * that has not come in this long is a failure the pane says, not a minute's wait.
 */
const EARNINGS_CALLS_LIST_TIMEOUT_MS = 20_000;

/**
 * How long the service's answer that it has no quote for a listing stands.
 * Resolving the symbol, quoting it and checking whether it stopped trading
 * each ask about a symbol nothing lists: one answer serves them all, so an
 * unknown symbol fails at once instead of after each asks the service again.
 */
const QUOTE_NOT_FOUND_MS = 60_000;
/** The most quote paths remembered as not found: a list of mistyped symbols must not grow the memory without end. */
const QUOTE_NOT_FOUND_ENTRIES = 256;

const isNotFound = (answer: { status?: string; reasonCode?: string } | null | undefined) =>
  answer?.status === "empty" && answer.reasonCode === "NOT_FOUND";

/**
 * Whether a failed listing read is asked again: the service answered that its
 * own source failed (`retryable_error`, or the catch-all `fatal_error`, with no
 * data), or failed with a 5xx or a timeout. A rate limit is never asked again,
 * whatever wait it names: asking again is more of what it refused. An answer of
 * no data, a refusal, and a request that never reached the service
 * (`DataServiceUnreachableError`) are not asked again either.
 */
function isListingReadRetried(outcome: { response: CloudMarketResponse<unknown> } | { error: unknown }): boolean {
  if ("response" in outcome) {
    const { status, data } = outcome.response ?? {};
    return (status === "retryable_error" || status === "fatal_error") && data == null;
  }
  return isRetryableApiError(outcome.error) && (outcome.error as ApiRequestError).status !== 429;
}

/**
 * `batch`: the caller asks many reads like this one in the same moment (a
 * board's rows), so the read may wait a few milliseconds to go out in a batch
 * request with them. Any other read goes out on its own at once.
 */
export interface BatchableRead {
  batch?: boolean;
}

const DAY_MS = 86_400_000;

/** A YYYY-MM-DD date `days` away as a UTC time, or null for any other form, which bounds nothing. */
function dayTime(date: string | undefined, days: number): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) ? time + days * DAY_MS : null;
}

/**
 * Whether every bar falls in the window asked, give or take the day a daily
 * bar's UTC time may stand from its session's date. A server from before
 * windowed batches answers its latest bars instead, which this tells apart.
 */
function withinWindow(points: readonly CloudPricePointPayload[] | null | undefined, startDate?: string, endDate?: string): boolean {
  if (!Array.isArray(points)) return true;
  const from = dayTime(startDate, -2);
  const before = dayTime(endDate, 2);
  return points.every((point) => {
    const time = Date.parse(point.date);
    return !Number.isFinite(time) || ((from == null || time >= from) && (before == null || time < before));
  });
}

const signalInit = (signal?: AbortSignal): RequestInit | undefined => (signal ? { signal } : undefined);
const timeoutInit = (ms: number, signal?: AbortSignal): RequestInit => ({
  signal: signal ? signalWithTimeout(signal, ms) : AbortSignal.timeout(ms),
});

/** What a service without windowed batches is taken to have answered: the route missing, so the reads go out alone until it is asked again. */
const WINDOWLESS_BATCH = "The history batch route does not read a window of dates";

export class CloudDataApi {
  constructor(
    private readonly request: CloudApiRequest,
    /** The wait before a failed listing read is asked again (`readListing`); tests set 0. */
    private readonly listingRetryDelayMs = LISTING_RETRY_DELAY_MS,
  ) {}

  /**
   * Histories asked with others (`batch`) in the same moment with the same
   * bars (a futures board's contracts, SOVR's currencies) go out as
   * `/market/history/batch` requests, each answered as its own
   * `/market/history` would be. Sixteen a request, sent side by side: a
   * board's seventy-two rows are five requests, and the first rows land as
   * soon as sixteen reads have.
   */
  private readonly histories = this.#historyCoalescer(false);

  /** Each quote path the service said it has no quote for, and when (`QUOTE_NOT_FOUND_MS`), oldest first, at most QUOTE_NOT_FOUND_ENTRIES. */
  private readonly quotesNotFound = new Map<string, number>();

  #rememberQuoteNotFound(path: string): void {
    this.quotesNotFound.delete(path);
    this.quotesNotFound.set(path, Date.now());
    for (const oldest of this.quotesNotFound.keys()) {
      if (this.quotesNotFound.size <= QUOTE_NOT_FOUND_ENTRIES) break;
      this.quotesNotFound.delete(oldest);
    }
  }

  #quoteNotFound(path: string): CloudMarketResponse<CloudQuotePayload> | null {
    const said = this.quotesNotFound.get(path);
    if (said == null) return null;
    if (Date.now() - said < QUOTE_NOT_FOUND_MS) return { status: "empty", reasonCode: "NOT_FOUND", data: null };
    this.quotesNotFound.delete(path);
    return null;
  }

  /**
   * The same over one window of dates (a portfolio's holdings over the risk
   * model's months or the stress episodes' years). A service from before
   * windowed batches answers its latest bars instead, or refuses the window:
   * that reads as the route missing, so the reads are asked on their own,
   * four at a time, until it is asked again. Until a windowed batch has been
   * answered, one read is asked as a batch of its own first (`windowProbe`),
   * so finding that out costs one listing's bars, not every batch's.
   */
  private readonly datedHistories = this.#historyCoalescer(true);
  /** The first windowed batch, of one read, that the others wait on; null until asked, and again after it found no windows. */
  private windowProbe: Promise<CloudMarketResponse<CloudPricePointPayload[]> | undefined> | null = null;
  /** Whether a windowed batch has come back over its window: the probe is not asked again. */
  private windowsAnswered = false;

  #historyCoalescer(dated: boolean) {
    return createReadCoalescer<
      { symbol: string; exchange: string; params: Pick<CloudHistoryParams, "interval" | "outputsize" | "rangeKey" | "startDate" | "endDate"> },
      CloudMarketResponse<CloudPricePointPayload[]>
    >({
      max: 16,
      // Reads asked alone after a refused batch stay within what the panes kept in flight before: SOVR four, the board twelve with its terms.
      fallbackConcurrency: 4,
      group: ({ params }) => [params.interval, params.outputsize, params.rangeKey, params.startDate, params.endDate].map((value) => value ?? "").join("|"),
      single: ({ symbol, exchange, params }) => this.request(cloudHistoryPath(symbol, exchange, params)),
      batch: (keys) => (dated ? this.#windowedBatch(keys) : this.#historyBatch(keys, false)),
    });
  }

  async #historyBatch(
    keys: Array<{ symbol: string; exchange: string; params: Pick<CloudHistoryParams, "interval" | "outputsize" | "rangeKey" | "startDate" | "endDate"> }>,
    dated: boolean,
  ): Promise<Array<CloudMarketResponse<CloudPricePointPayload[]> | undefined>> {
    const { interval, outputsize, rangeKey, startDate, endDate } = keys[0]!.params;
    // The server answers each target in the order asked, so a listing asked twice is asked once.
    const targetKey = ({ symbol, exchange }: { symbol: string; exchange: string }) => `${symbol}\u001f${exchange}`;
    const targets = [...new Map(keys.map((key) => [targetKey(key), { symbol: key.symbol, exchange: key.exchange }])).values()];
    const response = await this.request<CloudMarketResponse<{ items: Array<CloudMarketResponse<CloudPricePointPayload[]>> }>>("/market/history/batch", {
      method: "POST",
      body: JSON.stringify({
        targets,
        interval: interval ?? "1day",
        ...(outputsize != null ? { outputsize: String(outputsize) } : {}),
        ...(rangeKey ? { rangeKey } : {}),
        ...(dated && startDate ? { startDate } : {}),
        ...(dated && endDate ? { endDate } : {}),
      }),
    }).catch((error: unknown) => {
      // A service that does not take a window in a batch may refuse it as asked rather than answer its latest bars.
      if (dated && error instanceof ApiRequestError && (error.status === 400 || error.status === 422)) throw new ApiRequestError(WINDOWLESS_BATCH, 404);
      throw error;
    });
    const items = response.data?.items;
    // An answer that does not line up with the targets asked is not matched by place: each read is asked on its own.
    if (!Array.isArray(items) || items.length !== targets.length) return keys.map(() => undefined);
    if (dated && items.some((item) => !withinWindow(item.data, startDate, endDate))) throw new ApiRequestError(WINDOWLESS_BATCH, 404);
    const byTarget = new Map(targets.map((target, index) => [targetKey(target), items[index]]));
    return keys.map((key) => byTarget.get(targetKey(key)));
  }

  /**
   * A batch over a window, once a windowed batch has been answered; before
   * that, the first batch's first read goes out alone as the probe and every
   * batch waits on it. A probe answered with bars outside its window, or
   * refused, fails them all as the missing route; one answered with bars in it
   * lets them go, and its own read is not asked again.
   */
  async #windowedBatch(
    keys: Array<{ symbol: string; exchange: string; params: Pick<CloudHistoryParams, "interval" | "outputsize" | "rangeKey" | "startDate" | "endDate"> }>,
  ): Promise<Array<CloudMarketResponse<CloudPricePointPayload[]> | undefined>> {
    if (this.windowsAnswered) return this.#historyBatch(keys, true);
    const probing = !this.windowProbe;
    const probe = this.windowProbe ??= this.#historyBatch(keys.slice(0, 1), true).then(([item]) => {
      // An empty answer shows no window either way: the batches that follow are checked as they come.
      if (Array.isArray(item?.data) && item.data.length > 0) this.windowsAnswered = true;
      return item;
    });
    let probed: CloudMarketResponse<CloudPricePointPayload[]> | undefined;
    try {
      probed = await probe;
    } catch (error) {
      // Asked again once the route is, after the missing route's wait.
      if (this.windowProbe === probe) this.windowProbe = null;
      throw error;
    }
    if (!probing) return this.#historyBatch(keys, true);
    const rest = keys.length > 1 ? await this.#historyBatch(keys.slice(1), true) : [];
    return [probed, ...rest];
  }

  /**
   * Futures terms asked with others in the same moment (a futures board's rows) go out as
   * `/cloud/futures/contracts` requests, sixteen a request like the histories.
   * A symbol without known terms answers null there, which reads as the 404
   * its own request answers.
   */
  private readonly futuresTerms = createReadCoalescer<string, FuturesContractTermsPayload | null>({
    max: 16,
    // With the board's histories' four, the twelve reads it kept in flight before.
    fallbackConcurrency: 8,
    group: () => "",
    single: (symbol) => this.request<FuturesContractTermsPayload>(`/cloud/futures/contract/${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(20_000) }),
    batch: async (symbols) => {
      // The server answers each symbol once, by the symbol asked.
      const { items } = await this.getCloudFuturesContracts([...new Set(symbols)]);
      const bySymbol = new Map(items.map((item) => [item.symbol, item]));
      // A failed read is asked again on its own.
      return symbols.map((symbol) => bySymbol.get(symbol)?.error ? undefined : bySymbol.get(symbol)?.terms);
    },
  });

  /**
   * Expiries of one listing's chain asked with others in the same moment (a
   * volatility surface's) go out as `/market/options/batch` requests, each answered as
   * its own `/market/options` would be. Six a request, the server's one round,
   * sent side by side: a surface's eighteen expiries are three requests.
   */
  private readonly optionsChains = createReadCoalescer<
    { symbol: string; exchange?: string; expirationDate: number },
    CloudMarketResponse<CloudOptionsChainPayload>
  >({
    max: 6,
    fallbackConcurrency: 4,
    group: ({ symbol, exchange }) => `${symbol}|${exchange ?? ""}`,
    single: ({ symbol, exchange, expirationDate }) => this.request(cloudOptionsChainPath(symbol, exchange, expirationDate)),
    batch: async (keys) => {
      const { symbol, exchange } = keys[0]!;
      // The server answers each expiry once, naming it.
      const expiries = [...new Set(keys.map((key) => key.expirationDate))];
      const search = new URLSearchParams({ symbol, expirationDates: expiries.join(",") });
      if (exchange) search.set("exchange", exchange);
      const response = await this.request<CloudMarketResponse<{ items: Array<CloudMarketResponse<CloudOptionsChainPayload> & { expirationDate?: number }> }>>(
        `/market/options/batch?${search}`,
      );
      const byExpiry = new Map((response.data?.items ?? []).map(({ expirationDate, ...item }) => [expirationDate, item]));
      return keys.map((key) => byExpiry.get(key.expirationDate));
    },
  });

  /**
   * Whether reads of `kind` asked together go out in batch requests now:
   * false while the service answers that batch route 404, until it is asked
   * again. A caller limiting its reads in flight asks them all at once only
   * when they do.
   */
  batchesReads(kind: "history" | "options" | "futures-terms"): boolean {
    const coalescer = kind === "history" ? this.histories : kind === "options" ? this.optionsChains : this.futuresTerms;
    return coalescer.batching();
  }

  /**
   * A listing's quote, history or financials, asked again once when the
   * service failed to answer it (`isListingReadRetried`): its source blinks for a
   * few minutes at a time, and a known listing then read as one no source
   * covers. A caller's abort stops the second ask.
   */
  async #readListing<T>(read: () => Promise<CloudMarketResponse<T>>, signal?: AbortSignal): Promise<CloudMarketResponse<T>> {
    const first = await read().then((response) => ({ response }), (error: unknown) => ({ error }));
    const settle = () => {
      if ("error" in first) throw first.error;
      return first.response;
    };
    if (!isListingReadRetried(first) || signal?.aborted) return settle();
    if (this.listingRetryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.listingRetryDelayMs));
    if (signal?.aborted) return settle();
    const second = await read().then((response) => ({ response }), (error: unknown) => ({ error }));
    // Failing the same way twice, the service did not answer it (`markAskedTwice`).
    if (isListingReadRetried(second)) markAskedTwice("error" in second ? second.error : second.response);
    if ("error" in second) throw second.error;
    return second.response;
  }

  #requestMarketSymbol<T>(path: string, symbol: string, exchange?: string): Promise<CloudMarketResponse<T>> {
    return this.request<CloudMarketResponse<T>>(cloudMarketSymbolPath(path, symbol, exchange));
  }

  #postMarketBatch<T>(
    path: string,
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh",
    signal?: AbortSignal,
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<T>>> {
    return this.request<CloudMarketResponse<CloudMarketBatchPayload<T>>>(path, {
      method: "POST",
      body: JSON.stringify({ targets, mode }),
      ...signalInit(signal),
    });
  }

  async #postBatchAnswers<K extends string, T>(path: string, body: unknown, key: K, signal?: AbortSignal): Promise<Map<string, T | null>> {
    const response = await this.request<CloudMarketResponse<CloudBatchAnswer<K, T>>>(path, {
      method: "POST",
      body: JSON.stringify(body),
      ...signalInit(signal),
    });
    return batchAnswers(response, key);
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

  /** The ETFs whose latest holdings hold a stock. */
  getStockFunds(symbol: string) {
    return this.request<import("./members").StockFundsPayload>(`/cloud/members/holding/${encodeURIComponent(symbol)}`);
  }

  /** A company's recent announcements on its exchange (ASX and HKEX); another exchange answers 404. */
  getOwnershipDisclosures(listing: string, limit: number, signal?: AbortSignal) {
    return this.request<import("./ownership-disclosures").OwnershipDisclosures>(
      `/cloud/ownership-disclosures/${encodeURIComponent(listing)}?limit=${limit}`, signal ? { signal } : undefined,
    );
  }

  /** Hong Kong CCASS custody holdings, bucketed flows and daily deltas for an HK code or linked ADR. */
  getHkCcassStock(code: string, options: { from?: string; date?: string; limit?: number; signal?: AbortSignal } = {}) {
    return this.request<HkCcassStockPayload>(
      queryPath(`/cloud/hk-ccass/stocks/${encodeURIComponent(code)}`, { from: options.from || undefined, date: options.date || undefined, limit: options.limit || undefined }),
      signalInit(options.signal),
    );
  }

  /** Market-wide Hong Kong CCASS big changes and pre-placement deposits. */
  getHkCcassBigChanges(options: { depositsOnly?: boolean; minPct?: number; code?: string; limit?: number; signal?: AbortSignal } = {}) {
    return this.request<HkCcassBigChangesPayload>(
      queryPath("/cloud/hk-ccass/big-changes", {
        depositsOnly: options.depositsOnly ? "true" : undefined,
        minPct: options.minPct,
        code: options.code || undefined,
        limit: options.limit || undefined,
      }),
      signalInit(options.signal),
    );
  }

  /** Market-wide Hong Kong CCASS Top-5 and Top-10 concentration rankings. */
  getHkCcassConcentration(options: { sortBy?: "top5" | "top10" | "top10_non_ccass" | "ccass_pct" | "deposit"; limit?: number; signal?: AbortSignal } = {}) {
    return this.request<HkCcassConcentrationPayload>(
      queryPath("/cloud/hk-ccass/concentration", { sortBy: options.sortBy || undefined, limit: options.limit || undefined }),
      signalInit(options.signal),
    );
  }

  /** Stock Connect Southbound (A00003 + A00004) holdings and daily flow rankings. */
  getHkCcassSouthbound(options: { sortBy?: "pct" | "shares" | "delta_pct" | "delta_shares"; limit?: number; signal?: AbortSignal } = {}) {
    return this.request<HkCcassSouthboundPayload>(
      queryPath("/cloud/hk-ccass/southbound", { sortBy: options.sortBy || undefined, limit: options.limit || undefined }),
      signalInit(options.signal),
    );
  }

  /** Reverse portfolio lookup of all HK stocks held by a single CCASS participant ID. */
  getHkCcassParticipant(partId: string, options: { sortBy?: "pct" | "shares" | "delta_pct"; limit?: number; signal?: AbortSignal } = {}) {
    return this.request<HkCcassParticipantPortfolioPayload>(
      queryPath(`/cloud/hk-ccass/participants/${encodeURIComponent(partId)}`, { sortBy: options.sortBy || undefined, limit: options.limit || undefined }),
      signalInit(options.signal),
    );
  }

  getCloudExchangeAnnouncements(params: import("./exchange-announcements").ExchangeAnnouncementsRequest) {
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

  /**
   * `interactive` is a search box's keystroke, which gives a venue's own site
   * about a second; any other search (the CLI's) waits for it, as before.
   */
  async searchInstruments(
    query: string,
    limit = 10,
    options: { interactive?: boolean } = {},
  ): Promise<InstrumentSearchResult[]> {
    const response = await this.request<
      CloudMarketResponse<InstrumentSearchResult[]>
    >(cloudMarketSearchPath(query, limit, !options.interactive));
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
    if (query.markets) params.set("markets", query.markets);
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
    const path = cloudMarketSymbolPath("/market/quote", symbol, exchange);
    const known = this.#quoteNotFound(path);
    if (known) return known;
    const answer = await this.#readListing(() => this.request<CloudMarketResponse<CloudQuotePayload>>(path));
    if (isNotFound(answer)) this.#rememberQuoteNotFound(path);
    return answer;
  }

  async getCloudQuotesBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudQuotePayload>>> {
    const answer = await this.#readListing(() => this.#postMarketBatch<CloudQuotePayload>("/market/quotes/batch", targets, mode, options.signal), options.signal);
    this.#rememberBatchNotFound(targets, answer);
    return answer;
  }

  /**
   * A batch's "not found" for a listing is the quote route's too: the router asks each listing a batch missed once
   * more alone, and that read is answered from the batch instead of a second round trip to say the same.
   */
  #rememberBatchNotFound(targets: CloudMarketBatchTarget[], answer: CloudMarketResponse<CloudMarketBatchPayload<CloudQuotePayload>>): void {
    const items = answer.data?.items;
    for (const item of Array.isArray(items) ? items : []) {
      if (!isNotFound(item)) continue;
      const asked = targets.find((target) => target.symbol === item.symbol && (target.exchange ?? "") === (item.exchange ?? ""));
      if (asked) this.#rememberQuoteNotFound(cloudMarketSymbolPath("/market/quote", asked.symbol, asked.exchange));
    }
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
    return this.#requestMarketSymbol("/market/dividends", symbol, exchange);
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
    options: BatchableRead & { adjusted?: boolean } = {},
  ): Promise<CloudMarketResponse<CloudOptionsChainPayload>> {
    // A dated expiry asked with others may go out with the listing's other expiries asked in the same moment.
    if (expirationDate != null && options.batch && !options.adjusted) return this.optionsChains.read({ symbol, exchange, expirationDate });
    return this.request<CloudMarketResponse<CloudOptionsChainPayload>>(
      cloudOptionsChainPath(symbol, exchange, expirationDate, options.adjusted === true),
    );
  }

  async getCloudFinancials(symbol: string, exchange?: string, statementHistory?: "extended"): Promise<CloudMarketResponse<CloudFinancialsPayload>> {
    const path = cloudMarketSymbolPath("/market/financials", symbol, exchange);
    return this.#readListing(() => this.request(statementHistory === "extended" ? `${path}&statementHistory=extended` : path));
  }

  async getCloudFinancialsBatch(targets: CloudMarketBatchTarget[], mode: "cache-first" | "refresh" = "cache-first"): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudFinancialsPayload>>> {
    return this.#readListing(() => this.#postMarketBatch("/market/financials/batch", targets, mode));
  }

  getCloudHolders(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudHoldersPayload>> {
    return this.#requestMarketSymbol("/market/holders", symbol, exchange);
  }

  getCloudAnalystResearch(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudAnalystResearchPayload>> {
    return this.#requestMarketSymbol("/market/analyst", symbol, exchange);
  }

  async #marketShortReport<T>(path: string, symbol: string, fallbackMessage: string, exchange?: string, asOf?: string): Promise<T> {
    const response = await this.request<CloudMarketResponse<T>>(
      queryPath(`/market/${path}`, { symbol, exchange, asOf: asOf || undefined }),
    );
    if (!response.data) throw new Error(response.message || fallbackMessage);
    return response.data;
  }

  getJpxShortPositions(symbol: string, asOf?: string): Promise<JpxShortPositions> {
    return this.#marketShortReport("jpx-short-positions", symbol, "JPX position disclosures unavailable.", undefined, asOf);
  }

  getSgxShortSales(symbol: string, asOf?: string) {
    return this.#marketShortReport<SgxShortSales>("sgx-short-sales", symbol, "SGX short sale report unavailable.", "SGX", asOf);
  }

  getKoreanShortPositions(symbol: string, exchange: KoreanVenue, asOf?: string) {
    return this.#marketShortReport<KoreanShortPositions>("korean-short-positions", symbol, `${exchange} short sale report unavailable.`, exchange, asOf);
  }

  getMainlandLendingBalances(symbol: string, exchange: MainlandVenue, asOf?: string) {
    return this.#marketShortReport<MainlandLendingBalances>("mainland-lending-balances", symbol, `${exchange} short sale report unavailable.`, exchange, asOf);
  }

  getTaiwanShortBalances(symbol: string, exchange: TaiwanVenue, asOf?: string) {
    return this.#marketShortReport<TaiwanShortBalances>("taiwan-short-balances", symbol, `${exchange} short sale report unavailable.`, exchange, asOf);
  }

  getSfcShortPositions(symbol: string, asOf?: string): Promise<SfcShortPositions> {
    return this.#marketShortReport("hk-short-positions", symbol, "SFC weekly positions unavailable.", undefined, asOf);
  }

  /** A Hong Kong listing's share repurchases by session, its mandate and its blackout windows. */
  getCloudBuybacks(symbol: string, request?: { signal?: AbortSignal }): Promise<BuybacksPayload> {
    return this.request<BuybacksPayload>(`/cloud/buybacks/${encodeURIComponent(symbol)}`, request);
  }

  getCloudShortInterest(symbol: string, years?: number): Promise<CloudMarketResponse<CloudShortInterestPayload>> {
    return this.request<CloudMarketResponse<CloudShortInterestPayload>>(queryPath("/market/short-interest", { symbol: symbol.toUpperCase(), years }));
  }

  getCloudCorporateActions(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudCorporateActionsPayload>> {
    return this.#requestMarketSymbol("/market/corporate-actions", symbol, exchange);
  }

  /**
   * The share splits of several bare symbols in one request, and nothing else
   * of their corporate actions: by symbol as asked, null for one with no split
   * history the service can list. A symbol the service could not answer for is left out.
   */
  getCloudSplitHistoryBatch(symbols: readonly string[], options: { signal?: AbortSignal } = {}): Promise<Map<string, SplitHistory | null>> {
    return this.#postBatchAnswers("/market/splits/batch", { symbols }, "symbol", options.signal);
  }

  /** Where the issuer that held a US symbol trades now, or what the symbol's holder was called before. */
  getCloudTickerChanges(symbol: string, options: { signal?: AbortSignal } = {}): Promise<CloudMarketResponse<TickerChanges>> {
    return this.request(queryPath("/market/ticker-changes", { symbol: symbol.trim().toUpperCase() }), signalInit(options.signal));
  }

  /**
   * `getCloudTickerChanges` for several symbols in one request: by symbol as
   * asked, null for one with no change on record. A symbol the service could
   * not answer for is left out.
   */
  getCloudTickerChangesBatch(symbols: readonly string[], options: { signal?: AbortSignal } = {}): Promise<Map<string, TickerChanges | null>> {
    return this.#postBatchAnswers("/market/ticker-changes/batch", { symbols }, "symbol", options.signal);
  }

  /**
   * Several searches in one request, each answered as `searchInstruments`
   * answers it: by query as asked, a query the service could not search left out.
   */
  async searchInstrumentsBatch(queries: readonly string[], limit = 10, options: { signal?: AbortSignal } = {}): Promise<Map<string, InstrumentSearchResult[]>> {
    const raw = await this.#postBatchAnswers<"query", InstrumentSearchResult[]>("/market/search/batch", { queries, limit }, "query", options.signal);
    const answers = new Map<string, InstrumentSearchResult[]>();
    for (const [query, rows] of raw) answers.set(query, rows ?? []);
    return answers;
  }

  /** Every listing of the company a listing belongs to (RCI and RCI.B:TSX are Rogers); empty for one the service does not hold. */
  getCloudIssuerListings(symbol: string, exchange = "", options: { signal?: AbortSignal } = {}): Promise<CloudMarketResponse<IssuerListings>> {
    return this.request(queryPath("/market/issuer-listings", {
      symbol: symbol.trim().toUpperCase(),
      exchange: exchange.trim().toUpperCase() || undefined,
    }), signalInit(options.signal));
  }

  /** The listed company each organization name resolves to, if any: a trial's lead sponsors, a page at a time. */
  getCloudOrganizationTickers(names: readonly string[], signal?: AbortSignal): Promise<OrganizationTickersResponse> {
    return this.request<OrganizationTickersResponse>("/market/organization-tickers", { method: "POST", body: JSON.stringify({ names }), signal });
  }

  async getCloudHistory(
    symbol: string,
    exchange: string,
    params: CloudHistoryParams = {},
    options: {
      signal?: AbortSignal;
      /**
       * With `batch`, the dates are the window every read asked with this one
       * shares (a portfolio's holdings over the risk model's months), so they
       * go out together over it.
       */
      sharedWindow?: boolean;
    } & BatchableRead = {},
  ): Promise<CloudMarketResponse<CloudPricePointPayload[]>> {
    const dated = Boolean(params.startDate || params.endDate);
    // Trailing bars asked with others, or bars over a window shared with them, not a session or recovery of their own,
    // may go out with the others asked in the same moment. A read over a shared window keeps its signal: the batch it
    // went out in is others' too and runs on, but the read stops waiting for it.
    const shared = options.batch && !params.historyRecovery && !params.session && (dated ? options.sharedWindow : !options.signal);
    return this.#readListing(() => shared
      ? abortable((dated ? this.datedHistories : this.histories).read({
        symbol,
        exchange,
        params: { interval: params.interval, outputsize: params.outputsize, rangeKey: params.rangeKey, startDate: params.startDate, endDate: params.endDate },
      }), options.signal, "History read aborted")
      : this.request<CloudMarketResponse<CloudPricePointPayload[]>>(
        cloudHistoryPath(symbol, exchange, params),
        signalInit(options.signal),
      ), options.signal);
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
  async getCloudEconomicCalendarFrom(from: string, options?: { signal?: AbortSignal }): Promise<CloudEconCalendarFromPayload> {
    return this.request<CloudEconCalendarFromPayload>(`/cloud/econ/calendar/history?from=${encodeURIComponent(from)}`, options);
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

  /** Futures-only positions unless `positions` asks for futures and options combined. */
  getCloudCotBoard(report: CotFamily, traderClass: CotClass, positions: CotPositions = "futures-only"): Promise<CotBoardPayload> {
    return this.request(queryPath("/cloud/cot/board", {
      report, traderClass, scope: positions === "combined" ? positions : undefined, includeIce: report === "disaggregated" ? "true" : undefined,
    }));
  }

  /** A market's report; `since` (YYYY-MM-DD) lists its history from that day instead of the last three years. */
  getCloudCotContract(code: string, report: CotFamily, positions: CotPositions = "futures-only", since?: string): Promise<CotContractPayload> {
    return this.request(queryPath(`/cloud/cot/contracts/${encodeURIComponent(code)}`, {
      report, scope: positions === "combined" ? positions : undefined, since: since || undefined, includeIce: report === "disaggregated" ? "true" : undefined,
    }));
  }

  /** Geo layers (the map's layers, entities and series); one prefix-scoped method, like EQS. */
  geo<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(`/cloud/geo/${path}`, init);
  }

  /** Credit-document paths stay with their pane; keep the shared client small. */
  creditDocuments<T>(path: string): Promise<T> {
    return this.request<T>(`/cloud/credit-documents/${path}`);
  }

  getCloudHiring(symbol?: string, query: { limit?: number; offset?: number } = {}, signal?: AbortSignal): Promise<HiringBoard | HiringPayload> {
    return this.request(symbol ? `/cloud/hiring/${encodeURIComponent(symbol)}` : queryPath("/cloud/hiring", { limit: query.limit ?? 100, offset: query.offset ?? 0 }), { signal });
  }

  /** HIRE's moves: the board of the latest computed week, or one company's weeks. */
  getCloudHiringMoves(symbol?: string, query: { limit?: number; offset?: number; signal?: HiringMovesFilter } = {}, signal?: AbortSignal): Promise<HiringMovesBoard | HiringCompanyMoves> {
    return this.request(
      symbol ? `/cloud/hiring/moves/${encodeURIComponent(symbol)}` : queryPath("/cloud/hiring/moves", { limit: query.limit ?? 100, offset: query.offset ?? 0, signal: query.signal ?? "moves" }),
      { signal },
    );
  }

  /** HIRE's Expansion or Anomalies board of the latest computed week. */
  getCloudHiringSignals(group: HiringSignalGroup, query: { limit?: number; offset?: number; kind?: HiringSignalsFilter } = {}, signal?: AbortSignal): Promise<HiringSignalsBoard> {
    return this.request(queryPath(`/cloud/hiring/signals/${group}`, { limit: query.limit ?? 100, offset: query.offset ?? 0, kind: query.kind ?? "all" }), { signal });
  }

  /** One company's expansion and anomaly signals, both groups. */
  getCloudHiringCompanySignals(symbol: string, signal?: AbortSignal): Promise<HiringCompanySignals> {
    return this.request(`/cloud/hiring/signals/company/${encodeURIComponent(symbol)}`, { signal });
  }

  /** HIRE's Building board: role-family and theme shifts of the latest computed week. */
  getCloudHiringBuilding(query: { limit?: number; offset?: number; dimension?: HiringBuildingFilter } = {}, signal?: AbortSignal): Promise<HiringBuildingBoard> {
    return this.request(queryPath("/cloud/hiring/building", { limit: query.limit ?? 100, offset: query.offset ?? 0, dimension: query.dimension ?? "all" }), { signal });
  }

  /** One company's mix by role family and theme, and its shifts. */
  getCloudHiringCompanyBuilding(symbol: string, signal?: AbortSignal): Promise<HiringCompanyBuilding> {
    return this.request(`/cloud/hiring/building/${encodeURIComponent(symbol)}`, { signal });
  }

  async getCloudAppRankHistory(store: "app-store" | "google-play", appId: string, query: AppAttentionFilter = {}, signal?: AbortSignal): Promise<AppRankPayload> {
    return this.request<AppRankPayload>(queryPath(`/cloud/app-attention/app/${store}/${encodeURIComponent(appId)}`, query), { signal });
  }

  async getCloudAppAttention(query: AppAttentionFilter = {}, signal?: AbortSignal): Promise<AppAttentionPayload> {
    const { symbol, ...filters } = query;
    return this.request<AppAttentionPayload>(queryPath(`/cloud/app-attention/${symbol ? encodeURIComponent(symbol) : "board"}`, filters), { signal });
  }

  async getCloudCatalysts(query: CatalystFilters = {}, signal?: AbortSignal): Promise<CatalystResponse> {
    const route = query.litigation && query.symbol ? `/cloud/catalysts/litigation/${encodeURIComponent(query.symbol)}` : "/cloud/catalysts";
    return this.request<CatalystResponse>(queryPath(route, query), { signal });
  }

  async getCloudCatalystChanges(query: { since: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<CatalystChanges> {
    return this.request<CatalystChanges>(queryPath("/cloud/catalysts/changes", query), { signal });
  }

  async getCloudCatalystEvent(id: string, signal?: AbortSignal, query: { offset?: number; limit?: number } = {}): Promise<CatalystDetail> {
    return this.request<CatalystDetail>(queryPath(`/cloud/catalysts/events/${encodeURIComponent(id)}`, query), { signal });
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
  async getCloudPerpsBoard(query: PerpBoardQuery = {}): Promise<PerpBoardPayload> { return this.request(queryPath("/cloud/perps/board", query)); }
  async getCloudPerpsHistory(query: PerpHistoryQuery): Promise<PerpHistoryPayload> { return this.request(queryPath("/cloud/perps/history", query)); }
  async getCloudPerpsRankings(assetClass?: string): Promise<PerpRankingsPayload> { return this.request(queryPath("/cloud/perps/rankings", { assetClass: assetClass || undefined })); }
  async getCloudPerpsCompare(baseAsset: string): Promise<PerpBoardPayload> { return this.request(queryPath("/cloud/perps/compare", { baseAsset })); }
  async getCloudPerpsLiquidations(baseAsset: string): Promise<PerpLiquidationsPayload> { return this.request(queryPath("/cloud/perps/liquidations", { baseAsset })); }
  async getCloudPerpsDepth(baseAsset: string): Promise<PerpDepthPayload> { return this.request(queryPath("/cloud/perps/depth", { baseAsset })); }
  async getCloudPerpsEquity(symbol: string, exchange?: string): Promise<PerpBoardPayload> {
    return this.request(queryPath(`/cloud/perps/equity/${encodeURIComponent(symbol)}`, exchange === undefined ? {} : { identity: "listing", exchange }));
  }
  async getCloudPerpsEquities(listings: readonly PerpEquityListing[]): Promise<PerpEquitiesPayload> {
    return this.request("/cloud/perps/equities", { method: "POST", body: JSON.stringify({ listings }) });
  }
  async getCloudPerpsMarket(marketId: string): Promise<PerpMarketPayload> { return this.request(queryPath("/cloud/perps/market", { marketId })); }

  async analyzeCloudExposure(request: ExposureRequest): Promise<ExposurePayload> {
    return this.request<ExposurePayload>("/cloud/exposure/analyze", { method: "POST", body: JSON.stringify(request) });
  }

  async getCloudExposureScenarios(): Promise<{ scenarios: ExposureScenario[] }> {
    return this.request<{ scenarios: ExposureScenario[] }>("/cloud/exposure/scenarios");
  }

  async getCloudSupplyChain(symbol: string, options: SupplyRead = {}): Promise<SupplyChainPayload> {
    return this.request<SupplyChainPayload>(queryPath(`/cloud/supply-chain/${encodeURIComponent(symbol)}`, {
      tiers: options.tiers?.length ? options.tiers.join(",") : undefined,
      includeLeads: options.includeLeads ? "1" : undefined,
      asOf: options.asOf || undefined,
    }));
  }

  getCloudAwards(query: AwardFilter = {}, signal?: AbortSignal): Promise<AwardsPayload> {
    return this.request<AwardsPayload>(queryPath("/cloud/awards", query), { signal });
  }

  getCloudAward(id: string, signal?: AbortSignal, revisionsCursor?: string): Promise<AwardDetailPayload> {
    return this.request<AwardDetailPayload>(queryPath(`/cloud/awards/detail/${encodeURIComponent(id)}`, { revisionsCursor: revisionsCursor || undefined }), { signal });
  }

  /** Many symbols' disclosures, each as getCloudSupplyChain reads it; an item that failed has the status its own read would have had. */
  async getCloudSupplyChains(symbols: string[], options: SupplyOptions = {}): Promise<{ items: Array<{ symbol: string; chain?: SupplyChainPayload; status?: number }> }> {
    return this.request(queryPath("/cloud/supply-chain/batch", {
      symbols: symbols.join(","),
      tiers: options.tiers?.length ? options.tiers.join(",") : undefined,
      includeLeads: options.includeLeads ? "1" : undefined,
    }));
  }

  /** Many symbols' graphs on the same options, each as getCloudSupplyGraph reads it. */
  async getCloudSupplyGraphs(symbols: string[], options: Partial<GraphOptions> = {}): Promise<{ items: Array<{ symbol: string; graph?: GraphPayload; status?: number }> }> {
    return this.request(`/cloud/supply-chain/graphs?symbols=${encodeURIComponent(symbols.join(","))}&${supplyGraphQuery(options)}`);
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
    return this.request<PowerBoard>(queryPath("/cloud/power/board", query), { signal });
  }

  async getCloudPowerHistory(query: PowerFilter = {}): Promise<PowerHistory> {
    return this.request<PowerHistory>(queryPath("/cloud/power/history", query));
  }

  async getCloudPowerProject(id: string, query: Pick<PowerFilter, "offset" | "limit"> = {}, signal?: AbortSignal): Promise<PowerDetail> {
    return this.request<PowerDetail>(queryPath(`/cloud/power/projects/${encodeURIComponent(id)}`, query), { signal });
  }

  /** European day-ahead power prices by country, latest day first per market. */
  async getCloudEuropePower(): Promise<EuropePowerBoard> {
    return this.request<EuropePowerBoard>("/cloud/europe-energy/power", timeoutInit(30_000));
  }

  /** One market's daily day-ahead prices from `from` (all of them without one), oldest first. */
  async getCloudEuropePowerHistory(code: string, from?: string | null): Promise<EuropePowerHistory> {
    return this.request<EuropePowerHistory>(queryPath(`/cloud/europe-energy/power/${encodeURIComponent(code)}/history`, { from: from || undefined }), timeoutInit(30_000));
  }

  /** The EU carbon allowance (EUA) auction price as of its latest auction day, with the latest auctions. */
  async getCloudEuropeCarbon(): Promise<CarbonBoard> {
    return this.request<CarbonBoard>("/cloud/europe-energy/carbon", timeoutInit(30_000));
  }

  /** The daily EUA auction price from `from` (every auction day since 2020 without one), oldest first. */
  async getCloudEuropeCarbonHistory(from?: string | null): Promise<CarbonHistory> {
    return this.request<CarbonHistory>(queryPath("/cloud/europe-energy/carbon/history", { from: from || undefined }), timeoutInit(30_000));
  }

  /** European gas storage: the EU aggregate and each member state as of its latest gas day. */
  async getCloudEuropeGas(): Promise<GasStorageBoard> {
    return this.request<GasStorageBoard>("/cloud/europe-energy/gas", timeoutInit(30_000));
  }

  /** One area's gas days from `from` (all kept without one), oldest first. */
  async getCloudEuropeGasHistory(code: string, from?: string | null): Promise<GasStorageHistory> {
    return this.request<GasStorageHistory>(queryPath(`/cloud/europe-energy/gas/${encodeURIComponent(code)}/history`, { from: from || undefined }), timeoutInit(30_000));
  }

  /** One area's latest year against last year and its five-year range, day by day. */
  async getCloudEuropeGasSeasonal(code: string): Promise<GasStorageSeasonal> {
    return this.request<GasStorageSeasonal>(`/cloud/europe-energy/gas/${encodeURIComponent(code)}/seasonal`, timeoutInit(30_000));
  }

  async getCloudGpuBoard(): Promise<GpuBoardPayload> {
    return this.request<GpuBoardPayload>("/cloud/gpu/board");
  }

  async getCloudGpuHistory(query: GpuHistoryQuery = {}): Promise<GpuHistoryPayload> {
    return this.request<GpuHistoryPayload>(queryPath("/cloud/gpu/history", query));
  }

  async getCloudGpuEvents(gpuModel?: string): Promise<GpuEventsPayload> {
    return this.request<GpuEventsPayload>(queryPath("/cloud/gpu/events", { limit: "1000", gpuModel: gpuModel || undefined }));
  }

  async getCloudCpiBoard(): Promise<CpiBoardPayload> {
    return this.request<CpiBoardPayload>("/cloud/cpi/board");
  }

  /** The latest tape, or with a `range` that window of the session, read forward from its start. */
  async getCloudTape(symbol: string, exchange: string, signal?: AbortSignal, range?: TapeRange): Promise<TapeSnapshot> {
    return this.request<TapeSnapshot>(
      queryPath(`/cloud/tape/${encodeURIComponent(symbol)}`, { exchange, ...(range ? { from: range.from, to: range.to } : {}) }),
      timeoutInit(30_000, signal),
    );
  }

  async getCloudYieldCurve(): Promise<CloudYieldPointPayload[]> {
    return this.request<CloudYieldPointPayload[]>("/cloud/econ/yield-curve");
  }

  /** Daily USD SOFR swap estimates, comparisons and the selected tenor's history. */
  async getCloudSwapCurve(tenor: SwapTenor = "10Y", days = 365): Promise<SwapCurvePayload> {
    return this.request<SwapCurvePayload>(queryPath("/cloud/econ/swap-curve", { tenor, days }), timeoutInit(30_000));
  }

  /** A curve's session on or before `date` (latest without one), with look-backs and spreads. */
  async getCloudCurve(curve: CloudCurveId, date?: string | null): Promise<CloudCurveView> {
    return this.request<CloudCurveView>(queryPath(`/cloud/econ/curves/${encodeURIComponent(curve)}`, { date: date || undefined }), timeoutInit(30_000));
  }

  /** One tenor of a curve from `from` (all stored sessions without one), oldest first. */
  async getCloudCurveHistory(curve: CloudCurveId, tenor: string, from?: string | null): Promise<CloudCurveHistory> {
    return this.request<CloudCurveHistory>(queryPath(`/cloud/econ/curves/${encodeURIComponent(curve)}/history`, { tenor, from: from || undefined }), timeoutInit(30_000));
  }

  /**
   * Each market's curve and the session before, each on its own date: the
   * latest, or with `date` the last on or before it (within ten days). A
   * server older than dated reads answers with the latest whatever the date.
   */
  async getCloudWorldCurves(date?: string | null): Promise<CloudWorldCurves> {
    return this.request<CloudWorldCurves>(queryPath("/cloud/econ/curves", { date: date || undefined }), timeoutInit(30_000));
  }

  getCloudCryptoMarkets(): Promise<CryptoMarketsPayload> { return this.request("/cloud/crypto/markets", timeoutInit(45_000)); }
  /** Total stablecoin supply and the largest coins', daily, with 7D and 30D changes and shares. */
  getCloudStablecoinSupply(): Promise<StablecoinSupplyPayload> { return this.request("/cloud/crypto/stablecoins/supply", timeoutInit(30_000)); }
  /** One listed stablecoin's daily supply, by symbol. */
  getCloudStablecoinSupplyHistory(symbol: string): Promise<StablecoinSupplyHistoryPayload> {
    return this.request(`/cloud/crypto/stablecoins/supply/${encodeURIComponent(symbol)}`, timeoutInit(30_000));
  }
  /** Total DeFi TVL, the largest protocols and chains with 7D and 30D changes, and the total's daily history. */
  getCloudDefiTvl(): Promise<DefiTvlPayload> { return this.request("/cloud/crypto/defi/tvl", timeoutInit(30_000)); }
  /** Bitcoin's daily hash rate, the difficulty at each retarget, the next retarget's estimate and derived hashprice. */
  getCloudBitcoinNetwork(): Promise<BitcoinNetworkPayload> { return this.request("/cloud/crypto/bitcoin/network", timeoutInit(30_000)); }
  /** Daily net flows of the US spot bitcoin or ether ETFs, per fund, in US$ millions. */
  getCloudCryptoEtfFlows(asset: CryptoEtfFlowAsset): Promise<CryptoEtfFlowsPayload> {
    return this.request(`/cloud/crypto/etf-flows?asset=${asset.toLowerCase()}`, timeoutInit(30_000));
  }
  getCloudCentralBankRates(): Promise<CentralBankRatesPayload> { return this.request("/cloud/econ/central-bank-rates", timeoutInit(45_000)); }
  /** Japan's foreign exchange interventions as its Ministry of Finance publishes them. */
  getCloudFxInterventions(signal?: AbortSignal): Promise<FxInterventionsPayload> { return this.request("/cloud/econ/fx-interventions", timeoutInit(20_000, signal)); }
  /** Hong Kong government paper tender results from HKMA's Open API, issued on or after `from` (YYYY-MM-DD), at most `limit`. */
  getCloudHkTenders(from: string, limit: number, signal?: AbortSignal): Promise<HkTendersPayload> {
    return this.request(queryPath("/cloud/econ/hk-tenders", { from, limit }), timeoutInit(20_000, signal));
  }
  /** U.S. TreasuryDirect securities search results for `startDate`..`endDate` (YYYY-MM-DD, inclusive). */
  getCloudUsTreasuryDirect(startDate: string, endDate: string, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>(queryPath("/cloud/econ/us-treasury-direct", { startDate, endDate }), timeoutInit(20_000, signal));
  }
  /** A live scan's matches against Gloom Cloud's newest market-wide snapshot for this account's tier. */
  getLiveScan(definition: LiveScanWireDefinition, signal?: AbortSignal) {
    return this.request<LiveScanPayload>(LIVE_SCAN_PATH, { method: "POST", body: JSON.stringify({ scan: definition }), ...timeoutInit(20_000, signal) });
  }
  /** Recorded FLOW prints older than the live tape (Pro); the plugin builds `search`. */
  getScannerFlowHistory(search: string, signal?: AbortSignal) { return this.request<ScannerFlowHistoryPage>(`/market/scanner/flow/history?${search}`, { signal }); }
  /** The latest session's recorded FLOW prints summed by side, by time and by strike (Pro); the plugin builds `search`. */
  getScannerFlowSession(search: string, signal?: AbortSignal) { return this.request<ScannerFlowSession>(`/market/scanner/flow/session?${search}`, { signal }); }
  getMobileAlertHistory<T>(offset = 0) { return this.request<T>(`/mobile/alerts/history?offset=${offset}`); }
  getCloudMoneyMarkets(): Promise<MoneyMarketsPayload> { return this.request("/cloud/econ/money-markets", timeoutInit(45_000)); }
  getCloudHongKongMoneyMarkets(): Promise<HongKongMoneyMarketsPayload> { return this.request("/cloud/econ/money-markets/hk", timeoutInit(45_000)); }
  getCloudDebtMaturities(symbol: string, listing?: IssuerListingParams): Promise<DebtMaturitiesPayload> {
    return this.request(cloudDebtMaturitiesPath(symbol, listing), timeoutInit(45_000));
  }
  /** One bond's kept prints and daily closes over `from` to `to` (at most 1,100 days); reading it keeps the bond from now on. */
  getCloudStoredBond(cusip: string, params: { from: string; to: string; limit?: number }, options: { signal?: AbortSignal } = {}): Promise<StoredBondPayload> {
    return this.request(
      queryPath(`/cloud/bond-trades/bond/${encodeURIComponent(cusip)}`, { from: params.from, to: params.to, limit: params.limit || undefined }),
      { signal: options.signal ?? AbortSignal.timeout(20_000) },
    );
  }
  /** A company's bonds as kept; reading it keeps them from now on. Only the first page of bonds and prints is asked. */
  getCloudStoredIssuerBonds(symbol: string, options: { signal?: AbortSignal } = {}): Promise<StoredIssuerBondsPayload> {
    return this.request(queryPath("/cloud/bond-trades/issuer", { symbol, limit: "1", bondsLimit: "1" }), { signal: options.signal ?? AbortSignal.timeout(20_000) });
  }
  /** A company's live bonds by CUSIP, as its listing (`2318:HKEX`) is linked to them; Gloom Pro. */
  getCloudIssuerBondIssues(listing: string, options: { signal?: AbortSignal } = {}): Promise<IssuerBondIssuesPayload> {
    return this.request(queryPath("/cloud/bond-trades/issues", { symbol: listing }), { signal: options.signal ?? AbortSignal.timeout(10_000) });
  }
  getCloudBankFigures(symbol: string): Promise<BankFiguresPayload> { return this.request(cloudBankFiguresPath(symbol), timeoutInit(30_000)); }
  getCloudRevenueBreakdown(symbol: string, view?: RevenueBreakdownView, listing?: IssuerListingParams): Promise<RevenueBreakdownPayload> {
    return this.request(cloudRevenueBreakdownPath(symbol, view, listing), timeoutInit(30_000));
  }
  getCloudMnaDeals(params: MnaDealsParams = {}, options?: { signal?: AbortSignal }): Promise<MnaDealsPayload> {
    return this.request(queryPath("/cloud/mna/deals", params, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getCloudMnaDeal(id: string, options?: { signal?: AbortSignal }): Promise<MnaDealPayload> {
    return this.request(`/cloud/mna/deals/${encodeURIComponent(id)}`, timeoutInit(30_000, options?.signal));
  }

  // Public records about companies in difficulty. The answers are unchecked
  // JSON: the distress tab's parsers validate them before anything is drawn.
  getPublicDistressFilings(params: DistressFilingsParams, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request(queryPath("/public/events", params, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getPublicGoingConcern(params: GoingConcernParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request(queryPath("/public/going-concern", params, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getPublicDistressDesignations(params: DistressDesignationsParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request(queryPath("/public/distress-designations", params, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getPublicInsolvencyNotices(params: InsolvencyNoticesParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request(queryPath("/public/insolvency-notices", params, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getPublicLetters(params: LettersParams = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    const { kinds, ...rest } = params;
    return this.request(queryPath("/public/letters", { kind: kinds?.length ? kinds.join(",") : undefined, ...rest }, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getCloudIpoCalendar(params: IpoCalendarParams = {}, options?: { signal?: AbortSignal }): Promise<IpoCalendarPayload> {
    return this.request(queryPath("/cloud/ipo/calendar", params, { skipEmpty: true }), timeoutInit(30_000, options?.signal));
  }
  getCloudFailsToDeliver(symbol: string): Promise<FailsToDeliverPayload> { return this.request(queryPath("/cloud/fails-to-deliver", { symbol }), timeoutInit(20_000)); }
  getCloudOtcVolume(symbol: string): Promise<OtcVolumePayload> { return this.request(queryPath("/cloud/otc-volume", { symbol }), timeoutInit(20_000)); }
  getCloudShortVolume(symbol: string, scope: ShortVolumeScope = "nms"): Promise<ShortVolumePayload> { return this.request(queryPath("/cloud/short-volume", { symbol, scope }), timeoutInit(20_000)); }
  getCloudSocialMentions(symbol: string, range: SocialMentionsRange = "1y"): Promise<SocialMentionsPayload> { return this.request(queryPath("/cloud/social-mentions", { symbol, range }), timeoutInit(30_000)); }
  getCloudSocialMentionPosts(symbol: string, day: string): Promise<SocialMentionDayPosts> { return this.request(queryPath("/cloud/social-mentions/posts", { symbol, day }), timeoutInit(30_000)); }
  /** The market's social outliers: tickers posted about most against their own 30-day median. */
  getCloudSocialOutliers(params: CloudSocialOutliersParams = {}, options?: { signal?: AbortSignal }): Promise<SocialOutliersPayload> {
    return this.request(
      queryPath("/cloud/social-mentions/outliers", { window: params.window || undefined, minPosts: params.minPosts || undefined, cap: params.cap || undefined, limit: params.limit || undefined }),
      { signal: options?.signal ?? AbortSignal.timeout(30_000) },
    );
  }
  getCloudFuturesCurve(root: string): Promise<FuturesCurvePayload> { return this.request(`/cloud/futures/curve/${encodeURIComponent(root)}`, timeoutInit(60_000)); }
  /** What a futures symbol (GC=F, GCZ26, CL1) trades: its contract, terms and latest confirmed settlement. */
  async getCloudFuturesContract(symbol: string, options: BatchableRead = {}): Promise<FuturesContractTermsPayload> {
    if (!options.batch) return this.request(`/cloud/futures/contract/${encodeURIComponent(symbol)}`, timeoutInit(20_000));
    const terms = await this.futuresTerms.read(symbol);
    if (!terms) throw new ApiRequestError("Not a futures symbol with known contract terms", 404);
    return terms;
  }
  /** Many symbols' terms, each as getCloudFuturesContract reads it: null for one without known terms, an error for a failed read. */
  getCloudFuturesContracts(symbols: string[]): Promise<{ items: Array<{ symbol: string; terms: FuturesContractTermsPayload | null; error?: string }> }> {
    return this.request(queryPath("/cloud/futures/contracts", { symbols: symbols.join(",") }), timeoutInit(30_000));
  }
  getCloudFuturesCurveAsOf(root: string, date: string): Promise<FuturesCurveAsOfPayload> {
    return this.request(`/cloud/futures/curve/${encodeURIComponent(root)}/as-of/${encodeURIComponent(date)}`, timeoutInit(30_000));
  }
  getCloudRatePath(): Promise<RatePathPayload> { return this.request("/cloud/econ/rate-path", timeoutInit(45_000)); }
  getCloudCds(params: CloudCdsParams = {}): Promise<CloudCdsResponse> { return this.request(cloudCdsPath(params)); }
  getCloudCdsHistory(params: CloudCdsHistoryParams): Promise<CloudCdsHistoryResponse> { return this.request(cloudCdsHistoryPath(params), timeoutInit(30_000)); }
  /** Every listed issuer's latest 5Y level in one request. */
  getCloudCdsLevels(): Promise<CloudCdsLevelsResponse> { return this.request("/cloud/credit/cds/levels", timeoutInit(30_000)); }
  getCloudCdxBoard(params: CloudCreditBoardParams = {}): Promise<CdxBoardPayload> { return this.request(cloudCreditBoardPath("cdx", params), timeoutInit(30_000)); }
  getCloudSovrBoard(params: CloudCreditBoardParams = {}): Promise<SovrBoardPayload> { return this.request(cloudCreditBoardPath("sovr", params), timeoutInit(30_000)); }
  getCloudCongressHouse(params: CloudCongressHouseParams = {}, options?: { signal?: AbortSignal }): Promise<CloudCongressHousePayload> {
    return this.request(cloudCongressHousePath(params), options);
  }
  getCloudJobs(ticker: string, name?: string | null): Promise<CloudJobsResponse> { return this.request(cloudJobsPath(ticker, name)); }
  getCloudJobsPostings(ticker: string, params: CloudJobsPostingsParams = {}): Promise<CloudJobsPostingsPayload> { return this.request(cloudJobsPostingsPath(ticker, params)); }
  getCloudJobsPosting(ticker: string, posting: { id: number } | { externalId: string }): Promise<CloudJobsPostingDetail> { return this.request(cloudJobsPostingPath(ticker, posting)); }
  getCloudJobsMovers(limit?: number, offset?: number): Promise<CloudJobsMoversPayload> { return this.request(cloudJobsMoversPath(limit, offset)); }

  async getCloudEarningsCalls(params: CloudEarningsCallsParams = {}): Promise<CloudEarningsCallListPayload> {
    const abandon = new AbortController();
    return withDeadline(
      this.request<CloudEarningsCallListPayload>(cloudEarningsCallsPath(params), { signal: abandon.signal }),
      EARNINGS_CALLS_LIST_TIMEOUT_MS,
      `No answer within ${EARNINGS_CALLS_LIST_TIMEOUT_MS / 1000} s.`,
      () => abandon.abort(),
    );
  }
  getCloudEarningsTranscript(id: string): Promise<CloudEarningsTranscriptPayload> { return this.request(cloudEarningsTranscriptPath(id)); }
  getCloudEarningsCallAudio(id: string): Promise<CloudEarningsCallAudioPayload> { return this.request(cloudEarningsCallAudioPath(id)); }
  // A listing outside the US also sends its venue and company (listingAbroad).
  getProxyStatements(ticker: string, listing?: IssuerListingParams): Promise<CloudProxyStatementListPayload> { return this.request(cloudProxyStatementsPath(ticker, listing)); }
  getProxyStatement(ticker: string, year: number, listing?: IssuerListingParams): Promise<CloudProxyStatementPayload> { return this.request(cloudProxyStatementPath(ticker, year, listing)); }
  getFilingEvents(ticker: string, limit?: number, listing?: IssuerListingParams): Promise<{ ticker: string; events: CloudFilingEventPayload[] }> {
    return this.request(cloudFilingEventsPath(ticker, limit, listing));
  }
  getRiskReports(ticker: string, listing?: IssuerListingParams): Promise<CloudRiskReportListPayload> { return this.request(cloudRiskReportsPath(ticker, listing)); }
  getRiskReport(ticker: string, year: number, listing?: IssuerListingParams): Promise<CloudRiskReportPayload> { return this.request(cloudRiskReportPath(ticker, year, listing)); }
  getCloudSecFilings(params: CloudSecFilingsParams, options?: { signal?: AbortSignal }): Promise<CloudSecFilingsResponse> { return this.request(cloudSecFilingsPath(params), options); }
  /** Schedule 13D/13G reports about an issuer. Unknown tickers answer 404; no reports is an empty `owners`. */
  getCloudSecBeneficialOwners(params: CloudBeneficialOwnersParams, options?: { signal?: AbortSignal }): Promise<BeneficialOwnersPayload> {
    return this.request(cloudSecBeneficialOwnersPath(params), signalInit(options?.signal));
  }
  getCloudSecInsiderSignals(params: CloudInsiderSignalsParams = {}, options?: { signal?: AbortSignal }): Promise<InsiderSignalsPayload> {
    return this.request(cloudSecInsiderSignalsPath(params), signalInit(options?.signal));
  }
  getCloudSecFilingDocuments(params: CloudSecFilingParams): Promise<CloudSecDocumentsResponse> { return this.request(cloudSecFilingDocumentsPath(params)); }
  getCloudSecFilingContent(params: CloudSecFilingParams): Promise<CloudSecContentResponse> { return this.request(cloudSecFilingContentPath(params)); }
  getCloudSec13F(path: string, params: Record<string, string | number | undefined> = {}, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request(cloudSec13FPath(path, params), signalInit(options?.signal));
  }

  /**
   * Cross-document full-text search, open to every signed-in account; signed
   * out it answers 401. Only alerts on a saved search need Pro.
   */
  async searchCloudDocuments(params: CloudSearchParams, options?: { signal?: AbortSignal }): Promise<CloudSearchResponse> {
    return normalizeSearchResponse(await this.request<CloudSearchResponse>(cloudSearchPath(params), signalInit(options?.signal)));
  }
  async getCloudSearchDocument(docType: CloudSearchDocType, sourceId: string, options?: { signal?: AbortSignal }): Promise<CloudSearchDocument> {
    return (await this.request<CloudSearchDocumentResponse>(cloudSearchDocumentPath(docType, sourceId), signalInit(options?.signal))).document;
  }
  async getCloudSavedSearches(options?: { signal?: AbortSignal }): Promise<CloudSavedSearch[]> {
    return (await this.request<CloudSavedSearchListResponse>(cloudSavedSearchesPath(), signalInit(options?.signal))).searches ?? [];
  }
  async createCloudSavedSearch(input: CloudSavedSearchInput): Promise<CloudSavedSearch> {
    return normalizeSavedSearchResponse(await this.request<unknown>(cloudSavedSearchesPath(), { method: "POST", body: JSON.stringify(input) }));
  }
  async updateCloudSavedSearch(id: string, update: Partial<CloudSavedSearchInput>): Promise<CloudSavedSearch> {
    return normalizeSavedSearchResponse(await this.request<unknown>(cloudSavedSearchPath(id), { method: "PATCH", body: JSON.stringify(update) }));
  }
  async deleteCloudSavedSearch(id: string): Promise<void> { await this.request<void>(cloudSavedSearchPath(id), { method: "DELETE" }); }
  getCloudNews(params: CloudNewsParams = {}): Promise<CloudNewsListResponse> { return this.request(cloudNewsPath(params)); }
  searchCloudNews(query: string, limit?: number, topics?: readonly string[], options: { closest?: boolean; tickers?: readonly string[] } = {}): Promise<CloudNewsListResponse> {
    return this.request(cloudNewsSearchPath(query, limit, topics, options));
  }
  getCloudNewsStory(storyId: string): Promise<CloudNewsPayload> { return this.request(`/news/${encodeURIComponent(storyId)}`); }
  /** The stories that report each Form 4, by accession number: the match a story's own filings come from, run the other way. */
  getCloudInsiderFilingStories(accessions: readonly string[]): Promise<CloudInsiderFilingStoriesResponse> {
    return this.request(queryPath("/news/insider-filing-stories", { accessions: accessions.join(",") }));
  }
  async getCloudTickerTweets(params: CloudTickerTweetsParams): Promise<CloudTweetSearchResponse> {
    return normalizeTweetSearchResponse(await this.request<CloudTweetSearchResponse>(cloudTickerTweetsPath(params)));
  }
  async searchCloudTweets(params: CloudTweetSearchParams): Promise<CloudTweetSearchResponse> {
    return normalizeTweetSearchResponse(await this.request<CloudTweetSearchResponse>(cloudTweetSearchPath(params)));
  }
  getDilutionCompany(symbol: string): Promise<DilutionCompanyPayload> { return this.request(cloudDilutionCompanyPath(symbol)); }
  getDilutionForm144(options: { symbol?: string; plan10b51Only?: boolean; limit?: number } = {}): Promise<DilutionForm144FeedPayload> {
    return this.request(cloudDilutionForm144Path(options));
  }
  getDilutionShelves(options: { atmOnly?: boolean; babyShelfOnly?: boolean; limit?: number } = {}): Promise<DilutionShelvesFeedPayload> {
    return this.request(cloudDilutionShelvesPath(options));
  }
  getTaiwanStockRevenue(code: string, limit = 36): Promise<TaiwanStockRevenuePayload> { return this.request(cloudTaiwanStockRevenuePath(code, limit)); }
  getTaiwanUsReadthrough(ticker: string, months = 24): Promise<TaiwanUsReadthroughPayload> { return this.request(cloudTaiwanUsReadthroughPath(ticker, months)); }
  getHkCbbcUnderlying(underlying: string, limit = 40): Promise<HkCbbcUnderlyingPayload> { return this.request(cloudHkCbbcUnderlyingPath(underlying, limit)); }
  getHkCbbcOverview(limit = 40): Promise<HkCbbcOverviewPayload> { return this.request(cloudHkCbbcOverviewPath(limit)); }
}
