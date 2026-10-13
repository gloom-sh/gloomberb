import type { CliCommandDef } from "../../types/plugin";
import { TIME_RANGES, type TimeRange } from "../../time-series/range";
import type { EarningsEvent, QuoteBatchResult, QuoteSubscriptionTarget, SecFilingItem } from "../../types/data-provider";
import type { NewsArticle, NewsFeed, NewsQuery } from "../../news/types";
import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  OptionsChain,
  Quote,
  TickerFinancials,
} from "../../types/financials";
import { currencyPriceMinDigits, formatMarketPrice, formatMarketPriceWithCurrency, quoteFormatOptions } from "../../market-data/market/format";
import {
  EXTENDED_SESSION_LABELS,
  getExtendedSessionDisplay,
  getQuoteSessionFields,
  getRegularSessionDisplay,
  quoteSessionLabel,
  type ExtendedSession,
} from "../../market-data/market/status";
import { formatCompact, formatDistributionAmount, formatPercent, formatPercentRaw } from "../../utils/format";
import { withCliServices, withMarketData } from "../context";
import { isoDate, parsePositiveInt, requireOneArg, takeFlag, takeOption } from "./command-utils";
import type { BuiltinCliCommandDef } from "../command-options";
import { CLI_COMMAND_GROUPS, TABLE_SECTION_OPTION } from "../help";
import {
  formatChangePercentCell,
  formatCountCell,
  formatFractionPercentCell,
  formatPriceRange,
} from "../helpers";
import { cliStyles, colorBySign, renderSection, renderStats } from "../../utils/cli-output";
import { formatPerShareNumber } from "../../utils/reported-money";
import {
  analystTargetCurrency,
  formatAnalystPrice,
  formatRatingLabel,
  formatRecommendationMix,
  recommendationTotal,
  targetUpside,
} from "../../plugins/builtin/research/analyst-model";
import { getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../../market-data/published-us-sessions";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { isOptionsUnavailableError, listedOptionsAlternative, optionsUnavailableTitle } from "../../market-data/options-alternatives";
import { cliFuturesContract, futuresContractMetrics, fundamentalsReportTables, renderFundamentalsReport } from "./ticker";
import type { FuturesContractTermsPayload } from "../../api-client/futures-curve";
import { futuresSettleText, isFuturesInstrument } from "../../market-data/futures-contract";
import {
  chainHasExpiry,
  chainWithModelFigures,
  formatExpiryList,
  loadOptionModelInputs,
  formatOptionDeltaCell,
  formatOptionIvCell,
  formatOptionQuoteCell,
  missingExpiryMessage,
  OPTION_MODEL_RATE,
  OPTIONS_USAGE,
  optionRows,
  parseOptionExpiration,
} from "./options-chain";
import { DEFAULT_LEAPS_CRITERIA, LEAPS_USAGE, parseLeapsCriteria, runLeapsScreen, takeLeapsOptions } from "./options-leaps";
import type { CliResultColumn } from "../result";
import type { PriceHistoryResult } from "../../types/price-history";
import {
  exportRowsTable,
  reportFooterLines,
  selectReportTables,
  type CliReportTables,
} from "../report-tables";
import {
  historyBarStatusNote,
  historyCoverageWarning,
  historyFacts,
  historyFlagNote,
  historyGapNote,
  historyJumpNote,
  historyUnbrokenFrom,
  historyAllRangeYears,
  historyIntervalsByRange,
  historyNotes,
  historyPriceDecimals,
  historyRows,
  historyUnit,
  historyVolume,
  historyVolumeText,
} from "../history-rows";
import { CRYPTO_BOARD_HINT, quoteNotes } from "./crypto-hints";
import { bareFuturesCode } from "../../market-data/futures-board";
import { newsEmptyMessage } from "./news-hints";
import { newsFallbackText, newsSearchHeading, newsSearchText, newsSearchTextProblem, searchNewsStories } from "./news-search";
import { formatUtcTime } from "../../utils/utc-time";
import { isFiniteNumber } from "../../utils/guards";
import { exportedFundamentals } from "../../utils/price-earnings";
import { fundamentalsFreshness, fxPairFreshness, quotesFreshness, rowsFreshness } from "../freshness";
import {
  barHistoryFreshness,
  barResolutionFromDates,
  cloudNewsFreshness,
  cloudRealtimeAccess,
  REPORTED_DATA,
  SEC_FILINGS,
} from "../../plugins/builtin/shared/report-freshness";
import {
  bareListingNote,
  tradingBoardNote,
  EXCHANGE_OPTION,
  futuresTryLine,
  isNoProviderError,
  listingHeading,
  listingIdentity,
  listingTitle,
  listingVenues,
  listingChoiceNotes,
  listingReadNotes,
  loadBareVenues,
  type ListingVenue,
  loadForListing,
  loadListingQuote,
  listingFateLoader,
  listingFateNotes,
  noLongerTradingNote,
  notTradedMessage,
  quoteBareListing,
  requireCliListing,
  tradingListing,
  type CliListing,
  type ListingDataRequest,
  type ListingIdentity,
} from "../listing-arg";
import { indexRootAlsoLine, indexRootFor, indexRootTryLine, isYieldIndexSymbol } from "../index-roots";
import { earningsCalendarFailure, earningsChoiceNote, earningsDateLabel, isListingAbroad, noListingCalendarNote } from "../earnings-calendar";
import { formatBasisPoints, toBasisPoints } from "../../utils/basis-points";
import { notATickerSymbol, providerMissReason } from "../../sources/provider-errors";
import { isNotATickerMessage, withListingSuggestion } from "../not-a-ticker";
import { describeSuggestion, suggestListing } from "../listing-suggestion";
import { splitSymbolArgs } from "../symbol-args";
import { cliPerpetualContract, perpetualContractStats, type PerpetualContractPayload } from "../perpetual-contract";
import { subMinuteDataMessage } from "../known-gaps";
import { secRegistrantMismatchMessage, SecRegistrantMismatchError, areDifferentCompanies } from "../../sources/sec-registrant";
import { isCryptoPairSymbol } from "../../utils/crypto-pair";
import { looksLikeCurrencyPair } from "../../utils/currency-pair";
import { isUsListingExchange } from "../../utils/exchanges";
import { describeTickerChange, startTickerChangeLookup, tickerChangeLine, type TickerChange } from "../../tickers/ticker-changes";
import { noSecReportsNotice, nonUsSecListingVenue } from "../../utils/sec";
import type { MarketContext } from "../types";
import { windowRows } from "../row-window";
import { crossRate, describeFxRate, isUsableRate, parseFxRequest } from "../fx-pair";
import {
  holderListFacts,
  holderListPeriod,
  holderShareBasisMarker,
  holderShareBasisNote,
  holderValueBasis,
  moneyColumnHeader,
  nonUsHolderCaveat,
  sharedReportDate,
} from "../../plugins/builtin/holders/report-header";
import { formatPercentHeld, holderStakeMarketCap, holderValueCurrency } from "../../plugins/builtin/holders/format";
import {
  holderReportColumns,
  holderReportDates,
  holderReportNotices,
  holderReportRows,
  holderReportUnits,
  unvaluedHoldersNote,
} from "../../plugins/builtin/holders/report-rows";
import { fetchBeneficialOwners } from "../../plugins/builtin/holders/beneficial-client";
import { centralBankEventsMessage } from "../central-bank-events";
import { classSharesToday } from "../../plugins/builtin/holders/client";
import { filingFormMatches, SEC_FILING_FETCH_LIMIT } from "../../plugins/builtin/sec/forms";
import { loadParsedInsiderFilings } from "../../plugins/builtin/insider/client";
import { insiderEmptyNotice } from "../../plugins/builtin/insider/issuer";
import {
  BENEFICIAL_REPORT_COLUMNS,
  beneficialCoverageNotices,
  beneficialListComplete,
  beneficialListFacts,
  beneficialListUnreadable,
  beneficialReportLegend,
  beneficialRouteForm,
  buildBeneficialReportRows,
  HOLDER_FORMS,
  parseHolderForm,
  type HolderForm,
} from "../../plugins/builtin/holders/beneficial-report";

const VALID_RANGES = new Set<TimeRange>(TIME_RANGES);
const VALID_NEWS_FEEDS = new Set<NewsFeed>(["latest", "top", "breaking", "ticker", "sector", "topic"]);

type QuoteCliRecord = Omit<QuoteBatchResult, "error"> & {
  error: string | null;
  /** The listing the row is, named from its saved ticker when the quote names nothing. */
  listing?: { name: string | null };
  /** A futures row's contract, terms and latest confirmed settlement, as `ticker` reads them. */
  futuresContract?: FuturesContractTermsPayload;
  /** A perpetual row's market, funding per eight hours and open interest. */
  perpetualContract?: PerpetualContractPayload;
  /** The symbol changed: its issuer moved to another symbol, or its holder had another before. */
  tickerChange?: TickerChange;
};
type FinancialsCliData = TickerFinancials & {
  symbol: string;
  exchange: string;
  providerId: string | null;
};

function parseRange(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): TimeRange {
  const range = (value ?? "1Y").toUpperCase() as TimeRange;
  if (!VALID_RANGES.has(range)) ctx.fail(`Unknown range "${value}".`, `Use one of ${TIME_RANGES.join(", ")}.`);
  return range;
}

function parseNewsFeed(value: string | undefined): NewsQuery["feed"] | undefined {
  return value && VALID_NEWS_FEEDS.has(value as NewsFeed) ? value as NewsQuery["feed"] : undefined;
}

/** The symbols of a command's arguments, one each however they were separated: spaces, commas or pasted lines. */
function normalizeSymbols(args: string[]): string[] {
  return splitSymbolArgs(args).map((symbol) => symbol.toUpperCase());
}

/** What JSON metadata says about the listing a command resolved. */
function listingMetadata(identity: ListingIdentity) {
  return { symbol: identity.symbol, exchange: identity.exchange || null, name: identity.name };
}

// Fitted to a narrow width, the columns marked optional go first (higher dropPriority first), then Name is cut short.
// What a user types or reads the price by stays whole.
const QUOTE_LEAD_COLUMNS = [
  { key: "symbol", header: "Symbol", shrink: false },
  { key: "name", header: "Name" },
  {
    key: "price",
    header: "Last",
    align: "right" as const,
    format: (value: unknown, row: QuoteRow) => (
      row.error && !value
        // A typo is not an outage: say what is wrong with the symbol itself.
        ? isNotATickerMessage(row.error) ? cliStyles.warning("not a ticker") : cliStyles.danger("unavailable")
        : yieldLevelCell(value, row)
    ),
  },
  {
    key: "changePercent",
    header: "Chg%",
    align: "right" as const,
    format: (value: unknown, row: QuoteRow) => row.yieldIndex ? yieldChangeCell(row) : formatChangePercentCell(value),
  },
  // Text drops a column no row fills, so a table without an extended print stays as narrow as before.
  extendedColumn("PRE"),
  extendedColumn("POST"),
  extendedColumn("OVERNIGHT"),
  { key: "session", header: "Session", shrink: false },
];

type QuoteRow = ReturnType<typeof quoteRows>[number];

/** A Cboe yield index level is a yield: `5.24%`, not a price. */
function yieldLevelCell(value: unknown, row: QuoteRow): string {
  const text = String(value ?? "");
  return row.yieldIndex && text ? `${text}%` : text;
}

/** A yield index moves in basis points: `+1.3bp`, from the real previous close, not a percent of a percent. */
function yieldChangeCell(row: QuoteRow): string {
  return row.changeBasisPoints == null ? "" : colorBySign(formatBasisPoints(row.changeBasisPoints / 100, 1), row.changeBasisPoints);
}

/**
 * The pre-market, after-hours or overnight print and its move from the
 * regular close, in its own column; "mid" when it is a bid and ask midpoint.
 */
function extendedColumn(session: ExtendedSession) {
  const price = (row: QuoteRow) => row.extendedMark ? `${row.extendedPrice} mid` : row.extendedPrice;
  return {
    key: session === "PRE" ? "preMarket" : session === "POST" ? "afterHours" : "overnight",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right" as const,
    value: (row: QuoteRow) => row.extendedSession === session && row.extendedPrice
      ? [price(row), row.extendedChangePercent == null ? "" : formatPercentRaw(row.extendedChangePercent)].join(" ").trim()
      : "",
    format: (value: unknown, row: QuoteRow) => (
      value ? [price(row), formatChangePercentCell(row.extendedChangePercent)].join(" ").trim() : ""
    ),
  };
}

/** A percent to two decimals, as the table prints it. */
function roundedPercent(value: number | undefined): number | null {
  return value == null ? null : Number(value.toFixed(2));
}

function quoteColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "currency", header: "Cur", shrink: false, optional: true, dropPriority: 1 },
    // Whether the price is real-time, delayed or stale: a feed state, not where it came from. A stale
    // row says so here, so the closing line's "N of M stale" always points at rows the table marks.
    {
      key: "feed",
      header: "Feed",
      shrink: false,
      optional: true,
      dropPriority: 2,
      format: (value: unknown) => value === "stale" ? cliStyles.warning(value) : String(value ?? ""),
    },
    // In a narrow terminal the closing line's as-of stands in for each row's.
    { key: "updatedAt", header: "Updated", shrink: false, optional: true, dropPriority: 3 },
  ];
}

function compareColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "previousClose", header: "Prev Close", align: "right" as const, format: yieldLevelCell },
    // A narrow terminal drops these before it cuts the names short.
    { key: "dayRange", header: "Day Range", align: "right" as const, optional: true, dropPriority: 1 },
    { key: "volume", header: "Volume", align: "right" as const, format: formatCountCell, optional: true, dropPriority: 2 },
    { key: "currency", header: "Cur", shrink: false, optional: true, dropPriority: 3 },
  ];
}

function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  return error instanceof Error ? error.message : String(error);
}

/** What the Feed cell says: stale wins over the feed's own live or delayed, as the closing line counts it. */
function quoteFeedState(quote: QuoteCliRecord["quote"], now: number): "stale" | "live" | "delayed" | "" {
  if (!quote) return "";
  if (isQuoteStaleForCurrentSession(quote, now)) return "stale";
  return quote.dataSource === "live" || quote.dataSource === "delayed" ? quote.dataSource : "";
}

function quoteRows(results: QuoteCliRecord[], now = Date.now()) {
  return results.map((result) => {
    const quote = result.quote;
    // Last and Chg% are the regular session, as `ticker` and the quote monitor read it; a
    // pre-market or after-hours print is its own column, measured from that session's close.
    const display = getRegularSessionDisplay(quote);
    const extended = getExtendedSessionDisplay(quote);
    const yieldIndex = isYieldIndexSymbol(result.target.symbol);
    // An index level is in points, not in the currency its members trade in.
    const indexPoints = quote?.instrumentType?.trim().toUpperCase() === "INDEX";
    // Pad to two decimals so a column lines up, but never past the currency's minor unit (JPY has none).
    // Points have no minor unit, so a yen-listed index still pads to two.
    const options = {
      ...quoteFormatOptions(quote),
      minimumFractionDigits: indexPoints ? 2 : currencyPriceMinDigits(quote?.currency),
    };
    const price = (value: number | undefined) => (
      quote && value != null
        ? indexPoints ? formatMarketPrice(value, options) : formatMarketPriceWithCurrency(value, quote.currency, options)
        : ""
    );
    return {
      symbol: result.target.symbol,
      name: quote?.name || result.listing?.name || "",
      price: price(display?.price),
      rawPrice: display?.price ?? null,
      priceBasis: quote?.priceBasis ?? null,
      instrumentType: quote?.instrumentType ?? null,
      change: display?.change ?? null,
      changePercent: roundedPercent(display?.changePercent),
      // A Cboe yield index is read as a yield in percent and moves in basis points.
      yieldIndex,
      changeBasisPoints: yieldIndex && display?.change != null ? toBasisPoints(display.change, 1) : null,
      extendedSession: extended?.session ?? null,
      extendedPrice: price(extended?.price),
      rawExtendedPrice: extended?.price ?? null,
      extendedChange: extended?.change ?? null,
      extendedChangePercent: roundedPercent(extended?.changePercent),
      // The extended price is the session's bid and ask midpoint, nothing having traded in it.
      extendedMark: extended?.mark === true,
      session: quoteSessionLabel(quote) ?? "",
      // The close the shown move is measured from: the one before the session Last is.
      previousClose: price(display?.change != null ? display.price - display.change : quote?.previousClose),
      dayRange: quote?.low != null && quote.high != null
        ? indexPoints ? `${price(quote.low)}-${price(quote.high)}` : formatPriceRange(quote.low, quote.high, quote.currency, options, "-")
        : "",
      volume: quote?.volume ?? null,
      currency: quote?.currency ?? "",
      providerId: quote?.providerId ?? "",
      source: quote?.dataSource ?? quote?.providerId ?? "",
      feed: quoteFeedState(quote, now),
      updatedAt: quote?.lastUpdated ? new Date(quote.lastUpdated).toISOString() : "",
      error: result.error ?? "",
    };
  });
}

function financialStatementRows(financials: FinancialsCliData) {
  return financials.annualStatements.map((statement) => ({
    date: statement.date,
    revenue: statement.totalRevenue ?? statement.operatingRevenue ?? null,
    grossProfit: statement.grossProfit ?? null,
    operatingIncome: statement.operatingIncome ?? null,
    netIncome: statement.netIncome ?? statement.netIncomeCommonStockholders ?? null,
    eps: statement.eps ?? statement.basicEps ?? null,
    currency: statement.currency?.trim() || financials.financialCurrency?.trim() || "",
  }))
    // A provider row holding only balance-sheet remnants has nothing for these columns.
    .filter((row) => [row.revenue, row.grossProfit, row.operatingIncome, row.netIncome, row.eps].some((value) => value != null))
    .slice(0, 8);
}

function newsRows(articles: NewsArticle[]) {
  return articles.map((article) => ({
    title: article.title,
    source: article.source,
    publishedAt: isoDate(article.publishedAt),
    topic: article.topic,
    tickers: article.tickers.join(","),
    url: article.url,
    importance: article.importance,
    breaking: article.isBreaking,
  }));
}

function filingRows(filings: SecFilingItem[]) {
  return filings.map((filing) => ({
    form: filing.form,
    filingDate: isoDate(filing.filingDate).slice(0, 10),
    companyName: filing.companyName ?? "",
    accessionNumber: filing.accessionNumber,
    url: filing.primaryDocumentUrl ?? filing.filingUrl,
  }));
}

function analystSummary(data: AnalystResearchData): string {
  const target = data.priceTarget;
  const currency = analystTargetCurrency(data);
  const upside = targetUpside(target);
  const analysts = recommendationTotal(data);
  const mix = formatRecommendationMix(data);
  const entries: Array<[string, string]> = [
    ["Average Target", formatAnalystPrice(target?.average, currency)],
    ["Upside", upside == null ? "-" : formatPercent(upside)],
    ["Low / Median / High", target && [target.low, target.median, target.high].some((value) => value != null)
      ? [target.low, target.median, target.high].map((value) => formatAnalystPrice(value, currency)).join(" / ")
      : "-"],
    ["Rating", formatRatingLabel(data.recommendationRating)],
    ["Analysts", analysts == null ? "-" : String(analysts)],
    ["Mix", mix],
  ];
  const populated = entries.filter(([, value]) => value !== "-");
  return populated.length > 0 ? renderStats(populated) : "";
}

function analystRows(data: AnalystResearchData) {
  return data.ratings.map((rating) => ({
    date: rating.date,
    firm: rating.firm,
    action: rating.action ?? "",
    current: rating.current ?? "",
    prior: rating.prior ?? "",
    target: rating.currentPriceTarget ?? null,
  }));
}

/** Provider values carry binary floating-point noise such as 0.26940000000000003. */
function cleanDecimal(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? "" : String(Number(value.toFixed(6)));
}

function corporateActionRows(data: CorporateActionsData) {
  const currency = /^[A-Z]{3}$/.test(data.currency ?? "") ? data.currency! : null;
  // EPS is in the reporting currency, which can differ from the listing's dividends (Tencent: CNY vs HKD).
  // An upcoming estimate carries no unit of its own; it shares the one every reported quarter states.
  const reportedCurrencies = new Set(data.earnings.map((event) => event.currency?.trim()).filter(Boolean));
  const earningsCurrency = reportedCurrencies.size === 1 ? [...reportedCurrencies][0] : undefined;
  const eps = (value: number | undefined, unit: string | undefined) => (
    value == null || !unit ? cleanDecimal(value)
      : /^[A-Z]{3}$/.test(unit) ? formatDistributionAmount(value, unit) : `${cleanDecimal(value)} ${unit}`
  );
  return [
    ...data.earnings.map((event) => {
      const unit = event.currency?.trim() || earningsCurrency;
      return {
        type: "earnings",
        date: event.date,
        // History rows are keyed by fiscal quarter end, upcoming ones by announcement date.
        detail: (event.epsActual == null ? `est ${eps(event.epsEstimate, unit)}` : `eps ${eps(event.epsActual, unit)}`)
          + (event.dateType === "fiscal-period-end" ? " (period end)" : ""),
      };
    }),
    ...data.dividends.map((event) => ({
      type: "dividend",
      date: event.exDate,
      detail: currency ? formatDistributionAmount(event.amount, currency) : cleanDecimal(event.amount),
    })),
    ...data.splits.map((event) => ({
      type: "split",
      date: event.date,
      detail: event.description ?? `${event.fromFactor ?? ""}:${event.toFactor ?? ""}`,
    })),
  ].sort((left, right) => right.date.localeCompare(left.date));
}

/**
 * After a US open, a chain whose latest trade predates it still carries the
 * prior session's quotes and volume. The delayed feed lags the open by about
 * fifteen minutes, so this is expected early in the session.
 */
function priorSessionChainWarning(chain: OptionsChain, exchange: string, now: number): string | null {
  const observed = chain.asOf ? Date.parse(chain.asOf) : Number.NaN;
  if (!Number.isFinite(observed) || (exchange && !getPublishedUsEquityCalendarYears(exchange))) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const session = getPublishedUsEquitySession(exchange || "NYSE", today);
  if (session?.kind !== "session" || now < session.open || observed >= session.open) return null;
  return `No option trades this session yet (last trade ${chain.asOf})`;
}

/** Per-share earnings to the cent, as reported; consensus averages carry more digits. */
function formatEpsCell(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "";
}

function earningsRows(events: EarningsEvent[]) {
  return events.map((event) => ({
    symbol: event.symbol,
    name: event.name,
    date: isoDate(event.earningsDate).slice(0, 10),
    // Whether the company announced the date or it is projected from past reports.
    status: earningsDateLabel(event),
    timing: event.timing,
    epsEstimate: event.epsEstimate,
    epsActual: event.epsActual,
    revenueEstimate: event.revenueEstimate,
    revenueActual: event.revenueActual,
  }));
}

/** Symbols at most whose venues a command looks up to name the company each bare one went to. */
const MAX_CHOICE_LOOKUPS = 10;

async function runQuote(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], commandName: "quote" | "compare") {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbols = normalizeSymbols(args);
  if (symbols.length === 0) ctx.fail(`Usage: gloomberb ${commandName} <symbol...>`);

  await withMarketData(ctx, async (market) => {
    // With several symbols, --exchange is for the ones that name no exchange of their own.
    const listings = await Promise.all(symbols.map((symbol) => requireCliListing(
      symbol, exchange, market, ctx, { ownExchangeWins: symbols.length > 1 },
    )));
    const targets: QuoteSubscriptionTarget[] = listings.map((listing) => ({ symbol: listing.request.symbol, exchange: listing.request.exchange }));
    // A bare symbol's venues load beside its quote, to name the company it was read as when several list it.
    // Each costs a search, so a long list (a portfolio check, not a lookup) names none.
    const venues = new Map(listings.length > MAX_CHOICE_LOOKUPS ? []
      : listings.map((listing) => [listing, loadBareVenues(listing, market)] as const));
    // So is whether a symbol changed (FB is now META), for the same lists.
    const changes = new Map(listings.length > MAX_CHOICE_LOOKUPS ? []
      : listings.map((listing) => [listing, startTickerChangeLookup(market.dataProvider, listing.symbol, listing.exchange)] as const));
    const results = await market.dataProvider.getQuotesBatch(targets, { forceRefresh: ctx.cliOptions.refresh });
    const listingOf = (result: QuoteBatchResult, index: number) => listings[targets.indexOf(result.target)] ?? listings[index]!;
    const asked = results.map(listingOf);
    const request = { command: commandName, noun: "quote" };
    const answers = await Promise.all(results.map((result, index) => {
      const listing = asked[index]!;
      return answerQuote(result, listing, market, request, ctx.cliOptions.refresh, venues.get(listing) ?? null);
    }));
    const now = Date.now();
    const tickerChanges = await Promise.all(answers.map(async ({ result }, index) => {
      const listing = asked[index]!;
      // A bare symbol read on a listing abroad (SXR8 -> XETRA) is not the US symbol the changes are of.
      if (result.quote && bareListingNote(listing, result.quote)) return null;
      return describeTickerChange(listing.symbol, await changes.get(listing)?.settle() ?? null, tradingListing(result.quote, now));
    }));
    const failed = answers[0]?.failure;
    if (listings.length === 1 && failed) {
      ctx.fail(failed.message, [tickerChangeLine(tickerChanges[0]), failed.details].filter(Boolean).join("\n") || undefined);
    }
    // A futures quote adds its dated settlement and contract terms, as `ticker` prints them; `compare` stays a table.
    const contracts = await Promise.all(answers.map(({ result }) => commandName === "quote" && result.quote
      ? cliFuturesContract(result.quote.symbol || result.target.symbol, result.quote.instrumentType)
      : null));
    // A perpetual adds its funding per eight hours and open interest, the figures PERP lists beside its mark.
    const perpetualContracts = await Promise.all(answers.map(({ result }) => commandName === "quote" && result.quote
      ? cliPerpetualContract(result.quote)
      : null));
    // Each row names its listing by key (SAN:EPA) and company, so the table needs no line above it.
    const data = answers.map(({ result, listing, failure }, index) => ({
      target: result.target,
      listing: listingMetadata(listingIdentity(listing, result.quote)),
      // The figures the table shows, beside the quote as the source sent it.
      ...getQuoteSessionFields(result.quote),
      quote: result.quote,
      ...contracts[index] ? { futuresContract: contracts[index] } : {},
      ...perpetualContracts[index] ? { perpetualContract: perpetualContracts[index] } : {},
      error: failure?.oneLine ?? errorMessage(result.error),
      ...yieldIndexFields(result),
      ...tickerChanges[index] ? { tickerChange: tickerChanges[index] } : {},
    }));
    const notes = [
      // FB now lists another security; the company that was FB trades as META. A symbol a
      // company renamed into (META) is what was typed: its change is in the row, not here.
      ...tickerChanges.flatMap((change) => tickerChangeLine(change) ?? []),
      // Which listing a bare symbol was read as, and the index a bare root is not, are in no row.
      ...answers.flatMap((answer) => answer.notes),
      // A row that stopped trading long ago reads as a quote that is merely stale.
      ...data.flatMap((row) => row.quote
        ? noLongerTradingNote(`${row.target.symbol}${row.listing.name ? ` (${row.listing.name})` : ""}`, row.quote, now) ?? []
        : []),
      // Text mode shows only "unavailable" in the cell; the JSON rows already carry each reason.
      ...ctx.cliOptions.format === "text" ? quoteNotes(data, { exchange }) : [],
    ];
    const columns = commandName === "compare" ? compareColumns() : quoteColumns();
    // Only yield indices: their change is in bp, so the text header drops the percent sign (CSV keeps the percent it holds).
    const yieldsOnly = data.length > 0 && data.every((row) => isYieldIndexSymbol(row.target.symbol));
    ctx.printResult({
      data,
      warnings: notes.length > 0 ? notes : undefined,
      freshness: quotesFreshness(data.map((row) => row.quote)),
    }, {
      rows: quoteRows,
      details: quoteFuturesContractText,
      columns,
      ...(yieldsOnly ? { textColumns: columns.map((column) => column.key === "changePercent" ? { ...column, header: "Chg" } : column) } : {}),
    });
  });
}

/**
 * Under the table, each futures row's Settle line and Contract block, worded
 * as `ticker` words them. Several symbols name theirs in the block's title.
 */
function quoteFuturesContractText(data: QuoteCliRecord[]): string {
  return data.flatMap((row) => {
    if (row.perpetualContract) {
      const stats = perpetualContractStats(row.perpetualContract);
      return [data.length > 1 ? `${renderSection(`${row.target.symbol} Contract`)}\n${renderStats(stats)}` : `${renderSection("Contract")}\n${renderStats(stats)}`];
    }
    const terms = row.futuresContract;
    if (!terms || !row.quote) return [];
    const settle: [string, string] = ["Settle", futuresSettleText(terms, row.quote)];
    const contract = futuresContractMetrics(terms, row.quote.symbol || row.target.symbol);
    if (data.length > 1) return [`${renderSection(`${row.target.symbol} Contract`)}\n${renderStats([settle, ...contract])}`];
    return [[renderStats([settle]), ...contract.length ? ["", renderSection("Contract"), renderStats(contract)] : []].join("\n")];
  }).join("\n\n");
}

/**
 * What a Cboe yield index adds to its JSON row: the level is a yield in percent
 * and its change since the previous close is in basis points (the quote's own
 * `change` is the same move in percentage points).
 */
function yieldIndexFields(result: QuoteBatchResult): { unit?: "percent"; changeBasisPoints?: number } {
  if (!isYieldIndexSymbol(result.target.symbol)) return {};
  const change = getRegularSessionDisplay(result.quote)?.change;
  return { unit: "percent", ...(change == null ? {} : { changeBasisPoints: toBasisPoints(change, 1) }) };
}

interface QuoteAnswer {
  result: QuoteBatchResult;
  /** The listing the row is: the one asked for, or the venue a bare symbol was quoted on. */
  listing: CliListing;
  /** Why there is no quote, when there is more to say than the source's own error. */
  failure?: { message: string; details?: string; oneLine: string };
  notes: string[];
}

/**
 * One symbol's row of `quote` and `compare`. A listing on an exchange its symbol
 * is not listed on says so. A bare symbol the data service read on its home
 * listing abroad names that venue (SXR8 -> XETRA). One no source quotes is
 * quoted on its listings (`quoteBareListing`), else names them, or asks for an
 * exchange when several companies list it (2222); a bare index root (VIX) also
 * names its index (^VIX), and a futures board code a security keeps (GC) its
 * future (GC=F). Venues are only looked up for a
 * symbol with no quote, so a request that succeeds costs no search.
 */
async function answerQuote(
  result: QuoteBatchResult,
  listing: CliListing,
  market: MarketContext,
  request: ListingDataRequest,
  refresh: boolean,
  venues: Promise<ListingVenue[]> | null,
): Promise<QuoteAnswer> {
  const root = listing.exchange ? null : indexRootFor(listing.symbol);
  // A bare root that quoted something else, such as MOVE (Corvex), points at the index too.
  const also = (quote: Quote) => root && quote.instrumentType?.trim().toUpperCase() !== "INDEX"
    ? [indexRootAlsoLine(root, request.command)] : [];
  if (result.quote) {
    // "CAR = Avis Budget Group, NASDAQ (also XETRA, ASX)" names the venue too, so it replaces "SXR8 -> XETRA".
    const choice = venues ? await listingChoiceNotes(listing, market, result.quote, venues) : listingReadNotes(listing);
    const venue = choice.length > 0 ? null : bareListingNote(listing, result.quote);
    // A row saved as 247540:KRX is quoted from KOSDAQ, the board it trades on.
    const board = tradingBoardNote(listing, result.quote);
    return { result, listing, notes: [...choice, venue ?? [], board ?? [], also(result.quote)].flat() };
  }
  const notTraded = await notTradedMessage(listing, market);
  if (notTraded) return { result, listing, failure: { message: notTraded, oneLine: notTraded }, notes: [] };
  if (!isNoProviderError(result.error)) return { result, listing, notes: [] };
  const other = await quoteBareListing(listing, market, request, { refresh });
  if (other?.kind === "quoted") {
    return {
      result: { target: other.listing.request, quote: other.quote },
      listing: other.listing,
      notes: [other.note, ...also(other.quote)],
    };
  }
  // Other listings already name a futures board code's future (GC=F); with none, it is named here.
  const tryLines = [
    root ? indexRootTryLine(root, request.command) : null,
    other || listing.exchange ? null : futuresTryLine(listing.symbol, request),
  ].filter((line): line is string => !!line);
  if (!other && tryLines.length === 0) return { result: await withCurrencyPairHint(result, market), listing, notes: [] };
  const message = other?.message ?? `${listing.symbol} has no ${request.noun}.`;
  const details = [other?.details, ...tryLines].filter(Boolean).join("\n");
  const oneLine = [
    message,
    other ? `${other.heading}: ${other.listings.join(", ")}.` : "",
    ...tryLines,
  ].filter(Boolean).join(" ");
  return { result, listing, failure: { message, details, oneLine }, notes: [] };
}

/**
 * A symbol written like a currency pair that is not a ticker (USD_NGN, as some
 * FX feeds write a pair) names the listing `gloomberb search` finds nearest to
 * it, as `watchlist add` does: "Did you mean USDNGN=X (US Dollar/Nigerian
 * Naira)?". When search finds nothing near, the row keeps its own error and its
 * search hint.
 */
async function withCurrencyPairHint(result: QuoteBatchResult, market: MarketContext): Promise<QuoteBatchResult> {
  const message = errorMessage(result.error);
  const symbol = message ? notATickerSymbol(message) : null;
  if (!message || !symbol || !looksLikeCurrencyPair(symbol)) return result;
  const suggestion = await suggestListing(symbol, market);
  return suggestion ? { ...result, error: withListingSuggestion(message, describeSuggestion(suggestion)) } : result;
}

/** A crypto pair that will not load points at the crypto board. Structured formats keep the error as thrown. */
function failHistory(error: unknown, symbol: string, ctx: Parameters<CliCommandDef["execute"]>[1]): never {
  if (ctx.cliOptions.format !== "text" || !isCryptoPairSymbol(symbol)) throw error;
  return ctx.fail(errorMessage(error) ?? `No history available for ${symbol}`, CRYPTO_BOARD_HINT);
}

const HISTORY_USAGE = "history <symbol> [--range <range>]";
const HISTORY_ALL_RANGE = `ALL gives the full history the source has, up to ${historyAllRangeYears()} years`;
/** Options people reach for to ask for dates, which history answers with a range. */
const DATE_WINDOW_OPTIONS = new Set(["--from", "--to", "--start", "--end", "--since", "--until", "--date", "--start-date", "--end-date"]);
/** Options people reach for to pick a bar size, which history derives from the range. */
const BAR_SIZE_OPTIONS = new Set(["--interval", "--resolution", "--bar", "--bars", "--bar-size", "--granularity", "--timeframe", "--frequency", "--freq", "--tick", "--ticks"]);

/** The symbol `history` was given: the first word that is not an option or the value after one. */
function historySymbolArg(args: readonly string[]): string | undefined {
  return args.find((arg, index) => !arg.startsWith("-")
    && !(index > 0 && args[index - 1]!.startsWith("--") && !args[index - 1]!.includes("=")));
}

function historyOptionHint(flag: string, args: readonly string[]): string | null {
  if (DATE_WINDOW_OPTIONS.has(flag)) return `history takes a --range instead of dates: ${TIME_RANGES.join(", ")}. ${HISTORY_ALL_RANGE}.`;
  if (BAR_SIZE_OPTIONS.has(flag)) return `history serves each --range in one bar size. ${subMinuteDataMessage(historySymbolArg(args))}`;
  return null;
}

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const range = parseRange(takeOption(args, "--range"), ctx);
  const requestedExchange = takeOption(args, "--exchange");
  const raw = requireOneArg(args, HISTORY_USAGE, "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, requestedExchange, market, ctx);
    const venues = loadBareVenues(listing, market);
    const { symbol, exchange } = listing.request;
    const context = { cacheMode: ctx.cliOptions.refresh ? "refresh" as const : "default" as const };
    const load = () => market.dataProvider.getPriceHistoryWithMetadata
      ? market.dataProvider.getPriceHistoryWithMetadata(symbol, exchange, range, context)
      : market.dataProvider.getPriceHistory(symbol, exchange, range, context).then((points): PriceHistoryResult => ({ points, resolution: null }));
    const quoted = loadListingQuote(market.dataProvider, listing);
    const fate = listingFateLoader(listing, market, quoted);
    const [loaded, quote] = await Promise.all([
      loadForListing(listing, market, ctx, load, (loaded) => loaded.points.length === 0, {
        command: range === "1Y" ? "history" : `history --range ${range}`, noun: "history", fate,
      })
        .catch((error) => failHistory(error, listing.key, ctx)),
      quoted,
    ]);
    const { points, resolution } = loaded;
    const identity = listingIdentity(listing, quote);
    // Without a quote currency, the listing metadata research reads (as `ticker` does) may still state it.
    const listed = quote?.currency ? quote : await market.dataProvider.getQuoteMetadata?.(symbol, exchange).catch(() => null);
    const unit = historyUnit(listing.key, listed ?? quote);
    const traded = {
      listing: listing.key, exchange: quote?.listingExchangeName || exchange || undefined, instrumentType: quote?.instrumentType,
    };
    // A coin's volume is traded value in its quote currency: said in every row and on the status line.
    const volume = historyVolume(unit, traded);
    const data = historyRows(points, resolution, unit.currency, unit.unit, volume);
    const interval = data[0]?.interval ?? null;
    const decimals = historyPriceDecimals(data, listing.saved?.metadata.assetCategory);
    const price = (value: unknown) => typeof value === "number" ? value.toFixed(decimals) : "";
    // Intraday bars print in UTC, as the charts and time and sales label them, not the host zone.
    const intraday = data.some((row) => row.date.length > 10);
    // A bar history: dated by its last bar, stale once bars of its size stop arriving.
    const freshness = rowsFreshness(data, {
      ...barHistoryFreshness(intraday ? null : barResolutionFromDates(data.map((row) => row.date))),
      observedKey: "date",
      oldest: null,
      // Bars stop arriving on the listing's own trading days, not New York's.
      cadenceExchange: quote?.listingExchangeName || exchange || undefined,
      ...(volume ? { note: historyVolumeText(volume, interval) } : {}),
    });
    const gaps = historyGapNote(data, traded);
    const notes = [
      // FB's bars are the fund listed there now; META's from 2021 are from when it was FB.
      ...listingFateNotes(await fate(), { served: data.length > 0, firstDate: data[0]?.date }),
      ...await listingChoiceNotes(listing, market, quote, venues),
      ...historyNotes(range, interval, data[0]?.date), historyCoverageWarning(range, loaded) ?? [],
      gaps ?? [], historyJumpNote(data) ?? [], historyFlagNote(data) ?? [], historyBarStatusNote(data) ?? [],
    ].flat();
    const priceColumns: CliResultColumn[] = [
      intraday
        ? { key: "date", header: "Time", format: (value) => typeof value === "string" ? formatUtcTime(value) : "" }
        : { key: "date", header: "Date" },
      { key: "open", header: "Open", align: "right", format: price },
      { key: "high", header: "High", align: "right", format: price },
      { key: "low", header: "Low", align: "right", format: price },
      { key: "close", header: "Close", align: "right", format: price },
      { key: "volume", header: "Volume", align: "right", format: formatCountCell },
    ];
    // Text shows a flag only on a bar that has one; the column is dropped when none does.
    const flagColumn: CliResultColumn = {
      key: "flag", header: "Flag", format: (value) => typeof value === "string" ? cliStyles.warning(value) : "",
    };
    // Text also marks a bar still forming or rebuilt from hourly bars there; exports keep them as their own fields.
    const flagTextColumn: CliResultColumn = {
      ...flagColumn,
      format: (value, row) => [
        typeof value === "string" ? cliStyles.warning(value) : "",
        row.partial ? cliStyles.muted("partial") : "",
        row.filled ? cliStyles.muted("filled") : "",
      ].filter(Boolean).join(" "),
    };
    const marked = data.some((row) => row.partial || row.filled);
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        range,
        resolution,
        requestedRange: range,
        currency: unit.currency,
        unit: unit.unit,
        interval,
        firstDate: data[0]?.date ?? null,
        lastDate: data.at(-1)?.date ?? null,
        // The first bar after the last gap or jump; the first bar when there is none.
        unbrokenFrom: historyUnbrokenFrom(data) ?? data[0]?.date ?? null,
        bars: data.length,
        asOf: freshness?.asOf ?? null,
        ...(volume ? { volumeUnit: volume.unit, volumePeriod: interval === "1d" ? "UTC day" : interval } : {}),
      },
      ...(notes.length > 0 ? { warnings: notes } : {}),
      freshness,
    }, {
      heading: `${listingHeading(identity)}\n${cliStyles.muted(historyFacts(unit, data).join("  ·  "))}`,
      dateKey: "date",
      textColumns: [...priceColumns, flagTextColumn],
      // Every exported row says its currency, what a price is in and its bar size, so it survives head and concatenation.
      columns: [
        ...priceColumns,
        { key: "currency", header: "Currency" },
        { key: "unit", header: "Unit" },
        { key: "interval", header: "Interval" },
        flagColumn,
        ...marked ? [{ key: "partial", header: "Partial" }, { key: "filled", header: "Filled" }] : [],
        ...volume ? [{ key: "volumeUnit", header: "Volume unit" }, { key: "volumeNote", header: "Volume note" }] : [],
      ],
    });
  });
}

type FinancialsView = "statements" | "fundamentals" | "valuation";

const STATEMENT_COLUMNS: CliResultColumn<ReturnType<typeof financialStatementRows>[number]>[] = [
  { key: "date", header: "Date" },
  { key: "revenue", header: "Revenue", align: "right", format: (value) => value == null ? "" : formatCompact(Number(value)) },
  { key: "grossProfit", header: "Gross", align: "right", format: (value) => value == null ? "" : formatCompact(Number(value)) },
  { key: "operatingIncome", header: "Op Inc", align: "right", format: (value) => value == null ? "" : formatCompact(Number(value)) },
  { key: "netIncome", header: "Net Inc", align: "right", format: (value) => value == null ? "" : formatCompact(Number(value)) },
  { key: "eps", header: "EPS", align: "right", format: (value) => value == null ? "" : formatPerShareNumber(Number(value)) },
  { key: "currency", header: "Cur" },
];

async function runFinancials(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], view: FinancialsView) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const sectionFlag = args.some((arg) => arg === "--section" || arg.startsWith("--section="));
  const section = takeOption(args, "--section");
  const commandName = view === "statements" ? "financials" : view;
  const tabular = ctx.cliOptions.format === "csv" || ctx.cliOptions.format === "ndjson";
  if (sectionFlag && !tabular) ctx.fail("--section picks one table of --csv or --ndjson output.");
  if (sectionFlag && !section?.trim()) ctx.fail("--section needs a section title or number.");
  const raw = requireOneArg(args, `${commandName} <symbol>`, "symbol", ctx);
  const selectTables = (tables: CliReportTables) => {
    try {
      return selectReportTables(tables, section);
    } catch (error) {
      return ctx.fail(error instanceof Error ? error.message : String(error));
    }
  };
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const venues = loadBareVenues(listing, market);
    const financials = await loadForListing(listing, market, ctx, () => market.dataProvider.getTickerFinancials(
      listing.request.symbol, listing.request.exchange, { cacheMode: ctx.cliOptions.refresh ? "refresh" : "default" },
    ), undefined, { command: commandName, noun: commandName === "valuation" ? "valuation data" : commandName });
    const identity = listingIdentity(listing, financials.quote);
    const choice = await listingChoiceNotes(listing, market, financials.quote, venues);
    const data: FinancialsCliData = {
      symbol: listing.key,
      exchange: identity.exchange,
      providerId: financials.quote?.providerId ?? null,
      ...financials,
    };
    if (view !== "statements") {
      const freshness = fundamentalsFreshness(financials);
      ctx.printResult({
        // JSON reads a multiple over a loss as null with its reason, never as a number.
        data: { ...data, fundamentals: exportedFundamentals(data.fundamentals) },
        freshness,
        ...(choice.length > 0 ? { warnings: choice } : {}),
      }, {
        text: () => renderFundamentalsReport(data, view),
        ...(tabular ? { tables: selectTables(fundamentalsReportTables(data, view, freshness)) } : {}),
      });
      return;
    }
    const rows = financialStatementRows(data);
    const freshness = rowsFreshness(rows, {
      ...REPORTED_DATA, basis: "financial statements", observedKey: "date", oldest: null,
    });
    // NDJSON keeps the raw statement rows it always wrote; CSV gets the table and its closing lines.
    const tables = tabular
      ? selectTables({
        tables: [exportRowsTable("Annual statements", STATEMENT_COLUMNS, rows)],
        footer: reportFooterLines({ freshness }),
      })
      : undefined;
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        providerId: financials.quote?.providerId,
        annualStatements: financials.annualStatements.length,
        quarterlyStatements: financials.quarterlyStatements.length,
        fundamentals: exportedFundamentals(financials.fundamentals),
        profile: financials.profile,
      },
      freshness,
      ...(choice.length > 0 ? { warnings: choice } : {}),
    }, {
      heading: listingHeading(identity),
      rows: () => rows,
      columns: STATEMENT_COLUMNS,
      ...(tables && ctx.cliOptions.format === "csv" ? { tables } : {}),
    });
  });
}

const NEWS_COLUMNS = [
  // UTC with the zone named, as every CLI time prints, rather than the host zone unlabeled.
  {
    key: "publishedAt",
    header: "Published",
    format: (value: unknown) => typeof value === "string" ? formatUtcTime(value) : "",
  },
  { key: "source", header: "Source", maxWidth: 20 },
  { key: "title", header: "Title" },
  { key: "tickers", header: "Tickers", maxWidth: 16 },
  { key: "url", header: "URL", optional: true },
];

/** Stories matching text, printed as a symbol's news is, under a line saying what they match. */
async function printNewsSearch(
  text: string,
  articles: NewsArticle[],
  { reason, empty }: { reason?: string; empty?: string },
  ctx: Parameters<CliCommandDef["execute"]>[1],
) {
  ctx.printResult({
    data: articles,
    metadata: { ticker: null, search: text, feed: null },
    freshness: rowsFreshness(newsRows(articles), cloudNewsFreshness(await cloudRealtimeAccess())),
  }, {
    heading: newsSearchHeading(text, reason),
    rows: newsRows,
    columns: NEWS_COLUMNS,
    empty: empty ?? `No stories match "${text}".`,
  });
}

async function runNews(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const feed = parseNewsFeed(takeOption(args, "--feed"));
  const exchangeOption = takeOption(args, "--exchange");
  // Stories come newest first, so the newest n are the first n either way.
  const limit = ctx.cliOptions.tail ?? ctx.cliOptions.limit ?? 20;
  const text = newsSearchText(args);
  if (text != null) {
    if (exchangeOption || feed) ctx.fail(`${exchangeOption ? "--exchange" : "--feed"} goes with a symbol, not with text to search stories for.`, "Usage: gloomberb news <query>");
    const problem = newsSearchTextProblem(text);
    if (problem) ctx.fail(problem);
    await printNewsSearch(text, await searchNewsStories(text, limit), {}, ctx);
    return;
  }
  if (exchangeOption && !args[0]) ctx.fail("--exchange needs a symbol: gloomberb news <symbol> --exchange <code>");
  await withMarketData(ctx, async (market) => {
    const listing = args[0] ? await requireCliListing(args[0], exchangeOption, market, ctx) : null;
    const loadNews = () => market.dataProvider.getNews({
      feed: feed ?? (listing ? "ticker" : "latest"),
      // Still set for news plugins that read the deprecated scope.
      scope: listing ? "ticker" : "global",
      ticker: listing?.request.symbol,
      exchange: listing?.request.exchange || undefined,
      limit,
    });
    const [articles, quote] = await Promise.all([
      listing ? loadForListing(listing, market, ctx, loadNews, (found) => found.length === 0) : loadNews(),
      listing ? loadListingQuote(market.dataProvider, listing) : null,
    ]);
    const identity = listing ? listingIdentity(listing, quote) : null;
    const resolved = quote !== null || identity?.name != null;
    // A bare word no listing answers to is text, and so is a futures board code (TTF), which resolves
    // to its future: news is filed under company tickers, so the stories that mention the word are the news.
    const word = listing && !listing.exchange && !feed && articles.length === 0 ? newsFallbackText(args[0]!) : null;
    const futuresCode = !!word && !!bareFuturesCode(word) && isFuturesInstrument(listing!.symbol, quote?.instrumentType);
    const reason = !resolved ? "no ticker by that name" : futuresCode ? "a futures code, not a ticker" : null;
    const emptyMessage = (searched: boolean) => listing && identity
      ? newsEmptyMessage(searched && word ? word : listing.symbol, listingTitle(identity), quote, resolved, searched)
      : undefined;
    if (word && reason) {
      // The lookup that found no ticker already answered; a search that fails leaves that answer.
      const found = await searchNewsStories(word, limit).catch(() => []);
      await printNewsSearch(word, found, { reason, empty: emptyMessage(true) }, ctx);
      return;
    }
    const empty = emptyMessage(false);
    const read = listing ? listingReadNotes(listing) : [];
    ctx.printResult({
      data: articles,
      ...(read.length > 0 ? { warnings: read } : {}),
      metadata: { ticker: listing?.key ?? null, ...(identity ? listingMetadata(identity) : {}), feed: feed ?? null },
      freshness: rowsFreshness(newsRows(articles), cloudNewsFreshness(await cloudRealtimeAccess())),
    }, {
      ...(identity ? { heading: listingHeading(identity) } : {}),
      rows: newsRows,
      columns: NEWS_COLUMNS,
      ...(empty ? { empty } : {}),
    });
  });
}

const FILING_COLUMNS = [
  { key: "filingDate", header: "Date" },
  { key: "form", header: "Form" },
  { key: "companyName", header: "Company", maxWidth: 24 },
  { key: "url", header: "URL", optional: true },
];

/** The US listing the SEC files a symbol under, from the symbol's venues: NYSE for SAN's Banco Santander. */
async function registrantUsExchange(market: MarketContext, symbol: string, registrantName: string): Promise<string | null> {
  const venues = (await listingVenues(symbol, market).catch(() => []))
    .filter((venue) => !nonUsSecListingVenue(symbol, venue.exchange) && !areDifferentCompanies(venue.name, registrantName));
  return (venues.find((venue) => isUsListingExchange(venue.exchange)) ?? venues[0])?.exchange ?? null;
}

async function runFilings(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  // Filings come newest first, so --tail asks for the same first n as --limit.
  const count = parsePositiveInt(takeOption(args, "--count"), ctx.cliOptions.tail ?? ctx.cliOptions.limit ?? 15, "Count", ctx);
  const exchangeOption = takeOption(args, "--exchange");
  const form = takeOption(args, "--form")?.trim() || null;
  const raw = requireOneArg(args, "filings <symbol> [--count <n>] [--form <form>]", "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const venues = loadBareVenues(listing, market);
    const { symbol, exchange } = listing.request;
    // A listing outside the US sends its company to the lookup, which needs its quote first.
    const quotePromise = loadListingQuote(market.dataProvider, listing);
    const identity = nonUsSecListingVenue(symbol, exchange) ? listingIdentity(listing, await quotePromise) : null;
    try {
      const context = identity?.name ? { listingName: identity.name } : undefined;
      const [filings, quote] = await Promise.all([
        loadForListing(listing, market, ctx, () => form
          // A form filter searches every filing the service lists for the issuer, as the SEC pane does.
          ? market.dataProvider.getSecFilings(symbol, SEC_FILING_FETCH_LIMIT, exchange, context)
            .then((all) => all.filter((filing) => filingFormMatches(filing.form, form)).slice(0, count))
          : market.dataProvider.getSecFilings(symbol, count, exchange, context),
        (found) => found.length === 0),
        quotePromise,
      ]);
      const resolved = identity ?? listingIdentity(listing, quote);
      const choice = await listingChoiceNotes(listing, market, quote, venues);
      ctx.printResult({
        data: filings,
        metadata: { ...listingMetadata(resolved), ...(form ? { form } : {}) },
        freshness: rowsFreshness(filingRows(filings), { ...SEC_FILINGS, observedKey: "filingDate" }),
        ...(choice.length > 0 ? { warnings: choice } : {}),
      }, {
        heading: listingHeading(resolved),
        rows: filingRows,
        columns: FILING_COLUMNS,
        // A listing abroad is looked up by its company: none found means the company files nothing with the SEC.
        empty: form ? `No ${form} filings found for ${listingTitle(resolved)}.`
          : identity ? noSecReportsNotice(resolved)
          : `No SEC filings found for ${listingTitle(resolved)}.`,
      });
    } catch (error) {
      if (!(error instanceof SecRegistrantMismatchError)) throw error;
      // Another company's filings never show under this listing; say whose they were.
      const message = secRegistrantMismatchMessage(
        error.listing, error.registrantName, await registrantUsExchange(market, error.listing.symbol, error.registrantName),
      );
      const resolved = identity ?? listingIdentity(listing, await quotePromise);
      ctx.printResult({
        data: [] as SecFilingItem[],
        metadata: { ...listingMetadata(resolved), secRegistrant: error.registrantName },
        warnings: ctx.cliOptions.format === "text" ? undefined : [message],
      }, { rows: filingRows, columns: FILING_COLUMNS, empty: message });
    }
  });
}

type Form4Insiders = "available" | "none" | "foreign-private-issuer" | "no-sec-reports";

/**
 * Whether the company has Form 4 filings of its own, read as `fn INS` reads
 * them; null when they could not be read. A listing abroad the SEC lists
 * nothing for files no SEC reports at all.
 */
async function loadForm4Insiders(market: MarketContext, listing: CliListing): Promise<Form4Insiders | null> {
  try {
    const { parsed, foreignPrivateIssuer, noFilings } = await loadParsedInsiderFilings(market.dataProvider, listing.request.symbol, {
      limit: 1,
      exchange: listing.request.exchange,
    });
    if (parsed.length > 0) return "available";
    if (noFilings && nonUsSecListingVenue(listing.request.symbol, listing.request.exchange)) return "no-sec-reports";
    return foreignPrivateIssuer ? "foreign-private-issuer" : "none";
  } catch {
    return null;
  }
}

/**
 * Holder lists name institutions and funds; individual insiders rarely appear.
 * The insider share of the company is reported either way, so say it. The
 * Form 4 trades are pointed to only when the company has some; otherwise the
 * line says why there are none, in the words `fn INS` uses.
 */
function insiderSummary(
  data: HolderData,
  ownerTypes: Set<string>,
  listing: Pick<CliListing, "key">,
  identity: ListingIdentity,
  form4: Form4Insiders | null,
): string {
  const held = data.summary?.insidersPercentHeld;
  const share = held == null || !Number.isFinite(held)
    ? ""
    : `Insiders hold ${formatFractionPercentCell(held)} of shares outstanding.`;
  const listed = data.holders.some((holder) => ownerTypes.has(holder.ownerType));
  // The listing as the command read it (CAR:ASX), not the source's spelling of it (CAR.AX), which fn does not take.
  const transactions = form4 === "available"
    ? listed ? "" : `Form 4 transactions: gloomberb fn INS ${listing.key}`
    : form4 === "no-sec-reports" ? noSecReportsNotice(identity)
    : form4 ? insiderEmptyNotice(form4 === "foreign-private-issuer") : "";
  return [share, transactions].filter(Boolean).join("\n");
}

/** `holders --form 13d|13g|all`: the 13D/13G beneficial owners, joined by name to the 13F holders. */
async function printBeneficialOwners(
  listing: CliListing,
  market: MarketContext,
  form: Exclude<HolderForm, "13f">,
  history: boolean,
  ctx: Parameters<CliCommandDef["execute"]>[1],
) {
  const { symbol, exchange } = listing.request;
  // A listing outside the US sends its company to the lookup, which needs its quote first.
  const quotePromise = loadListingQuote(market.dataProvider, listing);
  const abroad = nonUsSecListingVenue(symbol, exchange) ? listingIdentity(listing, await quotePromise) : null;
  const request = { form: beneficialRouteForm(form), history, listing: { exchange, name: abroad?.name ?? undefined } };
  const [payload, holders, quote, financials] = await Promise.all([
    loadForListing(listing, market, ctx, () => fetchBeneficialOwners(symbol, request)),
    market.dataProvider.getHolders?.(symbol, exchange).catch(() => null) ?? null,
    quotePromise,
    // Today's share count, which the filed percents are set against.
    market.dataProvider.getTickerFinancials(symbol, exchange).catch(() => null),
  ]);
  const identity = listingIdentity(listing, quote);
  const sharesOutstanding = classSharesToday(financials);
  const rows = buildBeneficialReportRows(payload, { history, holders, sharesOutstanding });
  const notices = beneficialCoverageNotices(payload.coverage);
  const legend = beneficialReportLegend(rows, sharesOutstanding);
  ctx.printResult({
    data: rows,
    ...(notices.length ? { warnings: notices } : {}),
    metadata: {
      ...listingMetadata(identity),
      name: identity.name ?? (payload.companyName || null),
      cik: payload.cik || null,
      form,
      history,
      asOf: payload.asOf,
      coverage: payload.coverage,
      complete: beneficialListComplete(payload),
      sharesOutstanding,
    },
  }, {
    heading: `${listingHeading(identity)}${cliStyles.muted(beneficialListFacts(payload, form, rows.length, history).map((fact) => `  ·  ${fact}`).join(""))}`,
    // Text draws each column as the HDS report does; CSV and JSON keep the raw values.
    textColumns: BENEFICIAL_REPORT_COLUMNS.map((column) => ({ ...column, format: column.textFormat ?? column.format })),
    ...(legend ? { footnote: legend } : {}),
    columns: [
      ...BENEFICIAL_REPORT_COLUMNS.map(({ key, header, align }) => ({ key, header, ...(align ? { align } : {}) })),
      { key: "otherPersons", header: "Other persons" },
      { key: "status", header: "Status" },
      { key: "filerCik", header: "Filer CIK" },
      { key: "accessionNumber", header: "Accession" },
      { key: "filingUrl", header: "URL" },
    ],
    empty: beneficialListUnreadable(payload)
      ? `13D/13G filings for ${listingTitle(identity)} are listed but could not be read.`
      // The SEC knows no company for a listing abroad that files there under no name of its own.
      : abroad && !payload.cik ? noSecReportsNotice(identity)
      : `No 13D/13G filings in the last 4 years for ${listingTitle(identity)}.`,
  });
}

async function runHolders(
  rawArgs: string[],
  ctx: Parameters<CliCommandDef["execute"]>[1],
  commandName: string,
  ownerTypes?: Set<string>,
) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const formOption = commandName === "holders" ? takeOption(args, "--form") : undefined;
  const history = commandName === "holders" && takeFlag(args, "--history");
  const raw = requireOneArg(args, `${commandName} <symbol>`, "symbol", ctx);
  const form = formOption == null ? "13f" : parseHolderForm(formOption);
  if (!form) ctx.fail(`Unknown form "${formOption}".`, `Use one of ${HOLDER_FORMS.join(", ")}.`);
  if (form === "13f" && history) ctx.fail("--history lists 13D/13G reports.", "Add --form 13d, 13g or all.");
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    if (form !== "13f") return printBeneficialOwners(listing, market, form, history, ctx);
    const insiderCommand = commandName === "insider" && ownerTypes != null;
    const venues = loadBareVenues(listing, market);
    const [data, quote, form4] = await Promise.all([
      loadForListing(
        listing, market, ctx,
        () => market.dataProvider.getHolders(listing.request.symbol, listing.request.exchange),
        (found) => found.holders.length === 0,
        { command: commandName, noun: "holder data" },
      ),
      loadListingQuote(market.dataProvider, listing),
      insiderCommand ? loadForm4Insiders(market, listing) : null,
    ]);
    const identity = listingIdentity(listing, quote);
    const choice = await listingChoiceNotes(listing, market, quote, venues);
    // A London line's values can be dollars from the 13F filings; the listing's currency is not their unit.
    const valueCurrency = holderValueCurrency(data, "USD")!;
    // The rows, their units and their order are HDS's, so `holders --csv` and `fn HDS --csv` agree.
    const rows = holderReportRows(data, {
      marketCap: holderStakeMarketCap(quote?.marketCap, quote?.currency, valueCurrency),
      ownerTypes,
    });
    const shownRows = windowRows(rows, ctx.cliOptions).rows;
    const shown = shownRows.length;
    const institutional = !ownerTypes?.has("insider");
    const total = institutional ? data.summary?.institutionsCount ?? null : null;
    const reportDate = sharedReportDate(rows);
    const valueBasis = rows.length > 0 ? holderValueBasis(reportDate, data.valueBasis, valueCurrency) : null;
    const positionsBasis = rows.length > 0 ? nonUsHolderCaveat(identity.exchange || data.exchange, data.currency) : null;
    const shareBasisNote = holderShareBasisNote(data, rows);
    const markedRows = rows.some((row) => holderShareBasisMarker(row));
    // The heading names the listing; its unit, date and how much of the list follows on the same line.
    // One "as of" only when every row shown is of that date; each row carries its own.
    const facts = holderListFacts({
      currency: valueCurrency,
      listingCurrency: data.currency,
      period: holderListPeriod(shownRows, data.asOf),
      shown,
      reported: rows.length,
      total,
      ranked: !positionsBasis,
    });
    const unvaluedNote = unvaluedHoldersNote(shownRows);
    const columns = holderReportColumns(shownRows, valueCurrency);
    // Dated as HDS dates it: by the list's as-of.
    const freshness = rowsFreshness(shownRows, { ...SEC_FILINGS, basis: "13F filings" }, { asOf: data.asOf ?? null });
    // Named as fn HDS takes it, so the closing notes point to the same listing.
    const requested = exchangeOption && !raw.includes(":") ? `${raw}:${exchangeOption.toUpperCase()}` : raw;
    const { notices } = holderReportNotices({ data, requested, shown: shownRows, reported: rows.length, total });
    ctx.printResult({
      data: rows,
      ...(freshness ? { freshness } : {}),
      metadata: {
        ...listingMetadata(identity),
        summary: data.summary ?? null,
        currency: data.currency ?? null,
        valueCurrency,
        units: holderReportUnits(valueCurrency),
        asOf: data.asOf ?? null,
        // Each holder's latest period; several when the list mixes quarters.
        reportDates: holderReportDates(shownRows),
        shown,
        reported: rows.length,
        total,
        truncated: shown < (total ?? rows.length),
        valueBasis,
        positionsBasis,
        ...(insiderCommand ? { form4Insiders: form4 } : {}),
      },
      ...(choice.length > 0 ? { warnings: choice } : {}),
    }, {
      heading: `${listingHeading(identity)}${cliStyles.muted(facts.map((fact) => `  ·  ${fact}`).join(""))}`,
      columns,
      textColumns: [
        { key: "ownerType", header: "Type" },
        { key: "name", header: "Holder" },
        { key: "reportDate", header: "Date" },
        { key: "shares", header: "Shares", align: "right", format: formatCountCell },
        // Marks the rows of a home line held as receipts; absent when no row is.
        ...(markedRows ? [{ key: "shareBasis", header: "Basis", value: (row: Record<string, unknown>) => holderShareBasisMarker(row) }] : []),
        {
          key: "value",
          header: moneyColumnHeader("Value", valueCurrency),
          align: "right",
          value: (row) => row.value == null ? "" : formatCompact(Number(row.value)),
        },
        {
          key: "percentHeld",
          header: "% Held",
          align: "right",
          format: (value) => isFiniteNumber(value) ? formatPercentHeld(value) : "",
        },
      ],
      // CSV and NDJSON are the HDS report's table and closing lines.
      tables: {
        tables: [exportRowsTable("Holders", columns, shownRows)],
        footer: reportFooterLines({ freshness, notes: notices }),
      },
      summary: () => [
        [valueBasis ? `Value = ${valueBasis}.` : "", positionsBasis ?? "", shareBasisNote ?? "", unvaluedNote ?? ""].filter(Boolean).join(" "),
        insiderCommand ? insiderSummary(data, ownerTypes, listing, identity, form4) : "",
      ].filter(Boolean).join("\n"),
      empty: `No holders reported for ${listingTitle(identity)}.`,
    });
  });
}

async function runAnalyst(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const raw = requireOneArg(args, "analyst <symbol>", "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const venues = loadBareVenues(listing, market);
    const [data, quote] = await Promise.all([
      loadForListing(
        listing, market, ctx, () => market.dataProvider.getAnalystResearch(listing.request.symbol, listing.request.exchange),
        undefined, { command: "analyst", noun: "analyst research" },
      ),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    const choice = await listingChoiceNotes(listing, market, quote, venues);
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        recommendationRating: data.recommendationRating,
        priceTarget: data.priceTarget,
        recommendations: data.recommendations,
      },
      freshness: rowsFreshness(analystRows(data), {
        ...REPORTED_DATA, basis: "analyst ratings", observedKey: "date", oldest: null,
      }, { stale: data.stale === true }),
      ...(choice.length > 0 ? { warnings: choice } : {}),
    }, {
      heading: listingHeading(identity),
      rows: analystRows,
      summary: analystSummary,
      columns: [
        { key: "date", header: "Date" },
        { key: "firm", header: "Firm" },
        { key: "action", header: "Action" },
        { key: "current", header: "Current" },
        { key: "target", header: "Target", align: "right" },
      ],
    });
  });
}

async function runEvents(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  // A central bank's name means the bank, not a listing that shares it; a venue still reaches the listing.
  const bank = exchangeOption ? null : centralBankEventsMessage(args.join(" "));
  if (bank) ctx.fail(bank);
  const raw = requireOneArg(args, "events <symbol>", "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const venues = loadBareVenues(listing, market);
    const [data, quote] = await Promise.all([
      loadForListing(
        listing, market, ctx, () => market.dataProvider.getCorporateActions(listing.request.symbol, listing.request.exchange),
        undefined, { command: "events", noun: "corporate events" },
      ),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    const choice = await listingChoiceNotes(listing, market, quote, venues);
    ctx.printResult({
      data,
      metadata: listingMetadata(identity),
      freshness: rowsFreshness(corporateActionRows(data), {
        ...REPORTED_DATA, basis: "corporate actions", observedKey: "date", oldest: null,
      }),
      ...(choice.length > 0 ? { warnings: choice } : {}),
    }, {
      heading: listingHeading(identity),
      rows: corporateActionRows,
      columns: [
        { key: "date", header: "Date" },
        { key: "type", header: "Type" },
        { key: "detail", header: "Detail" },
      ],
    });
  });
}

async function runOptions(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const leapsOptions = takeLeapsOptions(args);
  const expiration = takeOption(args, "--expiration");
  const exchangeOption = takeOption(args, "--exchange");
  if (leapsOptions.leaps) {
    if (expiration != null || rawArgs.includes("--expiration")) {
      ctx.fail("--leaps reads every expiry more than a year out; drop --expiration.", `Usage: gloomberb ${LEAPS_USAGE}`);
    }
    const criteria = parseLeapsCriteria(leapsOptions.raw);
    if ("error" in criteria) ctx.fail(criteria.error, `Usage: gloomberb ${LEAPS_USAGE}`);
    const symbols = normalizeSymbols(args);
    if (symbols.length === 0) ctx.fail("--leaps needs at least one symbol.", `Usage: gloomberb ${LEAPS_USAGE}`);
    await withMarketData(ctx, (market) => runLeapsScreen(symbols, exchangeOption, criteria, market, ctx));
    return;
  }
  if (leapsOptions.given.length > 0) {
    ctx.fail(`${leapsOptions.given.join(", ")} only ${leapsOptions.given.length > 1 ? "apply" : "applies"} with --leaps.`, `Usage: gloomberb ${LEAPS_USAGE}`);
  }
  const raw = requireOneArg(args, OPTIONS_USAGE, "symbol", ctx);
  let expirationDate: number | undefined;
  if (expiration != null || rawArgs.includes("--expiration")) {
    const parsed = expiration == null ? null : parseOptionExpiration(expiration);
    if (parsed == null) {
      ctx.fail(
        expiration == null ? "--expiration needs a date." : `Invalid --expiration "${expiration}".`,
        `Use YYYY-MM-DD (2028-01-21) or Unix seconds (1832025600).\nUsage: gloomberb ${OPTIONS_USAGE}`,
      );
    }
    expirationDate = parsed;
  }
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const { symbol, exchange } = listing.request;
    const refresh = ctx.cliOptions.refresh;
    const venues = loadBareVenues(listing, market);
    const quotePromise = loadListingQuote(market.dataProvider, listing);
    const fate = listingFateLoader(listing, market, quotePromise);
    const inputsPromise = loadOptionModelInputs(market.dataProvider, listing, quotePromise, refresh);
    const { result, chain: loaded } = await loadForListing(listing, market, ctx, async () => {
      const cached = await market.dataProvider.getCachedQuery?.("getOptionsChain", [symbol, exchange, expirationDate, undefined])
        .load({ force: refresh });
      return {
        result: cached,
        chain: cached?.value ?? await market.dataProvider.getOptionsChain(symbol, exchange, expirationDate, {
          cacheMode: refresh ? "refresh" : "default",
        }),
      };
    }, undefined, { command: "options", noun: "options chain", fate }).catch((error: unknown) => {
      if (!isOptionsUnavailableError(error)) throw error;
      // A future or commodity with no chain of its own: name the listed fund whose options stand in.
      const alternative = listedOptionsAlternative(listing.key);
      return ctx.fail(optionsUnavailableTitle(listing.key), alternative
        ? `Nearest listed alternative: ${alternative.symbol} (${alternative.name}), gloomberb options ${alternative.symbol}.`
          + ` Strategy payoffs: gloomberb fn OSA ${alternative.symbol}`
        : "Strategy payoffs on a listed underlying: gloomberb fn OSA <ticker>");
    });
    const inputs = await inputsPromise;
    if (expirationDate != null && !chainHasExpiry(loaded, expirationDate)) {
      // An unlisted date comes back as an empty chain; its own list of expiries, else the default chain's, says what to pick.
      const listed = loaded.expirationDates.length > 0 ? loaded.expirationDates : await market.dataProvider
        .getOptionsChain(symbol, exchange, undefined, { cacheMode: "default" })
        .then((fallback) => fallback.expirationDates, () => []);
      const miss = missingExpiryMessage(listing.key, expirationDate, listed);
      ctx.fail(miss.message, miss.details);
    }
    const quote = await quotePromise;
    const identity = listingIdentity(listing, quote);
    const chain = chainWithModelFigures(loaded, inputs);
    // A failed refresh falls back to the stored chain, which can be days old.
    const refreshWarning = result?.refreshError == null ? null
      : `Options refresh failed; showing the chain stored ${new Date(result.fetchedAt).toISOString()}`
        + (chain.asOf ? ` (last trade ${chain.asOf})` : "");
    const sessionWarning = refreshWarning ? null : priorSessionChainWarning(chain, identity.exchange, Date.now());
    const modelWarning = inputs.spot == null && (chain.calls.length > 0 || chain.puts.length > 0)
      ? `IV and delta need a current ${listing.key} quote; those columns are blank`
      : null;
    const listed = chain.expirationDates.length > 0 || chain.calls.length > 0 || chain.puts.length > 0;
    const warnings = [
      // FB's chain is the fund listed there now; a listing that stopped trading has none.
      ...listingFateNotes(await fate(), { served: listed }),
      ...await listingChoiceNotes(listing, market, quote, venues),
      ...[refreshWarning ?? sessionWarning, modelWarning].filter((warning): warning is string => warning != null),
    ];
    // Dated by the chain's last trade; a chain that failed to refresh is the stored one, stale.
    const freshness = rowsFreshness([], { asOf: chain.asOf ?? null }, {
      ...(chain.dataSource ? { dataSource: chain.dataSource } : {}),
      ...(chain.delayMinutes != null ? { delayMinutes: chain.delayMinutes } : {}),
      stale: refreshWarning != null,
    });
    ctx.printResult({
      data: chain,
      metadata: {
        ...listingMetadata(identity),
        expirations: chain.expirationDates,
        // What `iv` and `delta` on each contract are valued from; the provider's own impliedVolatility is left as sent.
        model: { spot: inputs.spot ?? null, dividendYield: inputs.dividendYield ?? null, rate: OPTION_MODEL_RATE },
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      freshness,
    }, {
      heading: listingHeading(identity),
      rows: optionRows,
      // Choosing an expiry needs the list; once one is chosen the table is that expiry.
      summary: (data: OptionsChain) => expirationDate == null ? formatExpiryList(data.expirationDates) : "",
      empty: `No option contracts for ${listingTitle(identity)}.`,
      columns: [
        { key: "side", header: "Side" },
        { key: "contract", header: "Contract", shrink: false },
        // The contract symbol already carries the date, so this goes first when the table is narrow.
        { key: "expiration", header: "Expiry", optional: true, dropPriority: 2 },
        { key: "strike", header: "Strike", align: "right" },
        { key: "last", header: "Last", align: "right" },
        { key: "bid", header: "Bid", align: "right", format: (_value, row) => formatOptionQuoteCell(row, "bid") },
        { key: "ask", header: "Ask", align: "right", format: (_value, row) => formatOptionQuoteCell(row, "ask") },
        { key: "iv", header: "IV", align: "right", format: formatOptionIvCell },
        { key: "delta", header: "Delta", align: "right", format: formatOptionDeltaCell },
        { key: "volume", header: "Vol", align: "right", format: formatCountCell, optional: true, dropPriority: 1 },
        { key: "openInterest", header: "OI", align: "right", format: formatCountCell, optional: true, dropPriority: 1 },
      ],
    });
  });
}

const FX_USAGE = "fx <currency> | fx <base>/<quote>";

async function runFx(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const raw = requireOneArg(rawArgs, FX_USAGE, "currency or pair", ctx);
  await withMarketData(ctx, async (market) => {
    const request = parseFxRequest(raw, market.config.baseCurrency);
    if ("error" in request) return ctx.fail(request.error, `Usage: gloomberb ${FX_USAGE}`);
    const { currency, baseCurrency } = request;
    const pair = `${currency}/${baseCurrency}`;
    const reasons = new Map<string, string>();
    const load = (code: string) => market.dataProvider.getCachedQuery("getExchangeRate", [code])
      .load({ force: ctx.cliOptions.refresh }).catch((error) => {
        const reason = providerMissReason(error);
        if (reason) reasons.set(code, reason);
        return null;
      });
    // Every rate is a cross of two USD legs; a code priced in itself needs none.
    const codes = currency === baseCurrency ? [] : [currency, baseCurrency];
    const legs = await Promise.all(codes.map(load));
    const missing = codes.filter((_code, index) => !isUsableRate(legs[index]?.value));
    if (missing.length > 0) {
      // A reason the data service gave for the first missing leg says more than the generic line.
      const reason = missing.map((code) => reasons.get(code)).find(Boolean);
      if (reason) ctx.fail(reason);
      ctx.fail(
        `Exchange rate unavailable for ${missing.join(" and ")}.`,
        `${pair} is crossed from each currency's USD rate, and none came back for ${missing.join(" or ")}. Check the ISO code.`,
      );
    }
    const rate = codes.length === 0 ? 1 : crossRate(legs[0]?.value, legs[1]?.value);
    // A cross rate is only as current as its older leg.
    const observed = legs.flatMap((leg) => leg?.asOf ?? []);
    const asOf = observed.length > 0 ? new Date(Math.min(...observed)).toISOString() : null;
    const stale = legs.some((leg) => leg != null && (leg.staleAt <= Date.now() || leg.refreshError != null));
    const row = { currency, baseCurrency, rate, asOf, stale, pair, inverse: 1 / rate };
    // The closing line dates the rate, and says when it is stale, as `fn FXC` does.
    const freshness = fxPairFreshness(new Map(codes.flatMap((code, index) => {
      const leg = legs[index];
      return leg ? [[code, {
        rate: leg.value,
        timing: { asOf: leg.asOf, staleAt: leg.staleAt, error: leg.refreshError, delayMinutes: leg.delayMinutes },
      }] as const] : [];
    })));
    ctx.printResult({ data: [row], freshness }, {
      text: () => describeFxRate(request, rate),
      columns: [
        { key: "currency", header: "Currency" },
        { key: "baseCurrency", header: "Base" },
        { key: "rate", header: "Rate", align: "right" },
        { key: "asOf", header: "As Of" },
        { key: "stale", header: "Stale" },
        { key: "pair", header: "Pair" },
        { key: "inverse", header: "Inverse", align: "right" },
      ],
    });
  });
}

async function runEarnings(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const symbols = normalizeSymbols(args);
  if (symbols.length === 0) ctx.fail("Usage: gloomberb earnings <symbol...>");
  await withCliServices(ctx, async (services) => {
    const listings = await Promise.all(symbols.map((symbol) => requireCliListing(
      symbol, exchangeOption, services, ctx, { ownExchangeWins: symbols.length > 1 },
    )));
    const keys = listings.map((listing) => listing.key);
    // Each bare symbol's venues cost a search, so a long list (a portfolio check, not a lookup) names none.
    const venues = new Map(listings.length > MAX_CHOICE_LOOKUPS ? []
      : listings.map((listing) => [listing, loadBareVenues(listing, services)] as const));
    let events: EarningsEvent[];
    try {
      events = await loadForListing(
        listings, services, ctx,
        () => services.dataProvider.getEarningsCalendar(keys),
        (found) => found.length === 0,
      );
    } catch (error) {
      const failure = earningsCalendarFailure(error, keys);
      if (failure) ctx.fail(failure);
      throw error;
    }
    const eventOf = (listing: CliListing) => events.find((event) => event.symbol.toUpperCase() === listing.key.toUpperCase());
    const [abroadNotes, choiceNotes] = await Promise.all([
      // A listing abroad with no date of its own says so, with its US line's date when that line is the same company.
      Promise.all(listings.filter((listing) => isListingAbroad(listing) && !eventOf(listing))
        .map((listing) => noListingCalendarNote(listing, services))),
      Promise.all(listings.map(async (listing) => {
        const listed = venues.get(listing);
        return listed ? earningsChoiceNote(listing, eventOf(listing), await listed) : null;
      })),
    ]);
    const noCalendar = abroadNotes.join("\n");
    // Text prints the listings without a calendar under the table; other formats carry them as warnings.
    const warnings = [
      ...listings.flatMap(listingReadNotes),
      ...choiceNotes.filter((note): note is string => !!note),
      ...ctx.cliOptions.format === "text" ? [] : abroadNotes,
    ];
    ctx.printResult({
      data: events,
      freshness: rowsFreshness(earningsRows(events), { status: "not-a-feed", basis: "calendar", observedKey: "date", oldest: null }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }, {
      rows: earningsRows,
      columns: [
        { key: "date", header: "Date" },
        { key: "status", header: "Status" },
        { key: "symbol", header: "Symbol" },
        { key: "name", header: "Name" },
        { key: "timing", header: "Timing" },
        { key: "epsEstimate", header: "EPS Est", align: "right", format: formatEpsCell },
        { key: "epsActual", header: "EPS", align: "right", format: formatEpsCell },
      ],
      ...(noCalendar ? { empty: noCalendar, footnote: noCalendar } : {}),
    });
  });
}

export const marketDataCliCommands: BuiltinCliCommandDef[] = [
  {
    name: "quote",
    description: "Show the latest price for one or more symbols",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["quote <symbol...>"],
      options: [EXCHANGE_OPTION],
      examples: ["quote AAPL MSFT NVDA", "quote SAN:EPA BHP:ASX", "quote BTC-USD EURUSD=X", "quote binance:BZUSDT", "quote AAPL --json"],
    },
    execute: (args, ctx) => runQuote(args, ctx, "quote"),
  },
  {
    name: "compare",
    description: "Compare quotes for several symbols side by side",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["compare <symbol...>"],
      options: [EXCHANGE_OPTION],
      examples: ["compare KO PEP", "compare SAN:EPA SAN:NYSE", "compare SPY QQQ IWM --csv"],
    },
    execute: (args, ctx) => runQuote(args, ctx, "compare"),
  },
  {
    name: "history",
    description: "Fetch open, high, low, close, and volume over a range",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: [HISTORY_USAGE],
      options: [
        { flags: "--range <range>", description: `${TIME_RANGES.join(", ")} (default 1Y); ${HISTORY_ALL_RANGE}` },
        EXCHANGE_OPTION,
      ],
      sections: [{
        title: "Bars",
        lines: [
          `Each range comes in one bar size: ${historyIntervalsByRange()}. The line under the heading, and the --json metadata, give the currency, the bar size actually served, the first and last bar and the bar count. A warning says when the bars are coarser, or start later, than the range asked for, and for a coin, which trades every day, names each day it has no bar for.`,
          "A bar whose prices contradict each other (high below the open or close, or low above them) is left blank and flagged, such as high<open, with the count in a warning. Every exported row (--csv, --ndjson, --json) carries currency, interval and flag.",
          "A break in the series flags the bar after it, which keeps its prices: gap after more than three months with no bar (weeks for weekly, daily and intraday bars), jump when the close is over 100 times the one before or under a hundredth of it. A warning names each break, and the heading says the date the series runs unbroken from.",
        ],
      }],
      examples: ["history AAPL", "history BHP:ASX --range 5Y", "history ZAR=X --range ALL", "history ZAR=X --tail 5", "history AAPL --range 5Y --csv > aapl.csv"],
    },
    unknownOptionHint: historyOptionHint,
    execute: runHistory,
  },
  {
    name: "options",
    description: "Fetch an options chain, or rank LEAPS across symbols",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: [OPTIONS_USAGE, LEAPS_USAGE],
      options: [
        {
          flags: "--expiration <YYYY-MM-DD|unix>",
          description: "Expiration as a date (2028-01-21) or Unix seconds; defaults to the nearest one, and lists the others",
        },
        EXCHANGE_OPTION,
        { flags: "--leaps", description: "Rank contracts more than a year out across the symbols given, as a stock replacement" },
        { flags: "--side <calls|puts>", description: `With --leaps: the side to rank (default ${DEFAULT_LEAPS_CRITERIA.side}s)` },
        {
          flags: "--delta <low-high>",
          description: `With --leaps: absolute delta band (default ${DEFAULT_LEAPS_CRITERIA.minDelta.toFixed(2)}-${DEFAULT_LEAPS_CRITERIA.maxDelta.toFixed(2)})`,
        },
        {
          flags: "--max-spread <percent>",
          description: `With --leaps: widest bid/ask spread, in percent of the midpoint (default ${DEFAULT_LEAPS_CRITERIA.maxSpreadPercent})`,
        },
        { flags: "--min-oi <contracts>", description: `With --leaps: least open interest (default ${DEFAULT_LEAPS_CRITERIA.minOpenInterest})` },
        {
          flags: "--sort <order>",
          description: "With --leaps: carry (extrinsic per year, lowest first; the default), spread, oi, delta, expiry or symbol",
        },
      ],
      sections: [{
        title: "LEAPS",
        lines: [
          "--leaps reads every expiry more than a year out for each symbol and keeps the liquid contracts in the delta band, ranked by extrinsic per year: time value (midpoint less intrinsic) as a percent of spot, per year to expiry.",
          "A symbol without LEAPS, a quote or a chain is named in a warning and the others still rank. docs/research-data.md defines each figure.",
        ],
      }],
      examples: [
        "options AAPL",
        "options AAPL --expiration 2028-01-21",
        "options AAPL:NASDAQ --json",
        "options AAPL MSFT NVDA GOOGL AMZN META --leaps",
        "options SPY QQQ --leaps --side puts --delta 0.20-0.40 --csv",
      ],
    },
    execute: runOptions,
  },
  {
    name: "provider-search",
    description: "Search instruments at the connected data providers",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["provider-search <query>"],
      examples: ["provider-search toyota"],
    },
    execute: async (args, ctx) => {
      const query = args.join(" ");
      if (!query) ctx.fail("Usage: gloomberb provider-search <query>");
      await withMarketData(ctx, async (market) => {
        const results = await market.dataProvider.search(query);
        ctx.printResult({ data: results.slice(0, ctx.cliOptions.limit ?? results.length) }, {
          textColumns: [
            { key: "symbol", header: "Symbol" },
            { key: "name", header: "Name" },
            { key: "exchange", header: "Exchange" },
            { key: "type", header: "Type" },
            { key: "currency", header: "Currency" },
            { key: "providerId", header: "Provider" },
          ],
          empty: `No instruments match "${query}".`,
        });
      });
    },
  },
  {
    name: "financials",
    description: "Fetch annual revenue, profit, and EPS",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["financials <symbol>"],
      options: [EXCHANGE_OPTION, TABLE_SECTION_OPTION],
      examples: ["financials MSFT", "financials SAN:EPA", "financials MSFT --json", "financials MSFT --csv > msft.csv"],
    },
    execute: (args, ctx) => runFinancials(args, ctx, "statements"),
  },
  {
    name: "fundamentals",
    description: "Fetch fundamentals and the company profile",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["fundamentals <symbol>"],
      options: [EXCHANGE_OPTION, TABLE_SECTION_OPTION],
      examples: ["fundamentals NVDA", "fundamentals ASML:AMS", "fundamentals NVDA --csv --section fundamentals"],
    },
    execute: (args, ctx) => runFinancials(args, ctx, "fundamentals"),
  },
  {
    name: "valuation",
    description: "Fetch market cap, enterprise value, and valuation multiples",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["valuation <symbol>"],
      options: [EXCHANGE_OPTION, TABLE_SECTION_OPTION],
      examples: ["valuation NVDA", "valuation BP:LSE", "valuation NVDA --csv"],
    },
    execute: (args, ctx) => runFinancials(args, ctx, "valuation"),
  },
  {
    name: "earnings",
    description: "Show upcoming and recent earnings dates",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["earnings <symbol...>"],
      options: [EXCHANGE_OPTION],
      examples: ["earnings AAPL MSFT GOOGL", "earnings SAN:EPA"],
    },
    execute: runEarnings,
  },
  {
    name: "events",
    description: "Fetch dividends, splits, and earnings events",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["events <symbol>"],
      options: [EXCHANGE_OPTION],
      examples: ["events KO", "events BHP:ASX"],
    },
    execute: runEvents,
  },
  {
    name: "analyst",
    description: "Fetch analyst rating changes and price targets",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["analyst <symbol>"],
      options: [EXCHANGE_OPTION],
      examples: ["analyst TSLA", "analyst SAN:EPA"],
    },
    execute: runAnalyst,
  },
  {
    name: "holders",
    description: "Fetch institutional holders, or the 13D/13G beneficial owners",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["holders <symbol> [--form 13f|13d|13g|all] [--history]"],
      options: [
        { flags: "--form <form>", description: "13f for the holder table (default); 13d, 13g or all for beneficial owners over 5%" },
        { flags: "--history", description: "With --form 13d, 13g or all, every report newest first instead of the latest per filer" },
        EXCHANGE_OPTION,
      ],
      sections: [{
        title: "Output",
        lines: [
          "Holders run largest value first, as in fn HDS. --csv and --json carry the HDS report's columns: values in the currency the header names, shares, and the quarter's change and the stake in percent (0.59 is 0.59%).",
        ],
      }],
      examples: ["holders AAPL", "holders SAN:EPA", "holders SAN --csv", "holders CAR --form all", "holders CAR --form 13g --history --json"],
    },
    execute: (args, ctx) => runHolders(args, ctx, "holders"),
  },
  {
    name: "insider",
    description: "Fetch insider holders",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["insider <symbol>"],
      options: [EXCHANGE_OPTION],
      examples: ["insider NVDA", "insider BP:LSE"],
    },
    execute: (args, ctx) => runHolders(args, ctx, "insider", new Set(["insider", "direct"])),
  },
  {
    name: "13f",
    description: "Fetch institutional and fund holders",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["13f <symbol>"],
      options: [EXCHANGE_OPTION],
      sections: [{
        title: "13F filings",
        lines: ["For each fund's reported position and its change over the quarter, run gloomberb fn 13F <symbol>."],
      }],
      examples: ["13f AAPL", "13f BP:NYSE"],
    },
    execute: (args, ctx) => runHolders(args, ctx, "13f", new Set(["institution", "fund"])),
  },
  {
    name: "filings",
    description: "Fetch recent SEC filings",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["filings <symbol> [--count <n>] [--form <form>]"],
      options: [
        { flags: "--count <n>", description: "Number of filings (default 15)" },
        { flags: "--form <form>", description: "Only this form and its amendments, such as 10-K or 13D" },
        EXCHANGE_OPTION,
      ],
      examples: ["filings AAPL", "filings BHP:ASX", "filings AAPL --count 40 --json", "filings CAR --form 13G"],
    },
    execute: runFilings,
  },
  {
    name: "news",
    description: "Fetch market headlines, news for one symbol, or stories matching text",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["news [symbol] [--feed <feed>]", "news <query>"],
      options: [
        { flags: "--feed <feed>", description: "latest, top, or breaking for market news (default latest)" },
        EXCHANGE_OPTION,
      ],
      sections: [{
        title: "Text",
        lines: [
          "Several words, in quotes or not, search the stories that mention them. So does a single word of three letters or more that no listing answers to, and a futures board code such as TTF, a gas benchmark rather than a ticker. A real ticker always gives its own news. The best matches print newest first, 20 unless --limit says otherwise; a search takes neither --feed nor --exchange.",
        ],
      }],
      examples: ["news", "news TSLA", "news SAN:EPA", "news TTF", "news \"european gas\"", "news --feed top --limit 10"],
    },
    execute: runNews,
  },
  {
    name: "fx",
    description: "Convert a currency into your base currency, or quote a pair such as USD/NGN",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["fx <currency>", "fx <base>/<quote>"],
      sections: [{
        title: "Direction",
        lines: [
          "A bare code is one unit of it in your base currency. A pair reads as markets quote it: USD/NGN is how many NGN one USD buys. Two codes neither of which is USD, such as ZAR/NGN, cross through their USD rates.",
          "The answer states both directions: 1 NGN = 0.000752791 USD  (USD/NGN 1328.39). --json, --csv and --ndjson carry rate (base currency per currency), pair, inverse, asOf and stale.",
        ],
      }],
      examples: ["fx EUR", "fx NGN", "fx USD/NGN", "fx ZAR/NGN", "fx JPY --json"],
    },
    execute: runFx,
  },
];
