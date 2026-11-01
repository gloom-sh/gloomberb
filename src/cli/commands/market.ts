import { logFailure } from "../../utils/log-failure";
import type { CliCommandDef } from "../../types/plugin";
import { TIME_RANGES, type TimeRange } from "../../time-series/range";
import { CHART_RESOLUTION_STEP_MS } from "../../time-series/resolution";
import { yearToDateStartIndex } from "../../market-data/market/year-to-date";
import type { EarningsEvent, QuoteBatchResult, QuoteSubscriptionTarget, SecFilingItem } from "../../types/data-provider";
import { companyDataNotes, type CompanyFrom } from "../../types/company-from";
import type { NewsArticle, NewsFeed, NewsQuery } from "../../news/types";
import { newsSummaryLine } from "../../news/news-model";
import { shortStoryId } from "../../news/story-id";
import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  OptionsChain,
  Quote,
  TickerFinancials,
} from "../../types/financials";
import { currencyPriceMinDigits, formatMarketPrice, formatMarketPriceWithCurrency, penceFigure, quoteFormatOptions, resolveAssetDisplayKind, withCurrencyMinorDigits } from "../../market-data/market/format";
import { INDEX_POINTS_EXPORT_UNIT, isIndexLevel, reportedQuoteVolume } from "../../market-data/market/index-level";
import { changeBasisJson, changeBasisLabel, changeBasisNote, quoteChangeBasis, quotePreviousCloseDate, quoteSettleText } from "../../market-data/market/change-basis";
import {
  EXTENDED_SESSION_LABELS,
  getExtendedSessionDisplay,
  getQuoteSessionFields,
  getRegularSessionDisplay,
  quoteHeadlineTime,
  quoteSessionLabel,
  quoteSessionStateLabel,
  type ExtendedSession,
} from "../../market-data/market/status";
import { formatCompact, formatCurrency, formatDistributionAmount, formatNumber, formatPercent } from "../../utils/format";
import { withCliServices, withMarketData } from "../context";
import { isoDate, parsePositiveInt, requireOneArg, takeFlag, takeOption } from "./command-utils";
import type { BuiltinCliCommandDef } from "../command-options";
import { CLI_COMMAND_GROUPS, TABLE_SECTION_OPTION } from "../help";
import { CLI_EXIT_CODES } from "../exit-codes";
import {
  formatChangePercentCell,
  formatCountCell,
  formatFractionPercentCell,
  formatPriceRange,
  quoteChangeText,
} from "../helpers";
import { cliArrow, cliStyles, colorBySign, renderSection, renderStats } from "../../utils/cli-output";
import { filledPeriodsNote, hasOlderStatements, stalePeriodNote, statementHistoryNotes } from "../../utils/financial-statements";
import { formatPerShareNumber } from "../../utils/reported-money";
import { isCurrencyPairListing } from "../../utils/fx-market-hours";
import {
  analystTargetCurrency,
  formatAnalystPrice,
  formatRatingLabel,
  formatRecommendationMix,
  recommendationTotal,
  analystReferenceMetadata,
  analystUpside,
  formatAnalystReference,
  ratingReason,
} from "../../plugins/builtin/research/analyst-model";
import { getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../../market-data/published-us-sessions";
import { isQuoteStaleForCurrentSession, noPrintsTodayText } from "../../market-data/quotes/freshness";
import {
  coinOptionsAlternativesText, isCoinWithoutOptions, isOptionsUnavailableError, listedOptionsAlternative, optionsUnavailableTitle,
} from "../../market-data/options-alternatives";
import {
  atReportTtmRate, cliFuturesContract, futuresContractMetrics, exportedDividendFundamentals, fundamentalsReportTables, loadDividendDistributions,
  loadReportFundFacts, renderFundamentalsReport, writesCurrencyCodes,
} from "./ticker";
import { createBaseConverter } from "../base-converter";
import { loadStatementFilings } from "../statement-filings";
import { loadBankFigures } from "../bank-section";
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import type { FuturesContractTermsPayload } from "../../api-client/futures-curve";
import { currencyCodeLabel } from "../../utils/currency-units";
import {
  futuresContractLines, futuresPricePer, futuresRollLines, isFuturesInstrument, loadUsdPerMmbtu, usdPerMmbtuText, type UsdPerMmbtu,
} from "../../market-data/futures-contract";
import {
  chainHasExpiry,
  formatExpiryList,
  loadOptionModelInputs,
  loadOptionsChainOpenInterest,
  chainCoinCurrency,
  chainHasFilledIv,
  formatCoinPremiumCell,
  formatOptionDeltaCell,
  formatOptionDollarCell,
  formatOptionGammaCell,
  formatOptionIvCell,
  formatOptionQuoteCell,
  isMarkedChain,
  MARKED_OPTION_FIELDS,
  OPTION_MODEL_RATE,
  OPTION_VOLATILITY_FIELDS,
  OPTIONS_USAGE,
  optionRows,
  optionsBasisFields,
  optionsBasisFootnote,
  parseOptionExpiration,
  takeExpirationOption,
  valueChainAtModelSpot,
  type OptionsChainBasis,
} from "./options-chain";
import {
  expirationHint, expiredExpiryText, expiryIsoDate, isLiveOptionExpiry, liveDefaultExpiry, liveOptionExpiries, missingExpiryMessage,
  OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER, optionExpiryVenue, withLiveExpiryList,
} from "../../utils/option-expiry";
import { DATE_OPTION_EXAMPLES, isoDateOption, isoDateToday } from "../../utils/calendar-date";
import { apiClient } from "../../api-client";
import { CLOUD_QUOTE_DELAY_MINUTES } from "../../api-client/plan-rules";
import type { ExchangeAnnouncementsPayload } from "../../api-client/exchange-announcements";
import { exchangeAnnouncementsPage, listsExchangeAnnouncements, type ExchangeAnnouncementsPage } from "../../utils/exchange-announcements";
import { dailyFxLeg, fxCloseOnDate, type FxCloseReading } from "../../market-data/fx-closes";
import { declaredDividends } from "../../utils/declared-dividends";
import {
  DEFAULT_LEAPS_CRITERIA, LEAPS_EXTRA_COLUMNS, LEAPS_USAGE, parseLeapsCriteria, runLeapsScreen, takeLeapsOptions,
} from "./options-leaps";
import type { CliResultColumn } from "../result";
import type { PriceHistoryResult } from "../../types/price-history";
import {
  exportNumber,
  exportRowsTable,
  reportFooterLines,
  selectReportTables,
  type CliReportTables,
} from "../report-tables";
import { historyCoverageNotice } from "../../sources/history-coverage";
import { maxDrawdownText } from "../../utils/max-drawdown";
import { isPastPriceWindow, loadPriceWindowHistory, PRICE_WINDOW_FROM_HELP, PRICE_WINDOW_TO_HELP, priceWindowText, readPriceWindow, type PriceWindow } from "../../utils/price-window";
import {
  BAR_INTERVAL_LABELS,
  closedPeriodBarDay,
  formingPeriodBar,
  historyBarStatusNote,
  venueTradingDay,
  historyCoverageWarning,
  historyExportUnit,
  historyFacts,
  historyFlagNote,
  historyWickNote,
  historyContractDrawdown,
  historyRollNote,
  historyThinNote,
  historyGapNote,
  historyJumpNote,
  historyUnbrokenFrom,
  historyAllRangeYears,
  historyIntervalsByRange,
  historyMissingVolumeNote,
  historyVenueVolumeNote,
  historyNotes,
  historyReportsVolume,
  historyPriceDecimals,
  historyRows,
  historyUnit,
  quotedPriceDivisor,
  historyVolume,
  historyVolumeBasis,
  historyVolumeNote,
  type HistoryRow,
  type HistoryUnit,
  type HistoryVolume,
} from "../history-rows";
import {
  historyExportColumns,
  historyExportStatus,
  historyFailureRow,
  oneLineFailure,
  symbolListNotes,
  type HistoryListRow,
} from "../history-export";
import { fail, isCliFailure, NO_DATA_CODE } from "../errors";
import { mapWithConcurrency } from "../../utils/concurrency";
import { MISSING_VOLUME_TEXT } from "../../utils/price-history-integrity";
import { CRYPTO_BOARD_HINT, quoteNotes } from "./crypto-hints";
import { bareFuturesCode, futuresBoardContract } from "../../market-data/futures-board";
import { commodityNamedIn, commoditySearchName } from "../../market-data/commodity-names";
import { newsEmptyMessage } from "./news-hints";
import {
  closestStoriesReason,
  commodityNewsRoute,
  commonWordCandidate,
  METALS_NEWS_TOPIC,
  metalCodeNewsRoute,
  type MetalNewsRoute,
  metalNewsHeading,
  metalNewsRoute,
  newsFallbackText,
  newsSearchHeading,
  newsSearchText,
  newsSearchTextProblem,
  noMetalStoriesMessage,
  noStoriesMessage,
  quotedSearchCommand,
  searchClosestNewsStories,
  searchNewsStories,
  wordMeansMore,
} from "./news-search";
import { formatUtcTime } from "../../utils/utc-time";
import { DAY_SO_FAR_TEXT, withSessionBar } from "../../time-series/session-bar";
import { isFiniteNumber } from "../../utils/guards";
import { exportedFundamentals } from "../../utils/price-earnings";
import { fundamentalsFreshness, fxPairFreshness, quotesFreshness, rowsFreshness, valuationFreshness } from "../freshness";
import { fxRateNotes, refreshedFxRateNotes } from "../../plugins/builtin/shared/fx-rate-freshness";
import { quoteBarNotes } from "../../market-data/quotes/intraday-bar";
import { cedearRatioText, depositaryPairText, isReceiptSide, listingCedearRatio, listingDepositaryPair } from "../../market-data/depositary-pair";
import { isPesoDollarPair, loadPesoDollarRates, pesoDollarRateLines, pesoDollarRatesJson } from "../peso-dollar-rates";
import { atRegularSessionPrice, regularSessionValuationPrice } from "../../market-data/quotes/regular-session-valuation";
import { viewMarketCapitalization } from "../../utils/market-capitalization";
import {
  barHistoryFreshness,
  barResolutionFromDates,
  cloudNewsFreshness,
  cloudRealtimeAccess,
  REPORTED_DATA,
  SEC_FILING_ROWS,
  SEC_FILINGS,
} from "../../plugins/builtin/shared/report-freshness";
import {
  earningsDateStatus,
  earningsDetailParts,
  earningsEpsBasis,
  epsBasisName,
  isProvisionalActual,
  quarterLabel,
  showsEpsBasis,
} from "../../plugins/builtin/shared/earnings-report";
import {
  calendarEventOf,
  calendarStatus,
  newYorkDay,
  resolveListingEvents,
  withResolvedEarnings,
  type ResolvedEarningsEvent,
} from "../../plugins/builtin/shared/earnings-calendar";
import {
  coinListingNotes,
  EXCHANGE_OPTION,
  listingHeading,
  listingIdentity,
  listingTitle,
  listingVenues,
  listingChoiceNotes,
  listingReadNotes,
  failUnchosenListing,
  loadBareVenues,
  loadForListing,
  loadListingQuote,
  loadListingQuoteAnswer,
  listingFateLoader,
  meantQuestion,
  movedSymbolLine,
  ListingArgError,
  isNoProviderError,
  requireCliListing,
  resolveCliListing,
  type CliListing,
  type ListingIdentity,
} from "../listing-arg";
import { currencyNameMiss, currencyNameStop } from "../currency-name-hint";
import { bareListingNote, listingFateNotes, noLongerTradingNote, SUCCESSOR_CHANGE_WAIT_MS, tradingListing } from "../../tickers/listing-fate";
import { isYieldIndexSymbol } from "../../tickers/index-roots";
import {
  analyzeTaxEquivalent, distributionBasis, loadTreasuryTenors, parseTaxRates, TAX_RATE_HELP_OPTIONS, taxEquivalentJson, type TaxRates,
} from "../../market-data/tax-equivalent";
import { CBOE_YIELD_INDEX_CLOSE } from "../../plugins/builtin/shared/treasury-cutoffs";
import { earningsCalendarFailure, earningsChoiceNote, earningsDateLabel, isListingAbroad, noListingCalendarNote, undatedListingsNote } from "../earnings-calendar";
import { formatBasisPoints, toBasisPoints } from "../../utils/basis-points";
import { providerMissReason } from "../../sources/provider-errors";
import { isNetworkFailure } from "../../utils/network-failure";
import { withSavedCopy, type ReportFreshness } from "../pane-functions/freshness";
import { isNotATickerMessage } from "../not-a-ticker";
import { primeBoardCoins } from "../board-coins";
import { suggestUsTicker, type ListingSuggestion } from "../listing-suggestion";
import { quotedPhrase, splitSymbolArgs, uniqueSecuritySymbols } from "../symbol-args";
import { isCompanyNameInput } from "../../tickers/company-name-listing";
import { readNameEntries, readPhraseArgument } from "../name-entries";
import { readSymbolList, SymbolListError } from "../symbol-list";
import { notASymbolError } from "../symbol-cells";
import { cliPerpetualContract, perpetualContractStats, type PerpetualContractPayload } from "../perpetual-contract";
import { knownGapMessage, subMinuteDataMessage } from "../known-gaps";
import { phraseSearchReport } from "./search";
import { secRegistrantMismatchMessage, SecRegistrantMismatchError, areDifferentCompanies } from "../../sources/sec-registrant";
import { isCryptoPairSymbol, isRoundTheClockCoin } from "../../utils/crypto-pair";
import { isUsListingExchange } from "../../utils/exchanges";
import {
  describeFormerIssuer, describeTickerChange, movedAwayChange, startTickerChangeLookup, tickerChangeLine, type FormerIssuer, type TickerChange,
} from "../../tickers/ticker-changes";
import { noSecReportsNotice, nonUsSecListingVenue, secFilingItemCodes } from "../../utils/sec";
import type { MarketContext } from "../types";
import { windowRows } from "../row-window";
import { answerQuote, errorMessage, notUsTickerSentence } from "../quote-answer";
import { crossRate, describeFxConversion, describeFxRate, formatFxRate, FX_USAGE, isUsableRate, parseFxArgs } from "../fx-pair";
import {
  describeShortRate,
  formatForwardPoints,
  formatRatePercent,
  formatSignedPercent,
  IMPLIED_FORWARD_LABEL,
  impliedForward,
  parseForwardTenor,
  shortRateFor,
} from "../fx-forward";
import { unavailableOnServer } from "../../plugins/builtin/shared/cloud-resource";

/** `fx`'s forward form, for its usage line. */
const FX_FORWARD_USAGE = "fx <base>/<quote> --forward <tenor>";
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
import { fundHoldersAnswer } from "../../plugins/builtin/holders/fund-holders";
import { centralBankEventsMessage } from "../central-bank-events";
import { classSharesAsOf, classSharesToday } from "../../plugins/builtin/holders/client";
import {
  HOLDER_ROWS_MAX,
  indexedHoldersPartialNote,
  indexedHolderUnits,
  indexHolderTicker,
  loadIndexedHolders,
  withIndexedHolders,
} from "../../plugins/builtin/holders/index-holders";
import { filingFormMatches, SEC_FILING_FETCH_LIMIT } from "../../plugins/builtin/sec/forms";
import { currentReportItemsLabel } from "../../utils/sec-filings";
import { INSIDER_REPORT_FILINGS, loadParsedInsiderFilings } from "../../plugins/builtin/insider/client";
import { insiderEmptyNotice, loadHomeInsiderReportsNote } from "../../plugins/builtin/insider/issuer";
import { buildInsiderSummary } from "../../plugins/builtin/insider/model";
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

/** The ranges `history` takes: the chart ranges, and YTD, which runs from the prior year's last close. */
type HistoryRange = TimeRange | "YTD";
const HISTORY_RANGES: HistoryRange[] = [...TIME_RANGES.slice(0, TIME_RANGES.indexOf("1Y")), "YTD", ...TIME_RANGES.slice(TIME_RANGES.indexOf("1Y"))];
const VALID_RANGES = new Set<HistoryRange>(HISTORY_RANGES);
const VALID_NEWS_FEEDS = new Set<NewsFeed>(["latest", "top", "breaking", "ticker", "sector", "topic"]);

type QuoteCliRecord = Omit<QuoteBatchResult, "error"> & {
  error: string | null;
  /** The listing the row is, named from its saved ticker when the quote names nothing. */
  listing?: { name: string | null };
  /** A futures row's contract, terms and latest confirmed settlement, as `ticker` reads them. */
  futuresContract?: FuturesContractTermsPayload;
  /** The quote of the root's front contract, for a futures row that prices another one (NGF27, NG2). */
  futuresFront?: Quote;
  /**
   * A per-MWh gas price (Dutch TTF) in dollars per MMBtu, the unit Henry Hub
   * trades in, converted at the day's rate: one unit of the quote's currency in dollars.
   */
  usdPerMmbtu?: UsdPerMmbtu;
  /** A perpetual row's market, funding per eight hours and open interest. */
  perpetualContract?: PerpetualContractPayload;
  /** The symbol changed: its issuer moved to another symbol, or its holder had another before. */
  tickerChange?: TickerChange;
  /** The company that last held the symbol merged into another, which trades under its own symbol now (GOGL, CMBT). */
  formerIssuer?: FormerIssuer;
  /** A bare symbol read on a listing abroad that is one slip from a US ticker: the US ticker it was most likely typed for. */
  usSuggestion?: ListingSuggestion;
};
type FinancialsCliData = TickerFinancials & {
  symbol: string;
  exchange: string;
  providerId: string | null;
};

function parseRange(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): HistoryRange {
  const range = (value ?? "1Y").toUpperCase() as HistoryRange;
  if (!VALID_RANGES.has(range)) ctx.fail(`Unknown range "${value}".`, `Use one of ${HISTORY_RANGES.join(", ")}.`);
  return range;
}

function parseNewsFeed(value: string | undefined): NewsQuery["feed"] | undefined {
  return value && VALID_NEWS_FEEDS.has(value as NewsFeed) ? value as NewsQuery["feed"] : undefined;
}

/**
 * The entries of a command's arguments (`splitSymbolArgs`), each once however
 * its case or share class was written: `AAPL aapl BRK.B BRK-B` is AAPL and
 * BRK.B. An entry with a space, from a comma list or pasted lines, keeps its
 * case: it may be a company's name, which `readSymbols` says.
 */
function normalizeSymbols(args: string[]): string[] {
  return uniqueEntries(splitSymbolArgs(args));
}

/** Each entry once, a symbol upper-cased and a company's name in its typed case. */
function uniqueEntries(entries: readonly string[]): string[] {
  return uniqueSecuritySymbols(entries.map((entry) => isCompanyNameInput(entry) ? entry : entry.toUpperCase()));
}

/**
 * The symbols to resolve: each entry with a space read as a company's name
 * when search finds one, else as its words when they are symbols
 * (`readNameEntries`), with the repeats that leaves dropped. A name stays whole.
 */
async function readSymbols(symbols: readonly string[], dataProvider: Parameters<typeof readNameEntries>[1]): Promise<string[]> {
  return uniqueEntries(await readNameEntries(symbols, dataProvider));
}

/**
 * The symbols typed, of `--file <path>` and of standard input (`-`), read by
 * the reader `watchlist add` uses, and its notes on what it left out (a
 * stray separator, the prices beside the symbols, in one line). Standard
 * input is read only when asked for, so a script that pipes in nothing never
 * waits on it.
 */
async function readListedSymbols(
  args: readonly string[],
  file: string | undefined,
  market: MarketContext,
  ctx: Parameters<CliCommandDef["execute"]>[1],
  usage: string,
): Promise<{ symbols: string[]; notes: string[] }> {
  try {
    const list = await readSymbolList({
      args, file, stdinPiped: false, readEntries: (entries) => readNameEntries(entries, market.dataProvider),
    });
    // Only numbers, or nothing: the message says what was left out (`Ignored 1.899, a number, not a symbol.`).
    if (list.symbols.length === 0) {
      const where = file && file !== "-" ? file : args.includes("-") ? "standard input" : "what was given";
      ctx.fail([`No symbols in ${where}.`, ...list.notes].join(" "), usage);
    }
    return { symbols: uniqueEntries(list.symbols), notes: list.notes };
  } catch (error) {
    if (error instanceof SymbolListError) ctx.fail(error.message, usage);
    throw error;
  }
}

/** What `quote --csv` and `compare --csv` write, for `help quote` and `help compare`. */
const QUOTE_CSV_SECTION = {
  title: "CSV",
  lines: [
    "Last, Chg%, Prev Close and each extended print are plain numbers. Cur is the currency; currency_or_unit is the unit: the currency, a pair's quote currency per base (JPY per USD for USDJPY=X), index points or pct for a yield. A pre-market, after-hours or overnight print's move is in Pre-Market Chg%, After Hours Chg% or Overnight Chg%, and compare's day range in Day Low and Day High, after the columns the export already had.",
    "A row with no figure says why in its status column, never NaN; a symbol with no quote is also named on standard error.",
  ],
};

/** `--file` of quote and compare, as `watchlist add` takes it. */
const LIST_FILE_OPTION = {
  flags: "--file <path>",
  description: "Read the symbols from a CSV or text file, as watchlist add does (- reads standard input)",
};

/** What JSON metadata says about the listing a command resolved. */
function listingMetadata(identity: ListingIdentity) {
  return { symbol: identity.symbol, exchange: identity.exchange || null, name: identity.name };
}

// Fitted to a narrow width, quote's Updated, Feed, Cur, Chg Basis and session prints move to labelled lines under
// their row, in that order, before Name wraps: quote never drops a column. What a user types or reads the price by stays whole.
const QUOTE_LEAD_COLUMNS = [
  { key: "symbol", header: "Symbol", shrink: false },
  { key: "name", header: "Name" },
  {
    key: "price",
    header: "Last",
    align: "right" as const,
    // An export writes the number; the row's Cur and currency_or_unit name what it is in.
    value: (row: QuoteRow) => exportFigure(row.rawPrice),
    format: (_value: unknown, row: QuoteRow) => (
      row.error && !row.price
        // A typo is not an outage: say what is wrong with the symbol itself.
        ? isNotATickerMessage(row.error) ? cliStyles.warning("not a ticker") : cliStyles.danger("unavailable")
        // A London line adds the pence it trades in, as the exchange and RNS write it, muted as a table cell's note is: £6.308 630.8p.
        : `${yieldLevelCell(row.price, row)}${row.pence ? ` ${cliStyles.muted(row.pence)}` : ""}`
    ),
  },
  {
    key: "changePercent",
    header: "Chg%",
    align: "right" as const,
    format: (value: unknown, row: QuoteRow) => {
      const move = row.yieldIndex ? yieldChangeCell(row) : formatChangePercentCell(value);
      // Keep a rolling move's short label with the value when narrow tables drop Chg Basis.
      return move && row.changeBasis === "24h" ? `${move} ${cliStyles.muted("24h")}` : move;
    },
  },
  // Text drops a column no row fills, so a table without an extended print stays as narrow as before.
  extendedColumn("PRE"),
  extendedColumn("POST"),
  extendedColumn("OVERNIGHT"),
  // An export keeps the market state (PRE-MKT); the table names the close a pre-market with no trade stands at (Thu close).
  { key: "session", header: "Session", shrink: false, format: (_value: unknown, row: QuoteRow) => row.sessionLabel },
];

type QuoteRow = ReturnType<typeof quoteRows>[number];

/**
 * What Chg% is measured from, as every change line says it ("vs Fri 16 Oct
 * close", "since 00:00 UTC"): the table sets it after Chg% and names the
 * venue's holidays under it; an export adds it, and the holiday note, after
 * its existing columns, so a column read by position stays where it was.
 */
const CHANGE_BASIS_COLUMN = {
  key: "changeBasis", header: "Chg Basis", shrink: false, stackPriority: 2,
  format: (value: unknown) => value === "24h" ? "" : cliStyles.muted(String(value ?? "")),
};
const CHANGE_BASIS_EXPORT_COLUMNS = [
  { key: "changeBasis", header: "Chg Basis" },
  { key: "changeBasisNote", header: "Chg Basis Note" },
];

/**
 * The table's columns: Chg Basis follows Chg%, and the note is a line under
 * the table. The figures an export adds (an extended print's move, the day's
 * low and high) are already in the table's own cells.
 */
function quoteTextColumns<Column extends { key: string }>(columns: Column[]): Array<Column | typeof CHANGE_BASIS_COLUMN> {
  const exported = new Set([...CHANGE_BASIS_EXPORT_COLUMNS, ...EXTENDED_CHANGE_EXPORT_COLUMNS, ...DAY_RANGE_EXPORT_COLUMNS].map((column) => column.key));
  const kept = columns.filter((column) => !exported.has(column.key));
  const at = kept.findIndex((column) => column.key === "changePercent") + 1;
  return [...kept.slice(0, at), CHANGE_BASIS_COLUMN, ...kept.slice(at)];
}

/** A Cboe yield index level is a yield: `5.24%`, not a price. */
function yieldLevelCell(value: unknown, row: QuoteRow): string {
  const text = String(value ?? "");
  return row.yieldIndex && text ? `${text}%` : text;
}

/** A yield index moves in basis points: `+1.3bp`, from the real previous close, not a percent of a percent. */
function yieldChangeCell(row: QuoteRow): string {
  return row.changeBasisPoints == null ? "" : colorBySign(formatBasisPoints(row.changeBasisPoints / 100, 1), row.changeBasisPoints);
}

/** A figure as an export writes it: the number without float noise, nothing for none. */
function exportFigure(value: number | null | undefined): number | null {
  return value == null ? null : Number.isFinite(value) ? exportNumber(value) : value;
}

const EXTENDED_SESSIONS = ["PRE", "POST", "OVERNIGHT"] as const satisfies readonly ExtendedSession[];

function extendedKey(session: ExtendedSession): string {
  return session === "PRE" ? "preMarket" : session === "POST" ? "afterHours" : "overnight";
}

/**
 * The pre-market, after-hours or overnight print and its move from the
 * regular close, in its own column; "mid" when it is a bid and ask midpoint.
 * An export writes the price alone, its move going to `<session> Chg%`
 * (EXTENDED_CHANGE_EXPORT_COLUMNS) and a midpoint to a closing note.
 */
function extendedColumn(session: ExtendedSession) {
  const price = (row: QuoteRow) => row.extendedMark ? `${row.extendedPrice} mid` : row.extendedPrice;
  return {
    key: extendedKey(session),
    header: EXTENDED_SESSION_LABELS[session],
    align: "right" as const,
    value: (row: QuoteRow) => row.extendedSession === session ? exportFigure(row.rawExtendedPrice) : null,
    format: (_value: unknown, row: QuoteRow) => (
      row.extendedSession === session && row.extendedPrice
        ? [price(row), formatChangePercentCell(row.extendedChangePercent)].join(" ").trim()
        : ""
    ),
  };
}

/**
 * Each extended print's move from the regular close, as a number: the
 * columns an export adds after those it had, so a column read by position
 * stays where it was. The table keeps the move beside the price.
 */
const EXTENDED_CHANGE_EXPORT_COLUMNS = EXTENDED_SESSIONS.map((session) => ({
  key: `${extendedKey(session)}ChangePercent`,
  header: `${EXTENDED_SESSION_LABELS[session]} Chg%`,
  value: (row: QuoteRow) => row.extendedSession === session ? row.extendedChangePercent : null,
}));

/**
 * Why an exported quote row's figures are empty, for its status column: the
 * symbol's failure as the warning says it, or the figure it has no value for.
 */
/** A pair's rate unit for an export (`JPY per USD` for USDJPY=X) when its quote is in the counter currency; null otherwise. */
function pairExportUnit(symbol: string, currency: string): string | null {
  const unit = historyUnit(symbol, { currency });
  return unit.kind === "pair" && unit.currency === currency ? unit.unit : null;
}

function quoteExportStatus(row: QuoteRow): string {
  if (row.rawPrice == null || !Number.isFinite(row.rawPrice)) return row.error || "Last: no price";
  if (row.changePercent == null || !Number.isFinite(row.changePercent)) return "Chg%: no previous close";
  return "";
}

/** The closing note of an export with an extended price that is a bid and ask midpoint: the cell holds the bare number. */
function extendedMidNotes(data: readonly QuoteCliRecord[]): string[] {
  return data.flatMap((row) => {
    const extended = getExtendedSessionDisplay(row.quote);
    return extended?.mark ? [`${row.target.symbol} ${EXTENDED_SESSION_LABELS[extended.session]} is the bid and ask midpoint; nothing has traded in that session`] : [];
  });
}

/** A percent to two decimals, as the table prints it; none for a move that is no number (a zero close). */
function roundedPercent(value: number | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(2));
}

/** The quote's currency code, US cents as US¢; an export keeps the code (USX). */
function currencyCell(value: unknown): string {
  return currencyCodeLabel(typeof value === "string" ? value : "");
}

/** The session prints of a narrow quote table move under their row after its other columns, before the name. */
const EXTENDED_KEYS = new Set(["preMarket", "afterHours", "overnight"]);

function quoteColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS.map((column) => EXTENDED_KEYS.has(column.key) ? { ...column, stackPriority: 1 } : column),
    { key: "currency", header: "Cur", shrink: false, stackPriority: 3, format: currencyCell },
    // Whether the price is real-time, delayed or stale: a feed state, not where it came from. A stale
    // row says so here, so the closing line's "N of M stale" always points at rows the table marks.
    {
      key: "feed",
      header: "Feed",
      shrink: false,
      stackPriority: 4,
      format: (value: unknown) => value === "stale" ? cliStyles.warning(value) : String(value ?? ""),
    },
    { key: "updatedAt", header: "Updated", shrink: false, stackPriority: 5 },
    ...CHANGE_BASIS_EXPORT_COLUMNS,
    ...EXTENDED_CHANGE_EXPORT_COLUMNS,
  ];
}

/** The day's low and high as numbers, after the columns an export already had. */
const DAY_RANGE_EXPORT_COLUMNS = [
  { key: "dayLow", header: "Day Low", value: (row: QuoteRow) => exportFigure(row.rawDayLow) },
  { key: "dayHigh", header: "Day High", value: (row: QuoteRow) => exportFigure(row.rawDayHigh) },
];

function compareColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    {
      key: "previousClose", header: "Prev Close", align: "right" as const,
      value: (row: QuoteRow) => exportFigure(row.rawPreviousClose),
      format: (_value: unknown, row: QuoteRow) => yieldLevelCell(row.previousClose, row),
    },
    // A narrow terminal drops these before it cuts the names short.
    // An export writes the range as plain numbers (12.5-13.1), and each end as a number in Day Low and Day High.
    {
      key: "dayRange", header: "Day Range", align: "right" as const, optional: true, dropPriority: 1,
      value: (row: QuoteRow) => row.rawDayLow != null && row.rawDayHigh != null ? `${exportFigure(row.rawDayLow)}-${exportFigure(row.rawDayHigh)}` : "",
      format: (_value: unknown, row: QuoteRow) => row.dayRange,
    },
    { key: "volume", header: "Volume", align: "right" as const, format: formatCountCell, optional: true, dropPriority: 2 },
    { key: "currency", header: "Cur", shrink: false, optional: true, dropPriority: 3, format: currencyCell },
    ...CHANGE_BASIS_EXPORT_COLUMNS,
    ...EXTENDED_CHANGE_EXPORT_COLUMNS,
    ...DAY_RANGE_EXPORT_COLUMNS,
  ];
}

/** What the Feed cell says: stale wins over the feed's own live or delayed, as the closing line counts it. */
function quoteFeedState(quote: QuoteCliRecord["quote"], now: number): "stale" | "live" | "delayed" | "" {
  if (!quote) return "";
  if (isQuoteStaleForCurrentSession(quote, now)) return "stale";
  return quote.dataSource === "live" || quote.dataSource === "delayed" ? quote.dataSource : "";
}

/** A hundredth of a cent, one basis point of a dollar peg: the decimals CRYP prints a stablecoin to. */
const STABLECOIN_PRICE_DIGITS = 4;

/**
 * A coin trading near a dollar, a dollar stablecoin, prints to four decimals
 * either side of par (0.9987, 1.0003), as CRYP does, whatever digits its
 * source sent (0.99874, 0.99968725); below a dollar a coin otherwise keeps up to eight.
 */
function nearParCoin(quote: QuoteCliRecord["quote"]): boolean {
  if (!quote || resolveAssetDisplayKind({ assetCategory: quote.instrumentType }) !== "crypto") return false;
  if ((quote.currency ?? "USD").trim().toUpperCase() !== "USD") return false;
  const reference = [quote.previousClose, quote.price].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  return reference != null && reference >= 0.9 && reference < 1.1;
}

/** What a row's move is measured from, worded as its Chg Basis cell: empty without a move. */
function rowChangeBasis(result: Pick<QuoteCliRecord, "quote" | "futuresContract">) {
  return quoteChangeBasis(result.quote, { terms: result.futuresContract });
}

function basisLabel(result: Pick<QuoteCliRecord, "quote" | "futuresContract">, now: number): string {
  const basis = rowChangeBasis(result);
  return basis ? changeBasisLabel(basis, now) : "";
}

/**
 * The lines under the table naming the days a row's venue was closed since
 * the close its move is from ("HKEX closed Mon 19 Oct, holiday"), once each.
 */
function changeBasisNotes(results: QuoteCliRecord[], now = Date.now()): string[] {
  return [...new Set(results.flatMap((result) => changeBasisNote(rowChangeBasis(result), now) ?? []))];
}

/** The quote as `--json` gives it: `previousCloseDate`, the exchange-local date of its previous close, follows `previousClose`. */
function withPreviousCloseDate(quote: Quote | null | undefined): (Quote & { previousCloseDate?: string | null }) | null {
  if (!quote) return null;
  const previousCloseDate = quotePreviousCloseDate(quote);
  const entries = Object.entries(quote).filter(([key]) => key !== "previousCloseDate");
  const at = entries.findIndex(([key]) => key === "previousClose");
  entries.splice(at < 0 ? entries.length : at + 1, 0, ["previousCloseDate", previousCloseDate]);
  return Object.fromEntries(entries) as Quote & { previousCloseDate?: string | null };
}

/** An explicit missing comparison wins over any leftover numeric move in a CLI quote. */
function quoteSessionFields(quote: Quote | null | undefined) {
  const fields = getQuoteSessionFields(quote);
  return quote?.changeBasis === "none" ? { ...fields, change: null, changePercent: null } : fields;
}

function quoteRows(results: QuoteCliRecord[], now = Date.now()) {
  return results.map((result) => {
    const quote = result.quote;
    // Last and Chg% are the regular session, as `ticker` and the quote monitor read it; a
    // pre-market or after-hours print is its own column, measured from that session's close.
    const display = quoteSessionFields(quote);
    const extended = getExtendedSessionDisplay(quote);
    const yieldIndex = isYieldIndexSymbol(result.target.symbol);
    // An index level is in points, not in the currency its members trade in.
    const indexPoints = isIndexLevel(quote?.instrumentType);
    // Pad to two decimals so a column lines up, but never past the currency's minor unit (JPY has none).
    // Points have no minor unit, so a yen-listed index still pads to two.
    const options = {
      ...quoteFormatOptions(quote),
      minimumFractionDigits: indexPoints ? 2 : currencyPriceMinDigits(quote?.currency),
      ...nearParCoin(quote) ? { fixedFractionDigits: STABLECOIN_PRICE_DIGITS } : {},
    };
    const price = (value: number | null | undefined) => (
      quote && value != null
        ? indexPoints ? formatMarketPrice(value, options) : formatMarketPriceWithCurrency(value, quote.currency, options)
        : ""
    );
    // A price in cents says what it is per, as the contract terms word it: 314.95¢/lb.
    const per = display.price != null ? futuresPricePer(result.futuresContract, quote?.currency) : "";
    const previousClose = display.price != null && display.change != null ? display.price - display.change : quote?.previousClose;
    const last = price(display.price);
    return {
      symbol: result.target.symbol,
      name: quote?.name || result.listing?.name || "",
      price: `${last}${per}`,
      pence: penceFigure(display.price, quote, /\.(\d+)/.exec(last)?.[1]?.length ?? 0),
      rawPrice: display.price,
      priceBasis: quote?.priceBasis ?? null,
      instrumentType: quote?.instrumentType ?? null,
      change: display.change,
      changePercent: roundedPercent(display.changePercent ?? undefined),
      // A Cboe yield index is read as a yield in percent and moves in basis points.
      yieldIndex,
      changeBasisPoints: yieldIndex && display.change != null ? toBasisPoints(display.change, 1) : null,
      extendedSession: extended?.session ?? null,
      extendedPrice: price(extended?.price),
      rawExtendedPrice: extended?.price ?? null,
      extendedChange: extended?.change ?? null,
      extendedChangePercent: roundedPercent(extended?.changePercent),
      // The extended price is the session's bid and ask midpoint, nothing having traded in it.
      extendedMark: extended?.mark === true,
      session: quoteSessionStateLabel(quote, now) ?? "",
      sessionLabel: quoteSessionLabel(quote, now) ?? "",
      // The close the shown move is measured from: the one before the session Last is.
      previousClose: price(previousClose),
      rawPreviousClose: previousClose ?? null,
      rawDayLow: quote?.low != null && quote.high != null ? quote.low : null,
      rawDayHigh: quote?.low != null && quote.high != null ? quote.high : null,
      dayRange: quote?.low != null && quote.high != null
        ? indexPoints ? `${price(quote.low)}-${price(quote.high)}` : formatPriceRange(quote.low, quote.high, quote.currency, options, "-")
        : "",
      // An index's 0 is volume nobody counts, and its level has no currency.
      volume: reportedQuoteVolume(quote),
      currency: indexPoints ? "" : quote?.currency ?? "",
      providerId: quote?.providerId ?? "",
      source: quote?.dataSource ?? quote?.providerId ?? "",
      feed: quoteFeedState(quote, now),
      // When the price Last shows was observed: in a pre-market nothing has traded in, the close it stands at.
      updatedAt: quote?.lastUpdated ? new Date(quoteHeadlineTime(quote)).toISOString() : "",
      error: result.error ?? "",
      // Last, so a row read by position keeps every field where it was.
      changeBasis: basisLabel(result, now),
      changeBasisNote: changeBasisNote(rowChangeBasis(result), now) ?? "",
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
    id: article.id,
    title: article.title,
    // Whole, as exports write it; the text table's line under the row (newsRowNote) runs it together.
    summary: article.summary ?? null,
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
    // A current report's press release exhibit, where its index names one: the figures, not the cover page.
    pressReleaseUrl: filing.pressReleaseUrl ?? "",
    items: secFilingItemCodes(filing.items) ?? "",
    // A current report's items by number and name: the results 8-K reads apart from another filed that day.
    itemsLabel: currentReportItemsLabel(filing.items) ?? "",
  }));
}

/** The filings as JSON gives them, with a current report's items named beside their codes. */
function filingsWithItemLabels(filings: SecFilingItem[]) {
  return filings.map((filing) => {
    const itemsLabel = currentReportItemsLabel(filing.items);
    return itemsLabel ? { ...filing, itemsLabel } : filing;
  });
}

/** The summary over the ratings: the upside from Last, and the price and time it is measured from, as `fn ANR` gives them. */
function analystSummary(data: AnalystResearchData, quote: Quote | null): string {
  const target = data.priceTarget;
  const currency = analystTargetCurrency(data);
  const { upside, reference } = analystUpside(data, quote);
  const analysts = recommendationTotal(data);
  const mix = formatRecommendationMix(data);
  const entries: Array<[string, string]> = [
    ["Average Target", formatAnalystPrice(target?.average, currency)],
    ["Upside", upside == null ? "-" : formatPercent(upside)],
    ["Upside vs", upside == null ? "-" : formatAnalystReference(reference, currency)],
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
    ...(ratingReason(rating) ? { reason: rating.reason } : {}),
  }));
}

/** The reason coverage of an action gave, under its row with the article. */
function analystRowNote(row: { reason?: AnalystResearchData["ratings"][number]["reason"] }): string | null {
  const reason = row.reason;
  return reason ? `${reason.text} · ${reason.url}` : null;
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
  // To the cent, as ERN and EE show it; a consensus average carries more digits.
  const eps = (value: number | undefined, unit: string | undefined) => (
    value == null || !Number.isFinite(value) ? "-"
      : !unit ? formatNumber(value, 2)
        : /^[A-Z]{3}$/.test(unit) ? formatCurrency(value, unit, 2) : `${formatNumber(value, 2)} ${unit}`
  );
  return [
    ...data.earnings.map((event) => {
      const unit = event.currency?.trim() || earningsCurrency;
      const quarter = quarterLabel(event.fiscalPeriod);
      const basis = earningsEpsBasis(event.epsBasis);
      // History rows are keyed by fiscal quarter end, upcoming ones by announcement date.
      const note = [event.dateType === "fiscal-period-end" ? "period end" : null, quarter === "-" ? null : quarter].filter(Boolean).join(", ");
      return {
        type: "earnings",
        date: event.date,
        // The basis, beat, date status and analysts are the words EE uses for the same row.
        detail: [event.epsActual == null ? `est ${eps(event.epsEstimate, unit)}` : `eps ${eps(event.epsActual, unit)}`,
          ...earningsDetailParts(event)].join(", ") + (note ? ` (${note})` : ""),
        epsActual: event.epsActual,
        epsEstimate: event.epsEstimate,
        epsBasis: showsEpsBasis({ epsActual: event.epsActual, epsBasis: basis }) ? epsBasisName(basis) : undefined,
        ...(isProvisionalActual(event) ? { epsProvisional: true } : {}),
        epsAnalysts: event.epsAnalysts,
        dateStatus: earningsDateStatus(event.dateStatus) ?? undefined,
        fiscalPeriod: event.fiscalPeriod,
      };
    }),
    ...data.dividends.map((event) => ({
      type: "dividend",
      date: event.exDate,
      detail: currency ? formatDistributionAmount(event.amount, currency) : cleanDecimal(event.amount),
    })),
    // Declared and unpaid, at its ex-date beside the paid rows, never one of them.
    ...declaredDividends(data).map((event) => ({
      type: "dividend",
      date: event.exDate,
      detail: `declared ${event.special ? "special " : ""}${currency ? formatDistributionAmount(event.amount, currency) : cleanDecimal(event.amount)}`
        + (event.payDate ? `, payable ${event.payDate}` : ""),
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

function earningsRows(events: ResolvedEarningsEvent[]) {
  return events.map((event) => ({
    symbol: event.symbol,
    name: event.name,
    date: isoDate(event.earningsDate).slice(0, 10),
    // Out, announced by the company, or projected from its past reports.
    status: earningsDateLabel(event.dateStatus),
    timing: event.timing,
    epsEstimate: event.epsEstimate,
    epsActual: event.epsActual,
    revenueEstimate: event.revenueEstimate,
    revenueActual: event.revenueActual,
  }));
}

/** Symbols at most whose venues a command looks up to name the company each bare one went to. */
const MAX_CHOICE_LOOKUPS = 10;

/**
 * The line `quote` prints beside a symbol that changed, as `history` and
 * `ticker` word it: a company that moved, with nothing new listed there,
 * names the quote of its new symbol ("HFC became DINO on 2022-03-15:
 * `gloom quote DINO`"); its old line's last price stays in the row.
 */
function quoteChangeLine(change: TickerChange | null | undefined, formerIssuer?: FormerIssuer | null): string | null {
  const moved = movedAwayChange(change);
  // One line per symbol: a company that left it, else the company that merged away from it (GOGL).
  return (moved ? movedSymbolLine(moved, `gloom quote ${moved.tradesAs}`) : tickerChangeLine(change)) ?? formerIssuer?.note ?? null;
}

async function runQuote(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], commandName: "quote" | "compare") {
  const args = [...rawArgs];
  const usage = `Usage: gloom ${commandName} <symbol...> [--file <path>]`;
  const exchange = takeOption(args, "--exchange") ?? "";
  // A list from a file or standard input (`-`), read as `watchlist add` reads one.
  const file = args.some((arg) => arg === "--file" || arg.startsWith("--file=")) ? takeOption(args, "--file") ?? "" : undefined;
  const listed = file != null || args.includes("-");
  const entries = normalizeSymbols(args);
  if (entries.length === 0 && !listed) ctx.fail(usage);
  // A currency's name in words (`quote japanese yen`) is its pair, not a symbol a word.
  const currency = exchange || listed ? null : currencyNameStop(args, commandName);
  if (currency) ctx.fail(currency.message, currency.details);
  // One quoted argument with spaces is a company's name, a pasted line of tickers, or a phrase to search for.
  const phrase = exchange || listed ? null : quotedPhrase(args);

  await withMarketData(ctx, async (market) => {
    const read = phrase ? await readPhraseArgument(phrase, market.dataProvider) : null;
    if (read?.kind === "phrase") return answerPhrase(read.phrase, market, ctx);
    // Typed or from a file, one reader names what it left out: a stray separator, the prices beside the symbols.
    const list = read ? null : await readListedSymbols(args, file, market, ctx, usage);
    const symbols = read?.kind === "name" ? [read.name]
      : read?.kind === "symbols" ? uniqueEntries(read.symbols)
      : list!.symbols;
    // What cannot be a symbol (N/A, $$$, a price alone) is never looked up; one line names it.
    const refused = symbols.flatMap((symbol) => notASymbolError(symbol) ?? []);
    if (refused.length === symbols.length) {
      ctx.fail(refused.length === 1 ? refused[0]!.message : `Nothing to quote: ${refusedList(refused)} are not symbols.`, usage);
    }
    // With several symbols, --exchange is for the ones that name no exchange of their own, and one that names no
    // listing (EQT:NYSE:US) is named in a line while the others are quoted.
    const resolvedListings = await Promise.all(symbols.filter((symbol) => !notASymbolError(symbol)).map(async (symbol) => {
      if (symbols.length === 1) return { symbol, listing: await requireCliListing(symbol, exchange, market, ctx) };
      try {
        return { symbol, listing: await resolveCliListing(symbol, exchange, market, { ownExchangeWins: true }) };
      } catch (error) {
        if (error instanceof ListingArgError) return { symbol, error };
        throw error;
      }
    }));
    const unread = resolvedListings.flatMap((entry) => "error" in entry && entry.error ? [{ symbol: entry.symbol, error: entry.error }] : []);
    const listings = resolvedListings.flatMap((entry) => "listing" in entry && entry.listing ? [entry.listing] : []);
    if (listings.length === 0) {
      const [first] = unread;
      ctx.fail(first!.error.message, [...unread.slice(1).map(unreadLine), ...refused.length > 0 ? [refusedLine(refused)] : []].join("\n") || first!.error.details);
    }
    const targets: QuoteSubscriptionTarget[] = listings.map((listing) => ({ symbol: listing.request.symbol, exchange: listing.request.exchange }));
    // A bare symbol's venues load beside its quote, to name the company it was read as when several list it.
    // Each costs a search, so a long list (a portfolio check, not a lookup) names none.
    const venues = new Map(listings.length > MAX_CHOICE_LOOKUPS ? []
      : listings.map((listing) => [listing, loadBareVenues(listing, market)] as const));
    // So is whether a symbol changed (FB is now META), for the same lists.
    const changes = new Map(listings.length > MAX_CHOICE_LOOKUPS ? []
      : listings.map((listing) => [listing, startTickerChangeLookup(market.dataProvider, listing.symbol, listing.exchange)] as const));
    // The service's quote of the moment, not each form's local copy from whenever it was last asked for:
    // BRK.B saved on NYSE, BRK-B and BRK.B:NYSE print one quote. A local copy answers only offline.
    // Each row prints what its move is from (Chg Basis).
    const results = await market.dataProvider.getQuotesBatch(targets, { forceRefresh: ctx.cliOptions.refresh, revalidate: true, datesChangeBasis: true });
    const listingOf = (result: QuoteBatchResult, index: number) => listings[targets.indexOf(result.target)] ?? listings[index]!;
    const asked = results.map(listingOf);
    const request = { command: commandName, noun: "quote" };
    const answers = await Promise.all(results.map((result, index) => {
      const listing = asked[index]!;
      return answerQuote(result, listing, market, request, ctx.cliOptions.refresh, venues.get(listing) ?? null, { datesChangeBasis: true });
    }));
    const now = Date.now();
    const symbolChanges = await Promise.all(answers.map(async ({ result }, index) => {
      const listing = asked[index]!;
      // A bare symbol read on a listing abroad (SXR8 -> XETRA) is not the US symbol the changes are of.
      if (result.quote && bareListingNote(listing, result.quote)) return { change: null, formerIssuer: null };
      const payload = await changes.get(listing)?.settle(SUCCESSOR_CHANGE_WAIT_MS) ?? null;
      const current = tradingListing(result.quote, now);
      return { change: describeTickerChange(listing.symbol, payload, current), formerIssuer: describeFormerIssuer(listing.symbol, payload, current) };
    }));
    const tickerChanges = symbolChanges.map(({ change }) => change);
    const formerIssuers = symbolChanges.map(({ formerIssuer }) => formerIssuer);
    const failed = answers[0]?.failure;
    if (symbols.length === 1 && failed) {
      ctx.fail(failed.message, [quoteChangeLine(tickerChanges[0], formerIssuers[0]), failed.details].filter(Boolean).join("\n") || undefined);
    }
    // A futures quote adds its dated settlement and contract terms, as `ticker` prints them; `compare` stays a table.
    const contracts = await Promise.all(answers.map(({ result }) => commandName === "quote" && result.quote
      ? cliFuturesContract(result.quote.symbol || result.target.symbol, result.quote.instrumentType)
      : null));
    // A contract that is not its root's front (NGF27, NG2) prints the front's own price beside it, read in one batch.
    const fronts = await loadFuturesFrontQuotes(contracts, market.dataProvider);
    // A per-MWh gas price (TTF) adds its dollars per MMBtu at the day's rate, to read beside Henry Hub.
    const gasInUsd = await Promise.all(answers.map(({ result }, index) => loadUsdPerMmbtu(
      getRegularSessionDisplay(result.quote)?.price, contracts[index], result.quote?.currency, (currency) => market.dataProvider.getExchangeRate(currency))));
    // A perpetual adds its funding per eight hours and open interest, the figures PERP lists beside its mark.
    const perpetualContracts = await Promise.all(answers.map(({ result }) => commandName === "quote" && result.quote
      ? cliPerpetualContract(result.quote)
      : null));
    // A bare symbol quoted on a listing abroad (APPL, Aptus Pharma on BSE) that is one slip from a US ticker (AAPL) says so.
    const usSuggestions = await Promise.all(answers.map(({ result, listing, notes }) => {
      const venue = result.quote && !listing.saved ? bareListingNote(listing, result.quote) : null;
      return venue && notes.includes(venue) ? suggestUsTicker(listing.symbol, market) : null;
    }));
    // Each row names its listing by key (SAN:EPA) and company, so the table needs no line above it.
    const data = answers.map(({ result, listing, failure }, index) => ({
      target: result.target,
      listing: listingMetadata(listingIdentity(listing, result.quote)),
      // The figures the table shows, beside the quote as the source sent it.
      ...quoteSessionFields(result.quote),
      // What `change` is measured from, with the label and holiday note the table shows.
      changeBasis: changeBasisJson(quoteChangeBasis(result.quote, { terms: contracts[index] }), now),
      quote: withPreviousCloseDate(result.quote),
      ...contracts[index] ? { futuresContract: contracts[index] } : {},
      ...fronts[index] ? { futuresFront: fronts[index] } : {},
      ...gasInUsd[index] ? { usdPerMmbtu: gasInUsd[index] } : {},
      ...perpetualContracts[index] ? { perpetualContract: perpetualContracts[index] } : {},
      ...usSuggestions[index] ? { usSuggestion: usSuggestions[index] } : {},
      error: failure?.oneLine ?? errorMessage(result.error),
      ...yieldIndexFields(result),
      ...tickerChanges[index] ? { tickerChange: tickerChanges[index] } : {},
      ...formerIssuers[index] ? { formerIssuer: formerIssuers[index] } : {},
    }));
    const notes = [
      ...list?.notes ?? [],
      ...refused.length > 0 ? [refusedLine(refused)] : [],
      ...unread.map(unreadLine),
      // FB now lists another security; the company that was FB trades as META. A symbol a
      // company renamed into (META) is what was typed: its change is in the row, not here.
      // GOGL was Golden Ocean, which merged into CMB.Tech; a fund lists there now.
      ...tickerChanges.flatMap((change, index) => quoteChangeLine(change, formerIssuers[index]) ?? []),
      // Which listing a bare symbol was read as, and the index a bare root is not, are in no row.
      ...answers.flatMap((answer) => answer.notes),
      // A row that stopped trading long ago reads as a quote that is merely stale, and one with
      // nothing printed in a session the calendar has open (a feed that stalled, a typhoon day) says since when.
      ...data.flatMap((row) => {
        if (!row.quote) return [];
        const label = `${row.target.symbol}${row.listing.name ? ` (${row.listing.name})` : ""}`;
        const ended = noLongerTradingNote(label, row.quote, now);
        const quiet = ended ? null : noPrintsTodayText(row.quote, now);
        return [ended ?? (quiet ? `${label}: ${quiet}` : []), quoteBarNotes(label, row.quote, now)].flat();
      }),
      // A receipt and its home line each say the ratio, as `ticker` does; a CEDEAR names itself in its own.
      ...data.flatMap((row) => {
        const cedear = listingCedearRatio({ quote: row.quote });
        if (cedear) return [`${cedearRatioText(cedear)}.`];
        const pair = listingDepositaryPair({ quote: row.quote });
        return pair ? [`${row.target.symbol}: ${depositaryPairText(pair, isReceiptSide({ quote: row.quote }))}.`] : [];
      }),
      // A cell shows only "unavailable", and an exported row only its status, so stderr names each failure; the JSON rows carry each reason.
      ...ctx.cliOptions.format !== "json" ? quoteNotes(data) : [],
    ];
    const columns = commandName === "compare" ? compareColumns() : quoteColumns();
    const basisNotes = changeBasisNotes(data, now);
    const midNotes = extendedMidNotes(data);
    if (ctx.cliOptions.format !== "json") await primeBoardCoins(notes);
    // Only yield indices: their change is in bp, so the text header drops the percent sign (CSV keeps the percent it holds).
    const yieldsOnly = data.length > 0 && data.every((row) => isYieldIndexSymbol(row.target.symbol));
    ctx.printResult({
      data,
      warnings: notes.length > 0 ? notes : undefined,
      // A Cboe yield index stops at its 15:00 ET close, before the Treasury's curve is taken: the line says so, so its
      // close does not read as a contradiction of DGS10 or GC for the same day.
      // Dated by the quotes as served, which say whether one is the saved copy.
      freshness: withSavedCopy(
        // A table across markets (US and London lines) dates each market's session and says when each opens.
        quotesFreshness(data.map((row) => row.quote), { datesEachVenue: true, ...yieldsOnly ? { schedule: `Cboe close ${CBOE_YIELD_INDEX_CLOSE}` } : {} }),
        answers.map(({ result }) => result.quote),
      ),
    }, {
      rows: quoteRows,
      // An index row's Cur is blank, its level having no currency; the export names what it is in instead.
      exportIdentity: (row) => ({
        symbolOrSeries: row.symbol,
        // A pair's rate is its quote currency per base: JPY per USD, as `history` and `fx` export it.
        currencyOrUnit: (row.currency && pairExportUnit(row.symbol, row.currency))
          || row.currency || (row.yieldIndex ? "pct" : isIndexLevel(row.instrumentType) ? INDEX_POINTS_EXPORT_UNIT : null),
      }),
      // A row with no price or move says why in its status column, as the warnings do.
      exportStatus: quoteExportStatus,
      ...(midNotes.length > 0 ? { exportNotes: midNotes } : {}),
      details: quoteDetailsText,
      ...(basisNotes.length ? { footnote: basisNotes.join("\n") } : {}),
      columns,
      textColumns: quoteTextColumns(yieldsOnly
        ? columns.map((column) => column.key === "changePercent" ? { ...column, header: "Chg" } : column)
        : columns),
    });
    // The table and the warnings name each symbol it found nothing for; with none found, the exit status says so too.
    if (data.every((row) => !row.quote)) process.exitCode = CLI_EXIT_CODES.error;
  });
}

/** The entries refused before any lookup, named as written: `$$$, N/A`, split by semicolons when one has a comma. */
function refusedList(refused: ReadonlyArray<{ input: string }>): string {
  const inputs = refused.map((error) => error.input.trim());
  return inputs.join(inputs.some((input) => input.includes(",")) ? "; " : ", ");
}

/** The one line a quote prints for what it did not look up: `Not a symbol, not quoted: $$$, N/A.` */
function refusedLine(refused: ReadonlyArray<{ input: string }>): string {
  return `Not ${refused.length === 1 ? "a symbol" : "symbols"}, not quoted: ${refusedList(refused)}.`;
}

/** A symbol of a list that names no listing: `Not quoted: EQT:NYSE:US (Unknown exchange US for EQT:NYSE).` */
function unreadLine({ symbol, error }: { symbol: string; error: ListingArgError }): string {
  return `Not quoted: ${symbol} (${error.message.replace(/\.$/, "")}).`;
}

/**
 * `quote "10 year yield"`: a phrase that is no ticker and no company's name
 * is answered with what search finds for it and the catalog, never quoted
 * word by word (10, YEAR, YIELD). A script asked for a quote, so structured
 * output fails with where to look instead.
 */
async function answerPhrase(phrase: string, market: MarketContext, ctx: Parameters<CliCommandDef["execute"]>[1]): Promise<void> {
  const said = `"${phrase}" is not a ticker or a company's name.`;
  if (ctx.cliOptions.format !== "text") {
    ctx.fail(said, [knownGapMessage(phrase), `Search for it: gloom search "${phrase}"`, `Functions and data: gloom catalog "${phrase}"`]
      .filter(Boolean).join("\n"));
  }
  process.exitCode = CLI_EXIT_CODES.error;
  if (ctx.cliOptions.quiet) return;
  // Searched first: a busy search fails on its own, without the line saying the phrase names nothing.
  const report = await phraseSearchReport(phrase, market, ctx.plugins);
  console.error(`${cliStyles.warning("warning:")} ${said} What search finds for it:`);
  console.log(report);
}

/**
 * Under the table: each futures row's Settle line and Contract block, then the
 * line for a symbol that is not a US ticker though it is one slip from one.
 */
function quoteDetailsText(data: QuoteCliRecord[]): string {
  return [quoteFuturesContractText(data), ...data.flatMap((row) => notUsTickerLine(row) ?? [])].filter(Boolean).join("\n\n");
}

/**
 * "APPL is not a US ticker: it is Aptus Pharma Limited on BSE (INR). Did you
 * mean AAPL (Apple Inc.)?" in the warning colour, for a row that has one.
 */
function notUsTickerLine(row: QuoteCliRecord): string | null {
  const sentence = notUsTickerSentence(row);
  return sentence && cliStyles.warning(sentence);
}

/** Each futures row's front contract quote, when its terms name a front other than its own contract; null otherwise. */
async function loadFuturesFrontQuotes(
  contracts: ReadonlyArray<FuturesContractTermsPayload | null>,
  provider: Pick<MarketContext["dataProvider"], "getQuotesBatch">,
): Promise<Array<Quote | null>> {
  const symbols = [...new Set(contracts.flatMap((terms) => terms?.front?.contractSymbol ?? []))];
  if (symbols.length === 0) return contracts.map(() => null);
  const results = await provider.getQuotesBatch(symbols.map((symbol) => ({ symbol, exchange: "" })))
    .catch(logFailure("cli.commands-market", "Read futures front quotes failed", []));
  const quotes = new Map(results.flatMap((result) => result.quote ? [[result.target.symbol, result.quote] as const] : []));
  return contracts.map((terms) => terms?.front ? quotes.get(terms.front.contractSymbol) ?? null : null);
}

/**
 * Each futures row's Settle line and Contract block, worded as `ticker`
 * words them, with how a continuous symbol or a generic rolls, the front it
 * is not and the day's most active contract after the contract it prices.
 * Several symbols name theirs in the block's title.
 */
function quoteFuturesContractText(data: QuoteCliRecord[]): string {
  return data.flatMap((row) => {
    if (row.perpetualContract) {
      const stats = perpetualContractStats(row.perpetualContract);
      return [data.length > 1 ? `${renderSection(`${row.target.symbol} Contract`)}\n${renderStats(stats)}` : `${renderSection("Contract")}\n${renderStats(stats)}`];
    }
    const terms = row.futuresContract;
    if (!terms || !row.quote) return [];
    const settle: [string, string] = ["Settle", quoteSettleText(row.quote, terms)];
    // The move Chg% gives, in the quote's money and with what it is measured from: "vs Fri settle".
    const session = getRegularSessionDisplay(row.quote);
    const change: Array<[string, string]> = session?.change != null && Number.isFinite(session.change)
      ? [["Change", quoteChangeText(row.quote, session, withCurrencyMinorDigits(quoteFormatOptions(row.quote, "FUTURE"), row.quote.currency), terms)]]
      : [];
    // European gas beside Henry Hub: "≈ $30.832/MMBtu at EUR/USD 1.1650", a conversion that says so.
    const inUsd = row.usdPerMmbtu;
    if (inUsd) change.push(["In USD", usdPerMmbtuText(inUsd)]);
    const metrics = futuresContractMetrics(terms, row.quote.symbol || row.target.symbol);
    const rolls = futuresRollLines(terms, row.futuresFront).map((line): [string, string] => [line.label, line.value]);
    const at = futuresContractLines(terms, row.quote.symbol || row.target.symbol)[0]?.key === "contract" ? 1 : 0;
    const contract = [...metrics.slice(0, at), ...rolls, ...metrics.slice(at)];
    if (data.length > 1) return [`${renderSection(`${row.target.symbol} Contract`)}\n${renderStats([settle, ...change, ...contract])}`];
    return [[renderStats([settle, ...change]), ...contract.length ? ["", renderSection("Contract"), renderStats(contract)] : []].join("\n")];
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

/**
 * A crypto pair that will not load points at the crypto board. Structured
 * formats keep the error as thrown, and so does no connection at all, which
 * the board cannot get past either.
 */
function failHistory(error: unknown, symbol: string, ctx: Parameters<CliCommandDef["execute"]>[1]): never {
  if (ctx.cliOptions.format !== "text" || !isCryptoPairSymbol(symbol) || isNetworkFailure(error)) throw error;
  return ctx.fail(errorMessage(error) ?? `No history available for ${symbol}`, CRYPTO_BOARD_HINT);
}

const HISTORY_USAGE = "history <symbol...> [--range <range> | --from <year|date> [--to <year|date>]]";
const HISTORY_ALL_RANGE = `ALL gives the full history the source has, up to ${historyAllRangeYears()} years`;
const HISTORY_YTD_RANGE = "YTD starts at the prior year's last close, the one year-to-date returns are measured from";
/** Options people reach for to ask for dates, which history answers with --from and --to (or --start and --end). */
const DATE_WINDOW_OPTIONS = new Set(["--since", "--until", "--date", "--start-date", "--end-date"]);
/** Options people reach for to pick a bar size, which history derives from the range. */
const BAR_SIZE_OPTIONS = new Set(["--interval", "--resolution", "--bar", "--bars", "--bar-size", "--granularity", "--timeframe", "--frequency", "--freq", "--tick", "--ticks"]);

/** The symbol `history` was given: the first word that is not an option or the value after one. */
function historySymbolArg(args: readonly string[]): string | undefined {
  return args.find((arg, index) => !arg.startsWith("-")
    && !(index > 0 && args[index - 1]!.startsWith("--") && !args[index - 1]!.includes("=")));
}

/** What people type for quarterly figures, which `financials` (fiscal years) does not take. */
const QUARTERLY_OPTIONS = new Set(["--quarterly", "--quarter", "--quarters", "--qtr", "--period", "--periods", "--frequency", "--freq", "--interval"]);

/** Options before the symbol whose next word is their value: `financials`'s own, and the quarterly ones that take one. */
const FINANCIALS_VALUE_OPTIONS = new Set(["--exchange", "--section", "--period", "--periods", "--frequency", "--freq", "--interval"]);

/** The symbol `financials` was given, wherever it sits: `--quarterly WFC` is WFC, `--period quarterly WFC` too. */
function financialsSymbolArg(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) return arg;
    if (!arg.includes("=") && FINANCIALS_VALUE_OPTIONS.has(arg)) index += 1;
  }
  return undefined;
}

/** `financials --quarterly` points at the functions that show quarters: GF a metric over time, FA the statements. */
function financialsOptionHint(flag: string, args: readonly string[]): string | null {
  if (!QUARTERLY_OPTIONS.has(flag)) return null;
  const symbol = financialsSymbolArg(args) ?? "<symbol>";
  return `financials lists fiscal years. For quarters: gloom fn GF ${symbol} --period quarterly --periods 40 (one metric at a time), `
    + `or gloom fn FA ${symbol} --period quarterly (the statements).`;
}

function historyOptionHint(flag: string, args: readonly string[]): string | null {
  if (DATE_WINDOW_OPTIONS.has(flag)) {
    return `history takes dates as --from and --to (or --start and --end), each a year or a date (--from 2007 --to 2009), or a --range: ${HISTORY_RANGES.join(", ")}.`;
  }
  if (BAR_SIZE_OPTIONS.has(flag)) return `history serves each --range in one bar size. ${subMinuteDataMessage(historySymbolArg(args))}`;
  return null;
}

/** "Asked from 1990-01-01, data starts 1995-01-03 (first available bar)" when the bars start over a week into the window. */
function windowHistoryNotes(window: PriceWindow, rows: readonly { date: string }[]): string[] {
  const first = rows[0]?.date.slice(0, 10);
  if (!first) return [];
  return Date.parse(`${first}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`) > 7 * 86_400_000
    ? [`Asked from ${window.from}, data starts ${first} (first available bar)`] : [];
}

/** "Asked YTD, data starts 2026-03-05 (first available bar)" when no bar reaches the prior year's last close. */
function ytdHistoryNotes(rows: readonly { date: string }[]): string[] {
  const first = rows[0]?.date.slice(0, 10);
  const last = rows.at(-1)?.date.slice(0, 10);
  return first && last && first > `${Number(last.slice(0, 4)) - 1}-12-31` ? [`Asked YTD, data starts ${first} (first available bar)`] : [];
}

/** What `history` was asked for: a range, or a window of dates in its place. */
interface HistoryAsk {
  range: HistoryRange;
  window: PriceWindow | null;
}

/** One listing's bars as `history` prints them, with what its heading, warnings and closing line say. */
interface ListingHistory {
  listing: CliListing;
  identity: ListingIdentity;
  unit: HistoryUnit;
  data: HistoryRow[];
  resolution: PriceHistoryResult["resolution"];
  interval: HistoryRow["interval"];
  decimals: number;
  /** Intraday bars, which print in UTC as times. */
  intraday: boolean;
  volume: HistoryVolume | null;
  freshness: ReportFreshness | undefined;
  notes: string[];
}

/** The command a listing that cannot be served is pointed back at: `history`, `history --range 5Y`. */
function historyCommand({ range, window }: HistoryAsk): string {
  // A window that runs to today retries to the day it is run on, not the one it was first run on.
  return window ? `history --from ${window.from}${isPastPriceWindow(window) ? ` --to ${window.to}` : ""}` : range === "1Y" ? "history" : `history --range ${range}`;
}

/**
 * One listing's bars, dated and checked as `history` prints them. Without
 * `lookups` it does not look up the other venues of a bare symbol or whether
 * its company moved, which a long list skips, as `quote` does.
 */
async function loadListingHistory(
  listing: CliListing,
  market: MarketContext,
  ctx: Parameters<CliCommandDef["execute"]>[1],
  ask: HistoryAsk,
  { lookups }: { lookups: boolean },
): Promise<ListingHistory> {
  const { range, window } = ask;
  // YTD reads the year's daily bars and starts at the last one on or before 31 Dec.
  const loadRange: TimeRange = range === "YTD" ? "1Y" : range;
  const venues = lookups ? loadBareVenues(listing, market) : null;
  const { symbol, exchange } = listing.request;
  const context = { cacheMode: ctx.cliOptions.refresh ? "refresh" as const : "default" as const };
  const load = () => window ? loadPriceWindowHistory(market.dataProvider, symbol, exchange, window, context)
    : market.dataProvider.getPriceHistoryWithMetadata
      ? market.dataProvider.getPriceHistoryWithMetadata(symbol, exchange, loadRange, context)
      : market.dataProvider.getPriceHistory(symbol, exchange, loadRange, context).then((points): PriceHistoryResult => ({ points, resolution: null }));
  const quoteAnswer = loadListingQuoteAnswer(market.dataProvider, listing);
  const quoted = quoteAnswer.then((answer) => answer.quote);
  const fate = lookups ? listingFateLoader(listing, market, quoted, { successor: true }) : null;
  const request = { command: historyCommand(ask), noun: "history", ...(fate ? { fate } : {}) };
  const [loaded, quote] = await Promise.all([
    loadForListing(listing, market, ctx, load, (loaded) => loaded.points.length === 0, request)
      .catch((error) => failHistory(error, listing.key, ctx)),
    quoted,
  ]);
  // A bare symbol several companies list is never served from the one the data service picked, in a range or a window:
  // it asks for an exchange as `quote` does, and in a list that is the symbol's row alone.
  await failUnchosenListing(listing, market, ctx, request, (await quoteAnswer).error);
  const { resolution } = loaded;
  // While the session trades the day's bar is the quote's, whatever range the history was cut for (withSessionBar).
  // A window that ended before today has no session in progress.
  const points = window && isPastPriceWindow(window) ? loaded.points
    : withSessionBar(loaded.points, quote, { now: Date.now(), venue: quote?.listingExchangeName || exchange || undefined });
  const fromQuote = points !== loaded.points;
  const identity = listingIdentity(listing, quote);
  // Without a quote currency, the listing metadata research reads (as `ticker` does) may still state it.
  const listed = quote?.currency ? quote : await market.dataProvider.getQuoteMetadata?.(symbol, exchange).catch(logFailure("cli.commands-market", "Read quote metadata for history failed", null));
  const unit = historyUnit(listing.key, listed ?? quote);
  const traded = {
    listing: listing.key, exchange: quote?.listingExchangeName || exchange || undefined, instrumentType: quote?.instrumentType,
  };
  // A coin's volume is traded value in its quote currency: said in every row and on the status line.
  const volume = historyVolume(unit, traded);
  // Spot FX has no exchange to count its trades: a source's 0 is no volume, printed as missing.
  const pair = quote?.instrumentType === "CURRENCY" || isCurrencyPairListing(symbol, exchange);
  // A London line's bars were priced in pence: cleaned there, and printed to the pence decimals `quote` shows.
  const priceDivisor = quotedPriceDivisor(quote);
  const rows = historyRows(pair ? points.map(({ volume: _volume, ...point }) => point) : points, resolution, unit.currency, unit.unit, volume, priceDivisor);
  // Bars stop arriving on the listing's own trading days, not New York's.
  const venue = quote?.listingExchangeName || exchange || undefined;
  const served = range === "YTD" && !window ? rows.slice(Math.max(0, yearToDateStartIndex(rows.map((row) => row.date), rows[0]?.interval, venue))) : rows;
  // October's monthly bar on 16 Oct runs through the 15th: marked partial, and the status line says how far.
  const forming = formingPeriodBar(served, venue);
  // A complete one is dated by the day its last session closed, the day its close is from.
  const closedDay = forming ? null : closedPeriodBarDay(served, venue);
  const data = forming?.rows ?? served;
  const interval = data[0]?.interval ?? null;
  // Intraday bars print in UTC, as the charts and time and sales label them, not the host zone.
  const intraday = data.some((row) => row.date.length > 10);
  // A bar history: dated by its last bar, stale once bars of its size stop arriving.
  // The day's own bar, while its session trades, is not a close: dated by the quote it was read from.
  const dayToDate = fromQuote && interval === "1d" && data.at(-1)?.partial === true;
  // Signed out or free, the bars of a session in progress run as late as the delayed quote they end on, and say how late.
  const sessionTrading = quote?.marketState === "REGULAR" || quote?.marketState === "PRE" || quote?.marketState === "POST";
  const delayedTail = quote?.dataSource === "delayed" && !quote.delisting && (dayToDate || (intraday && sessionTrading));
  // The source that served the bars, a broker or another source when Gloom Cloud could not.
  const source = loaded.sourceName ? { source: loaded.sourceName } : {};
  // A coin's volume unit, or what an index's volume counts (a day's total, an intraday count).
  const volumeNote = historyVolumeNote(volume, interval, historyVolumeBasis(data));
  // A window that closed before today is the history asked for: no later bar makes it stale.
  const freshness = withSavedCopy(window && isPastPriceWindow(window) ? rowsFreshness(data, {
    ...source,
    status: "not-a-feed", basis: `${interval ? BAR_INTERVAL_LABELS[interval] : "price"} bars, ${priceWindowText(window)}`, observedKey: "date", oldest: null,
    ...(volumeNote ? { note: volumeNote } : {}),
  }) : rowsFreshness(data, {
    ...source,
    ...barHistoryFreshness(intraday ? null : barResolutionFromDates(data.map((row) => row.date))),
    observedKey: "date",
    oldest: null,
    cadenceExchange: venue,
    // An intraday bar is dated by its open, so the line names its span: `last bar 15:00–16:00 UTC`.
    ...(intraday && interval && interval in CHART_RESOLUTION_STEP_MS ? { barMinutes: CHART_RESOLUTION_STEP_MS[interval] / 60_000 } : {}),
    ...(forming ? { periodToDate: forming.periodToDate } : closedDay ? { asOf: closedDay } : {}),
    ...(dayToDate ? { basis: "daily bars", ...(quote && Number.isFinite(quote.lastUpdated) ? { asOf: new Date(quote.lastUpdated).toISOString() } : {}) } : {}),
    ...(delayedTail ? { status: "delayed" as const, delayMinutes: CLOUD_QUOTE_DELAY_MINUTES } : {}),
    ...(volumeNote || dayToDate ? { note: [volumeNote, dayToDate ? `the newest bar is ${DAY_SO_FAR_TEXT}` : null].filter(Boolean).join("; ") } : {}),
  // The rows are drawn from the bars served, which say whether they are the saved copy.
  }), loaded);
  const gaps = historyGapNote(data, traded);
  const coverage = window ? historyCoverageNotice(loaded.coverageStart, Date.parse(`${window.from}T00:00:00Z`), loaded.coverageNote)
    : range === "YTD" ? null : historyCoverageWarning(range, loaded);
  const notes = [
    // A window the source has no bar in (a typo, a weekend, a listing that had not started) is said, not an empty table alone.
    ...data.length === 0 ? [emptyHistoryNote(listing.key, ask)] : [],
    // FB's bars are the fund listed there now; META's from 2021 are from when it was FB.
    ...fate ? listingFateNotes(await fate(), { served: data.length > 0, firstDate: data[0]?.date }) : [],
    ...lookups ? await listingChoiceNotes(listing, market, quote, venues) : [],
    // ALL says where the source's bars start (BTC-USD's in 2014-09), unless the coverage line does.
    ...window ? [...windowHistoryNotes(window, data), coverage ?? []]
      : range === "YTD" ? ytdHistoryNotes(data) : [...historyNotes(range, interval, data[0]?.date, Date.now(), coverage != null), coverage ?? []],
    // The status line says how far a bar still forming runs; the note is for the bars it does not name.
    gaps ?? [], historyJumpNote(data) ?? [], historyFlagNote(data) ?? [], historyWickNote(data) ?? [], historyMissingVolumeNote(data) ?? [],
    historyVenueVolumeNote(data) ?? [],
    // NG=F's rows are November's to the 23rd and December's from the 26th: each roll named, and thin bars said.
    historyRollNote(listing.symbol, data) ?? [], historyThinNote(data) ?? [],
    historyBarStatusNote(forming ? served : data, { tradingDay: venueTradingDay(venue, Date.now()) }) ?? [],
  ].flat();
  return {
    listing, identity, unit, data, resolution, interval, intraday, volume, freshness, notes,
    decimals: historyPriceDecimals(data, listing.saved?.metadata.assetCategory, priceDivisor),
  };
}

/**
 * A continuous future's history is the front month's, not the contract its
 * quote names now: NG=F's rows from before the roll are November's under a
 * quote of "Natural Gas Dec 2026". The heading says "Natural Gas front month"
 * once the bars name their contracts.
 */
function frontMonthIdentity(identity: ListingIdentity, symbol: string, rows: readonly HistoryRow[]): ListingIdentity {
  if (!/=F$/i.test(symbol) || !rows.some((row) => row.contract)) return identity;
  const board = futuresBoardContract(symbol);
  const name = board?.name ?? identity.name?.replace(/\s+[A-Z][a-z]{2}\s+\d{4}$/, "");
  return name ? { ...identity, name: `${name} front month` } : identity;
}

/** What a listing with no bar for what was asked says, in a warning and in a list's status column. */
function emptyHistoryNote(symbol: string, { range, window }: HistoryAsk): string {
  return window ? `No bars for ${symbol} from ${priceWindowText(window)}.` : `No bars for ${symbol} in ${range}.`;
}

/** A bar's prices to the decimals its history prints them to. */
function historyPrice(decimals: number) {
  return (value: unknown) => typeof value === "number" ? value.toFixed(decimals) : "";
}

/** The columns a history table prints: Time in UTC for intraday bars, prices to `price`'s decimals. */
function historyTextColumns(intraday: boolean, price: (value: unknown, row: Record<string, unknown>) => string): CliResultColumn[] {
  return [
    intraday
      ? { key: "date", header: "Time", format: (value) => typeof value === "string" ? formatUtcTime(value) : "" }
      : { key: "date", header: "Date" },
    { key: "open", header: "Open", align: "right", format: price },
    { key: "high", header: "High", align: "right", format: price },
    { key: "low", header: "Low", align: "right", format: price },
    { key: "close", header: "Close", align: "right", format: price },
    { key: "volume", header: "Volume", align: "right", format: formatCountCell },
  ];
}

/**
 * The volume a table prints: a bar with one venue's count in place of the
 * market's shows it beside the venue, never as its volume, and a bar without
 * volume in a history that reports it prints as missing, never as 0 or blank.
 */
function historyVolumeCell(missingVolume: (row: Record<string, unknown>) => string) {
  return (value: unknown, row: Record<string, unknown>) => formatCountCell(value)
    || (typeof row.venueVolume === "number"
      ? cliStyles.muted(`${formatCountCell(row.venueVolume)} ${typeof row.volumeVenue === "string" ? row.volumeVenue : ""}`.trim())
      : missingVolume(row));
}

/** Text marks a bar still forming, rebuilt from hourly bars or closing before its settlement beside its flag; exports keep them as columns. */
const HISTORY_FLAG_TEXT_COLUMN: CliResultColumn = {
  key: "flag",
  header: "Flag",
  format: (value, row) => [
    typeof value === "string" ? cliStyles.warning(value) : "",
    row.partial ? cliStyles.muted("partial") : "",
    row.filled ? cliStyles.muted("filled") : "",
    row.unsettled ? cliStyles.muted("unsettled") : "",
    row.roll && typeof row.contract === "string" ? cliStyles.muted(`roll to ${row.contract}`) : "",
    row.thin ? cliStyles.muted("thin") : "",
    typeof row.status === "string" ? cliStyles.warning(row.status) : "",
  ].filter(Boolean).join(" "),
};

/** The dates `--from` and `--to` (or `--start` and `--end`) name, each given once. */
function historyWindowOption(args: string[], rangeOption: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): PriceWindow | null {
  const bound = (flag: string, alias: string) => {
    const value = takeOption(args, flag);
    const aliased = takeOption(args, alias);
    if (value != null && aliased != null) ctx.fail(`${alias} is ${flag}; give one of them.`, `Usage: gloom ${HISTORY_USAGE}`);
    return { value: value ?? aliased, flag: aliased != null ? alias : flag };
  };
  const typedFrom = bound("--from", "--start");
  const typedTo = bound("--to", "--end");
  // Every message names the options as typed: an --end alone asks for a --start, not a --from.
  const from = { ...typedFrom, flag: typedFrom.value == null && typedTo.flag === "--end" ? "--start" : typedFrom.flag };
  const to = { ...typedTo, flag: typedTo.value == null && from.flag === "--start" ? "--end" : typedTo.flag };
  let window: PriceWindow | null;
  try {
    window = readPriceWindow(from.value, to.value, new Date(), undefined, { from: from.flag, to: to.flag });
  } catch (error) {
    return ctx.fail(errorMessage(error) ?? `Invalid ${from.flag} or ${to.flag}.`, `Usage: gloom ${HISTORY_USAGE}`);
  }
  if (window && rangeOption != null) ctx.fail(`${from.flag} replaces --range; give one of them.`, `Usage: gloom ${HISTORY_USAGE}`);
  return window;
}

/** How many symbols of a list load at once: enough that a few hundred take a minute or two, not one call after another. */
const HISTORY_LIST_CONCURRENCY = 8;

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const rangeOption = takeOption(args, "--range");
  // --from 2007 --to 2009: those years' bars, daily up to five years, in place of a range ending now.
  const window = historyWindowOption(args, rangeOption, ctx);
  const ask: HistoryAsk = { range: parseRange(rangeOption, ctx), window };
  const requestedExchange = takeOption(args, "--exchange");
  // One row a date and a close column a symbol, as a spreadsheet lays several series side by side.
  const wide = takeFlag(args, "--wide");
  // A list from a file or standard input (`-`), or several symbols typed (AAPL MSFT, AAPL,MSFT), is one long table.
  // One argument with spaces stays one, as before: it may be a company's name.
  const file = args.some((arg) => arg === "--file" || arg.startsWith("--file=")) ? takeOption(args, "--file") ?? "" : undefined;
  // `history swiss franc` is the franc's pair, not SWISS (a Copenhagen listing) and FRANC.
  const currency = file != null || requestedExchange ? null : currencyNameStop(args, "history");
  if (currency) ctx.fail(currency.message, currency.details);
  if (wide || file != null || args.includes("-") || uniqueEntries(args).length > 1 || args.some((arg) => /[,;]/.test(arg))) {
    return runHistoryList(args, file, requestedExchange, ask, ctx, { wide });
  }
  const raw = requireOneArg(args, HISTORY_USAGE, "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, requestedExchange, market, ctx);
    const history = await loadListingHistory(listing, market, ctx, ask, { lookups: true }).catch((error: unknown) => {
      // A word no source serves that names a currency (`history yen`) says which pair to ask for.
      const currency = !requestedExchange && isNoProviderError(error) ? currencyNameMiss(raw, "history") : null;
      if (currency) ctx.fail(currency.message, currency.details);
      throw error;
    });
    const { identity, unit, data, interval, intraday, volume, freshness, notes } = history;
    const price = historyPrice(history.decimals);
    // A bar without volume in a history that reports it prints as missing.
    const missingVolume = historyReportsVolume(data) ? MISSING_VOLUME_TEXT : "";
    const textColumns = historyTextColumns(intraday, price).map((column) => column.key !== "volume" ? column
      : { ...column, format: historyVolumeCell(() => missingVolume) });
    // The largest fall from a close to a later one in the bars shown, said under the heading: within one contract
    // of a continuous future, never from one month's close to another's across a roll.
    const contractDrawdown = historyContractDrawdown(data);
    const drawdown = contractDrawdown?.drawdown ?? null;
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        range: window ? null : ask.range,
        resolution: history.resolution,
        requestedRange: window ? null : ask.range,
        ...(window ? { requestedWindow: window } : {}),
        currency: unit.currency,
        unit: unit.unit,
        interval,
        firstDate: data[0]?.date ?? null,
        lastDate: data.at(-1)?.date ?? null,
        // The first bar after the last gap or jump; the first bar when there is none.
        unbrokenFrom: historyUnbrokenFrom(data) ?? data[0]?.date ?? null,
        bars: data.length,
        maxDrawdown: drawdown && contractDrawdown?.contract ? { ...drawdown, contract: contractDrawdown.contract } : drawdown,
        asOf: freshness?.asOf ?? null,
        ...(volume ? { volumeUnit: volume.unit, volumePeriod: interval === "1d" ? "UTC day" : interval } : {}),
      },
      ...(notes.length > 0 ? { warnings: notes } : {}),
      freshness,
    }, {
      heading: [listingHeading(frontMonthIdentity(identity, history.listing.symbol, data)), cliStyles.muted(historyFacts(unit, data).join("  ·  ")),
        ...drawdown && interval ? [cliStyles.muted(maxDrawdownText(drawdown, {
          basis: `${BAR_INTERVAL_LABELS[interval]} closes${contractDrawdown?.contract ? `, ${contractDrawdown.contract}` : ""}`, price,
          date: (text) => intraday ? formatUtcTime(text) : text.slice(0, 10) }))] : []].join("\n"),
      dateKey: "date",
      textColumns: [...textColumns, HISTORY_FLAG_TEXT_COLUMN],
      // One header whatever the market is doing, for one symbol as for a list (historyExportColumns).
      columns: historyExportColumns(data),
      exportStatus: historyExportStatus,
      // Every exported row says what it is a bar of, the currency a price is in and its bar size, so it survives head and concatenation.
      // A pair's rate is in its quote currency per base: JPY per USD, as the JSON's unit and every other export say.
      exportIdentity: { symbolOrSeries: history.listing.key, currencyOrUnit: historyExportUnit(unit), interval },
    });
  });
}

/** A symbol of a list: its bars, or why it has none. */
type ListedHistory = { symbol: string; history: ListingHistory } | { symbol: string; error: string };

/**
 * `history USDJPY=X USDCHF=X EURCHF=X --wide`: one row a date and one close
 * column a symbol, its unit in the header (`USDJPY=X close (JPY per USD)`),
 * as a spreadsheet sets several series side by side. A symbol with no bar on
 * a date (another market's holiday) leaves its cell blank. `interval` is the
 * bars' size when every symbol came in one, else null.
 */
function wideHistoryTable(served: readonly ListingHistory[]): {
  rows: Array<Record<string, string | number | null>>;
  columns: CliResultColumn[];
  interval: string | null;
} {
  const histories = served.filter((history, index) => served.findIndex((other) => other.listing.key === history.listing.key) === index);
  const key = (history: ListingHistory) => `close:${history.listing.key}`;
  const dates = [...new Set(histories.flatMap((history) => history.data.map((row) => row.date)))].sort();
  const closes = histories.map((history) => new Map(history.data.map((row) => [row.date, row.close] as const)));
  const rows = dates.map((date) => Object.fromEntries([
    ["date", date],
    ...histories.map((history, index) => [key(history), closes[index]!.get(date) ?? null] as const),
  ]));
  const intervals = new Set(histories.map((history) => history.interval));
  return {
    rows,
    columns: [
      { key: "date", header: histories.some((history) => history.intraday) ? "Time" : "Date" },
      ...histories.map((history): CliResultColumn => {
        const unit = historyExportUnit(history.unit);
        const price = historyPrice(history.decimals);
        return {
          key: key(history), header: `${history.listing.key} close${unit ? ` (${unit})` : ""}`, align: "right",
          format: (value) => value == null ? "" : price(value),
        };
      }),
    ],
    interval: intervals.size === 1 ? [...intervals][0] ?? null : null,
  };
}

/**
 * `history --file holdings.txt` (or several symbols, or `-` for standard
 * input): every symbol's bars in one long table, `HISTORY_LIST_CONCURRENCY`
 * symbols loading at once. A symbol that serves nothing is one row with its
 * reason in `status`, and a warning; the command fails only when none served.
 */
async function runHistoryList(
  args: string[],
  file: string | undefined,
  exchange: string | undefined,
  ask: HistoryAsk,
  ctx: Parameters<CliCommandDef["execute"]>[1],
  { wide = false }: { wide?: boolean } = {},
) {
  const usage = `Usage: gloom ${HISTORY_USAGE}`;
  await withMarketData(ctx, async (market) => {
    const list = await readListedSymbols(args, file, market, ctx, usage);
    const refused = list.symbols.flatMap((symbol) => notASymbolError(symbol) ?? []);
    const symbols = list.symbols.filter((symbol) => !notASymbolError(symbol));
    if (symbols.length === 0) ctx.fail(refused.length === 1 ? refused[0]!.message : `No history to read: ${refusedList(refused)} are not symbols.`, usage);
    // A long list is a batch, not a lookup: it skips the per-symbol venue and moved-company lookups, as `quote` does.
    const lookups = symbols.length <= MAX_CHOICE_LOOKUPS;
    const listed = await mapWithConcurrency(symbols, HISTORY_LIST_CONCURRENCY, async (symbol): Promise<ListedHistory> => {
      try {
        const listing = await resolveCliListing(symbol, exchange, market, { ownExchangeWins: true });
        return { symbol, history: await loadListingHistory(listing, market, ctx, ask, { lookups }) };
      } catch (error) {
        const message = errorMessage(error) ?? `No history for ${symbol}`;
        return { symbol, error: isCliFailure(error) ? oneLineFailure(message, error.details) : message };
      }
    });
    const served = listed.flatMap((entry) => "history" in entry && entry.history.data.length > 0 ? [entry.history] : []);
    // A symbol with no bars, whether its request failed or came back empty, is one row with the reason.
    const rows: HistoryListRow[] = listed.flatMap((entry) => "history" in entry
      ? entry.history.data.length > 0
        ? entry.history.data.map((row) => ({ symbol: entry.history.listing.key, ...row }))
        : [historyFailureRow(entry.history.listing.key, emptyHistoryNote(entry.history.listing.key, ask))]
      : [historyFailureRow(entry.symbol, entry.error)]);
    const bySymbol = new Map(served.map((history) => [history.listing.key, history] as const));
    const notes = [
      ...list.notes,
      ...refused.length > 0 ? [`Not ${refused.length === 1 ? "a symbol" : "symbols"}, no history read: ${refusedList(refused)}.`] : [],
      ...symbolListNotes(listed.map((entry) => ({
        symbol: "history" in entry ? entry.history.listing.key : entry.symbol,
        notes: "history" in entry ? entry.history.notes : [entry.error],
      }))),
    ];
    // The closing lines date the list by its newest bar; each row's as_of is its own symbol's.
    const lastBars = served.flatMap((history) => history.data.at(-1) ?? []);
    const pastWindow = ask.window && isPastPriceWindow(ask.window);
    const listFreshness = served.length === 0 ? undefined : rowsFreshness(lastBars, pastWindow && ask.window ? {
      status: "not-a-feed", basis: `price bars, ${priceWindowText(ask.window)}`, observedKey: "date", oldest: null,
    } : {
      ...barHistoryFreshness(served.some((history) => history.intraday) ? null : served[0]!.interval ?? "1d"),
      observedKey: "date",
      oldest: null,
    });
    // A saved copy is marked on the bars a symbol loaded, not on the rows drawn from them (loadListingHistory
    // reads it there): the list ends "couldn't refresh; saved copy from <time>" for the oldest copy among its symbols.
    const savedAt = served.flatMap((history) => history.freshness?.savedAt ?? []).sort()[0];
    const freshness = listFreshness && savedAt && !listFreshness.savedAt ? { ...listFreshness, savedAt } : listFreshness;
    const symbolsMetadata = listed.map((entry) => "history" in entry ? {
      ...listingMetadata(entry.history.identity),
      currency: entry.history.unit.currency,
      unit: entry.history.unit.unit,
      interval: entry.history.interval,
      firstDate: entry.history.data[0]?.date ?? null,
      lastDate: entry.history.data.at(-1)?.date ?? null,
      bars: entry.history.data.length,
      asOf: entry.history.freshness?.asOf ?? null,
    } : { symbol: entry.symbol, error: entry.error });
    if (wide) {
      const table = wideHistoryTable(served);
      ctx.printResult({
        data: table.rows,
        metadata: {
          range: ask.window ? null : ask.range,
          requestedRange: ask.window ? null : ask.range,
          ...(ask.window ? { requestedWindow: ask.window } : {}),
          symbols: symbolsMetadata,
        },
        ...(notes.length > 0 ? { warnings: notes } : {}),
        ...(served.length === 0 ? { failure: { code: "cli_error", message: `No history for ${symbols.join(", ")}.` } } : {}),
        freshness,
        ...(freshness ? {} : { exportFreshness: rowsFreshness([], { status: "not-a-feed", basis: "price bars" }) }),
      }, {
        dateKey: "date",
        columns: table.columns,
        // The unit is in each close column's header; a row of several symbols has no one symbol or unit to name.
        exportIdentity: { symbolOrSeries: null, currencyOrUnit: null, interval: table.interval },
      });
      if (served.length === 0) process.exitCode = CLI_EXIT_CODES.error;
      return;
    }
    const decimals = (row: Record<string, unknown>) => bySymbol.get(String(row.symbol))?.decimals ?? 2;
    const intraday = served.some((history) => history.intraday);
    const textColumns = historyTextColumns(intraday, (value, row) => historyPrice(decimals(row))(value)).map((column) => column.key !== "volume" ? column
      : { ...column, format: historyVolumeCell((row) => {
        const history = bySymbol.get(String(row.symbol));
        return history && row.date && historyReportsVolume(history.data) ? MISSING_VOLUME_TEXT : "";
      }) });
    ctx.printResult({
      data: rows,
      metadata: {
        range: ask.window ? null : ask.range,
        requestedRange: ask.window ? null : ask.range,
        ...(ask.window ? { requestedWindow: ask.window } : {}),
        // Each symbol as a single `history` describes it, or the reason it has no bars.
        symbols: symbolsMetadata,
      },
      ...(notes.length > 0 ? { warnings: notes } : {}),
      ...(served.length === 0 ? { failure: { code: "cli_error", message: `No history for ${symbols.join(", ")}.` } } : {}),
      freshness,
      // With no bars to date, an export still ends its rows with what each is of, under the same header.
      ...(freshness ? {} : { exportFreshness: rowsFreshness([], { status: "not-a-feed", basis: "price bars" }) }),
    }, {
      seriesKey: "symbol",
      dateKey: "date",
      textColumns: [{ key: "symbol", header: "Symbol", shrink: false }, ...textColumns,
        { key: "currency", header: "Cur", shrink: false, format: currencyCell }, HISTORY_FLAG_TEXT_COLUMN],
      columns: historyExportColumns(rows),
      exportStatus: historyExportStatus,
      // Every row names its symbol, the currency its prices are in, its bar size and the as-of of its own symbol's bars.
      exportIdentity: (row) => {
        const history = bySymbol.get(String(row.symbol));
        return {
          symbolOrSeries: String(row.symbol),
          currencyOrUnit: history ? historyExportUnit(history.unit) : null,
          interval: history?.interval ?? null,
          // A symbol with no bars has no as-of of its own.
          asOf: history ? history.freshness?.asOf ?? undefined : null,
        };
      },
    });
    // The table and the warnings name each symbol with no bars; with none served, the exit status says so too.
    if (served.length === 0) process.exitCode = CLI_EXIT_CODES.error;
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

/** A symbol as typed in capitals (`NEE`, `BP:LSE`, `7203.T`), never a word of a company's name. */
const TYPED_SYMBOL = /^[A-Z0-9][A-Z0-9.:^=&-]{0,15}$/;

/**
 * The symbols of a command given several where it takes one: `NEE FSLR` as
 * two words, or as one (`"NEE FSLR"`, `NEE,FSLR`). One word with spaces is
 * a list only when every part is a symbol as typed, so a company's name
 * (`"Bank of America"`) is still searched for. Null for one symbol.
 */
export function comparedSymbols(args: readonly string[]): string[] | null {
  const words = args.flatMap((arg) => arg.split(/[\s,]+/)).filter(Boolean);
  if (words.length < 2) return null;
  if (args.length > 1 || args.some((arg) => arg.includes(","))) return words;
  return words.every((word) => TYPED_SYMBOL.test(word)) ? words : null;
}

async function runFinancials(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], view: FinancialsView) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const sectionFlag = args.some((arg) => arg === "--section" || arg.startsWith("--section="));
  const section = takeOption(args, "--section");
  const commandName = view === "statements" ? "financials" : view;
  // `fundamentals --tax-rate 40.8 [--state-rate 9.3 --state CA]`: a muni fund's tax-equivalent yield and muni/Treasury ratio.
  let rates: TaxRates | null = null;
  if (view === "fundamentals") {
    const taken = (flag: string) => {
      const given = args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
      const value = takeOption(args, flag);
      if (given && !value?.trim()) ctx.fail(`${flag} needs a value, such as --tax-rate 40.8 --state-rate 9.3 --state CA.`);
      return value;
    };
    try {
      rates = parseTaxRates({ taxRate: taken("--tax-rate"), stateRate: taken("--state-rate"), state: taken("--state") });
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : String(error));
    }
  }
  const tabular = ctx.cliOptions.format === "csv" || ctx.cliOptions.format === "ndjson";
  if (sectionFlag && !tabular) ctx.fail("--section picks one table of --csv or --ndjson output.");
  if (sectionFlag && !section?.trim()) ctx.fail("--section needs a section title or number.");
  // Several symbols are a comparison, which RV draws side by side.
  const compared = view === "valuation" ? comparedSymbols(args) : null;
  if (compared) {
    ctx.fail(`valuation takes one symbol; got ${compared.join(" ")}.`,
      `To compare their valuations side by side: gloom fn RV ${compared.join(",")}\nUsage: gloom valuation <symbol>`);
  }
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
    const loaded = await loadForListing(listing, market, ctx, () => market.dataProvider.getTickerFinancials(
      listing.request.symbol, listing.request.exchange, { cacheMode: ctx.cliOptions.refresh ? "refresh" : "default" },
    ), undefined, { command: commandName, noun: commandName === "valuation" ? "valuation data" : commandName });
    // A converted TTM block at the rate `fx` reports, as `ticker` shows it; only the US dollar legs are read.
    const financials = view === "statements" ? loaded
      : await atReportTtmRate(loaded, createBaseConverter(market.dataProvider, "USD"));
    // A trailing yield is measured from the cash history as DVD measures it, a forward yield dated ahead names the
    // declared distribution it annualizes (not in JSON), and one whose dividend stopped says so; read beside the listing notes.
    const distributions = view === "statements" ? null : loadDividendDistributions(
      market.dataProvider, listing.request, financials, { declared: ctx.cliOptions.format !== "json" });
    // A fund's facts: its bond figures beside its distribution yield, and whether fn ETF has any to point to.
    const fundFacts = view === "statements" ? null : loadReportFundFacts(listing.request.symbol,
      financials.quote?.tradingExchangeName || listing.request.exchange || financials.quote?.listingExchangeName || financials.quote?.exchangeName,
      financials, listing.saved);
    const treasury = rates ? loadTreasuryTenors() : null;
    const identity = listingIdentity(listing, financials.quote);
    const choice = await listingChoiceNotes(listing, market, financials.quote, venues);
    const data: FinancialsCliData = {
      symbol: listing.key,
      exchange: identity.exchange,
      providerId: financials.quote?.providerId ?? null,
      ...financials,
    };
    if (view !== "statements") {
      // A valuation is measured at the quote's regular session price, so the quote dates it.
      const freshness = view === "valuation" ? valuationFreshness(financials) : fundamentalsFreshness(financials);
      // Market cap, the multiples and the yield at the regular session price, as the text gives them; the quote stays as sent.
      const priced = atRegularSessionPrice(financials);
      // One market cap per view: the share count times the price where the provider's sits more than 2% from it.
      const capitalization = viewMarketCapitalization(priced.quote, priced.fundamentals, regularSessionValuationPrice(priced.quote));
      // The filings behind the latest statements, and for a bank its deposits, uninsured share and CRE.
      const [statementFilings, bank] = view === "fundamentals"
        ? await Promise.all([
          loadStatementFilings(market.statementSources, listing.request, {
            quarter: latestFinancialPeriod(financials.quarterlyStatements, (row) => row.date),
            annual: latestFinancialPeriod(financials.annualStatements, (row) => row.date),
          }),
          loadBankFigures(market.statementSources, listing.request, financials),
        ])
        : [null, { bank: null, note: null }];
      const facts = await fundFacts;
      const bond = facts?.bond ?? null;
      // On the SEC yield when the sponsor publishes one, else the distribution yield the line above shows.
      const taxEquivalent = rates ? analyzeTaxEquivalent({
        symbol: identity.symbol || listing.key, bond, rates, treasury: await treasury,
        distribution: distributionBasis(priced.fundamentals?.dividendYield, priced.fundamentals?.dividendYieldBasis === "trailing" ? "trailing" : "forward"),
      }) : null;
      const report = { ...data, distributions: await distributions, statementFilings, bank: bank.bank, bankNote: bank.note, bondFund: bond, fundFacts: facts, taxEquivalent,
        // A base currency other than USD reads every amount with its code, as `ticker` does.
        currencyCodes: writesCurrencyCodes(market.config) };
      ctx.printResult({
        // JSON reads a multiple over a loss as null with its reason, never as a number.
        data: {
          ...data,
          ...view === "valuation" ? {
            ...getQuoteSessionFields(financials.quote),
            marketCap: capitalization?.value ?? null,
            marketCapCurrency: capitalization?.currency ?? null,
          } : {},
          fundamentals: priced.fundamentals && exportedDividendFundamentals(exportedFundamentals(priced.fundamentals)!, report.distributions),
          // A bond fund's sponsor figures; fundamentals.dividendYield is then its distribution yield, not its SEC yield.
          ...bond ? { bondFund: bond } : {},
          ...view === "fundamentals" ? { statementFilings, bank: bank.bank, ...bank.note ? { bankNote: bank.note } : {} } : {},
          ...taxEquivalent ? { taxEquivalent: taxEquivalentJson(taxEquivalent) } : {},
        },
        freshness,
        ...(choice.length > 0 ? { warnings: choice } : {}),
      }, {
        text: () => renderFundamentalsReport(report, view),
        ...(tabular ? { tables: selectTables(fundamentalsReportTables(report, view, freshness)) } : {}),
        exportIdentity: { symbolOrSeries: listing.key },
      });
      return;
    }
    const rows = financialStatementRows(data);
    const freshness = rowsFreshness(rows, {
      ...REPORTED_DATA, basis: "financial statements", observedKey: "date", oldest: null,
    });
    // The rows are the annual years served; older ones are not, and the closing lines say so, after how old
    // the latest year is when it ended over 15 months ago.
    const stale = stalePeriodNote(rows.map((row) => ({ date: row.date, lead: row.revenue != null })));
    // Years filled from the listing's exchange, for the revenue and net income columns.
    const filled = filledPeriodsNote(financials.annualStatements.filter((statement) => rows.some((row) => row.date === statement.date)),
      new Set(["totalRevenue", "netIncome"]));
    // GF is pointed to only when the listing's extended history goes further back than these years.
    const dates = rows.map((row) => row.date);
    const older = await hasOlderStatements(() => market.dataProvider.getTickerFinancials(listing.request.symbol, listing.request.exchange,
      { statementHistory: "extended" }), "annual", dates);
    const historyNotes = [...stale ? [stale] : [], ...filled ? [filled] : [], ...statementHistoryNotes("annual", dates, listing.key, older)];
    // NDJSON keeps the raw statement rows it always wrote; CSV gets the table and its closing lines.
    const tables = tabular
      ? selectTables({
        tables: [exportRowsTable("Annual statements", STATEMENT_COLUMNS, rows)],
        footer: reportFooterLines({ freshness, notes: historyNotes }),
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
        ...(historyNotes.length > 0 ? { notes: historyNotes } : {}),
      },
      freshness,
      ...(choice.length > 0 ? { warnings: choice } : {}),
    }, {
      heading: listingHeading(identity),
      rows: () => rows,
      columns: STATEMENT_COLUMNS,
      ...(historyNotes.length > 0 ? { footnote: historyNotes.join("\n"), exportNotes: historyNotes } : {}),
      ...(tables && ctx.cliOptions.format === "csv" ? { tables } : {}),
      // Annual statements in the company's reporting currency.
      exportIdentity: { symbolOrSeries: listing.key, currencyOrUnit: rows.find((row) => row.currency)?.currency ?? null, interval: "annual" },
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
  { key: "source", header: "Source" },
  { key: "title", header: "Title" },
  { key: "tickers", header: "Tickers" },
  // The short id `fn news-story-pane` opens the story by; exports keep the whole id.
  { key: "id", header: "ID", format: (value: unknown) => typeof value === "string" ? shortStoryId(value) : "" },
  { key: "url", header: "URL", optional: true },
];

/**
 * A story's summary under its row, on one line, cut to the width (`rowNote`): the figure a headline leaves out.
 * None for a summary that only repeats the headline; exports keep the summary whole.
 */
const newsRowNote = (row: Record<string, unknown>) => typeof row.summary === "string"
  ? newsSummaryLine({ title: String(row.title ?? ""), summary: row.summary }) : null;

/**
 * Stories matching text, printed as a symbol's news is, under a line saying
 * what they match. A text naming a commodity that matched nothing says so and
 * offers its future's news when that has stories; `commodity: false` for the
 * future's own news, which is that route. A search that failed (`failure`,
 * its message) says so, with `empty`, the lookup's own answer, rather than
 * that no story matches.
 */
async function printNewsSearch(
  text: string,
  articles: NewsArticle[],
  { reason, empty, commodity = true, failure, ticker = null, closest = false }: {
    reason?: string;
    empty?: string;
    commodity?: boolean;
    failure?: string;
    /** The listing a coin pair's search stands in for. */
    ticker?: string | null;
    /** No story has every word: these are the ones with the most. */
    closest?: boolean;
  },
  ctx: Parameters<CliCommandDef["execute"]>[1],
) {
  const searched = failure === undefined;
  const named = searched && commodity && articles.length === 0 && commodityNamedIn(text) !== null;
  const route = named ? await commodityNewsRoute(text) : null;
  const closestReason = closest && articles.length > 0 ? closestStoriesReason(text) : null;
  ctx.printResult({
    data: articles,
    ...(searched ? {} : { warnings: [`Searching stories for "${text}" failed: ${failure}`] }),
    metadata: { ticker, search: text, feed: null, ...(closestReason ? { match: "closest" } : {}), ...(route ? { futuresNews: route.command } : {}) },
    freshness: rowsFreshness(newsRows(articles), cloudNewsFreshness(await cloudRealtimeAccess())),
  }, {
    heading: newsSearchHeading(text, [reason, closestReason].filter(Boolean).join("  ·  ") || undefined),
    rows: newsRows,
    columns: NEWS_COLUMNS,
    rowNote: newsRowNote,
    empty: named ? noStoriesMessage(text, route) : empty ?? (searched ? noStoriesMessage(text, null) : "No stories to show."),
  });
}

/** The ticker a metal's name is in capitals, when one answers to exactly that: GOLD, Gold.com Inc., for "gold". */
async function tickerOfWord(word: string, market: MarketContext): Promise<{ symbol: string; name: string | null } | null> {
  const symbol = word.toUpperCase();
  const listing = await resolveCliListing(symbol, null, market).catch(() => {
    // Intentional ignore: a word no listing answers to offers no ticker under the metal's news.
    return null;
  });
  if (!listing || listing.symbol.toUpperCase() !== symbol) return null;
  const quote = await loadListingQuote(market.dataProvider, listing);
  const identity = listingIdentity(listing, quote);
  return quote !== null || identity.name != null ? { symbol: listing.symbol, name: identity.name ?? null } : null;
}

/**
 * A metal's market news: the stories tagged METALS that mention
 * it, for its future, its board code or its name. Under them, the ticker its
 * name is in capitals, whose company news `news GOLD` keeps.
 */
async function printMetalNews(route: MetalNewsRoute, limit: number, ctx: Parameters<CliCommandDef["execute"]>[1], market?: MarketContext) {
  const search = searchNewsStories(route.metal, limit, [METALS_NEWS_TOPIC]).then((found) => ({ found, failure: undefined }), (error: unknown) => {
    logFailure("cli.commands-market", "Search metals news failed")(error);
    return { found: [] as NewsArticle[], failure: errorMessage(error) ?? "no answer" };
  });
  const word = route.word;
  const ticker = word
    ? await (market ? tickerOfWord(word, market) : withMarketData(ctx, (context) => tickerOfWord(word, context)))
      .catch(logFailure("cli.commands-market", "Read the ticker a metal's name is failed", null))
    : null;
  const { found, failure } = await search;
  const companyNews = ticker ? `gloom news ${ticker.symbol}` : null;
  ctx.printResult({
    data: found,
    ...(failure === undefined ? {} : { warnings: [`Searching metals stories for "${route.metal}" failed: ${failure}`] }),
    metadata: { ticker: null, search: route.metal, topics: [METALS_NEWS_TOPIC], feed: null, ...(companyNews ? { companyNews } : {}) },
    freshness: rowsFreshness(newsRows(found), cloudNewsFreshness(await cloudRealtimeAccess())),
  }, {
    heading: metalNewsHeading(route),
    rows: newsRows,
    columns: NEWS_COLUMNS,
    rowNote: newsRowNote,
    empty: failure === undefined ? noMetalStoriesMessage(route) : "No stories to show.",
    ...(ticker ? { footnote: `${word} ${cliArrow("→")} ${route.metal}'s market news. For ${ticker.name ?? ticker.symbol} (ticker ${ticker.symbol}), try: ${companyNews}` } : {}),
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
    if (exchangeOption || feed) ctx.fail(`${exchangeOption ? "--exchange" : "--feed"} goes with a symbol, not with text to search stories for.`, "Usage: gloom news <query>");
    const problem = newsSearchTextProblem(text);
    if (problem) ctx.fail(problem);
    const answer = await searchClosestNewsStories(text, limit);
    await printNewsSearch(text, answer.found, { closest: answer.closest }, ctx);
    return;
  }
  // A metal's future or name is its market's news, not a company's: GOLD in capitals stays Gold.com's.
  const metal = args.length === 1 && !exchangeOption && !feed ? metalNewsRoute(args[0]!) : null;
  if (metal) {
    await printMetalNews(metal, limit, ctx);
    return;
  }
  if (exchangeOption && !args[0]) ctx.fail("--exchange needs a symbol: gloom news <symbol> --exchange <code>");
  await withMarketData(ctx, async (market) => {
    const listing = args[0] ? await requireCliListing(args[0], exchangeOption, market, ctx) : null;
    const quoteLoad = listing ? loadListingQuote(market.dataProvider, listing) : Promise.resolve(null);
    // A coin pair's feed searches for the coin when no story is filed under the pair, by the name its quote gives.
    const coin = !!listing && !feed && isRoundTheClockCoin(listing.request.symbol, listing.request.exchange);
    const loadNews = async () => market.dataProvider.getNews({
      feed: feed ?? (listing ? "ticker" : "latest"),
      // Still set for news plugins that read the deprecated scope.
      scope: listing ? "ticker" : "global",
      ticker: listing?.request.symbol,
      exchange: listing?.request.exchange || undefined,
      limit,
      ...(coin ? { listingName: (await quoteLoad)?.name || listing!.saved?.metadata.name || undefined } : {}),
    });
    const [articles, quote] = await Promise.all([
      listing ? loadForListing(listing, market, ctx, loadNews, (found) => found.length === 0) : loadNews(),
      quoteLoad,
    ]);
    const searchedFor = listing ? articles[0]?.searchedFor : undefined;
    if (listing && searchedFor) {
      await printNewsSearch(searchedFor, articles, { reason: `no stories filed under ${listing.symbol}`, ticker: listing.key }, ctx);
      return;
    }
    const identity = listing ? listingIdentity(listing, quote) : null;
    const resolved = quote !== null || identity?.name != null;
    const unfiled = !!listing && !listing.exchange && !feed && articles.length === 0;
    // A future's news is its commodity's: news is filed under company tickers, so KC=F (or a bare code
    // no security keeps, CT) searches the stories of coffee, which the service matches to KC=F's links too.
    const future = unfiled && isFuturesInstrument(listing!.symbol, quote?.instrumentType)
      ? futuresBoardContract(listing!.symbol) ?? bareFuturesCode(args[0]) : null;
    const commodity = future ? commoditySearchName(future) : null;
    // A bare word no listing answers to is text, and so is a futures board code (TTF), which resolves
    // to its future: the stories that mention the word are the news.
    const word = commodity ?? (unfiled ? newsFallbackText(args[0]!) : null);
    const futuresCode = !!word && !!bareFuturesCode(word) && isFuturesInstrument(listing!.symbol, quote?.instrumentType);
    const reason = commodity ? `the commodity ${future!.symbol} trades`
      : !resolved ? "no ticker by that name" : futuresCode ? "a futures code, not a ticker" : null;
    const emptyMessage = (searched: boolean) => listing && identity
      ? newsEmptyMessage(searched && word ? word : listing.symbol, listingTitle(identity), quote, resolved, searched)
      : undefined;
    // A metal's board code no listing answers to (GC, SI) is the metal's market news.
    const metalCode = !resolved && unfiled && !exchangeOption ? metalCodeNewsRoute(args[0]!) : null;
    if (metalCode) {
      await printMetalNews(metalCode, limit, ctx, market);
      return;
    }
    if (word && reason) {
      // The lookup that found no ticker already answered; a search that fails leaves that answer.
      const search = await searchNewsStories(word, limit).then((found) => ({ found, failure: undefined }), (error: unknown) => {
        logFailure("cli.commands-market", "Search news stories failed")(error);
        return { found: [], failure: errorMessage(error) ?? "no answer" };
      });
      const searched = search.failure === undefined;
      await printNewsSearch(word, search.found, { reason, empty: emptyMessage(searched && !commodity), commodity: !commodity, failure: search.failure }, ctx);
      return;
    }
    const empty = emptyMessage(false);
    // A bare coin ticker read as another listing (ETH, the Grayscale fund) says where the coin is, as `quote` does.
    const read = listing ? [...listingReadNotes(listing), ...coinListingNotes(listing, quote)] : [];
    // A word that is also the company's name ("gold" for Gold.com Inc.) says once which ticker it found and how
    // to search the stories that mention it instead, when those stories are mostly about something else.
    const typed = args[0]?.trim() ?? "";
    const wordHint = listing && resolved && !listing.exchange && !feed && !exchangeOption && commonWordCandidate(typed, identity?.name)
      && wordMeansMore(await searchNewsStories(typed, 20).catch(logFailure("cli.commands-market", "Search news stories for a ticker word failed", [])), listing.symbol)
      ? `${typed} ${cliArrow("→")} ${identity?.name ?? listing.symbol} (ticker ${listing.symbol}). For stories that mention ${typed.toLowerCase()}, try: ${quotedSearchCommand(typed.toLowerCase())}`
      : null;
    ctx.printResult({
      data: articles,
      ...(read.length > 0 ? { warnings: read } : {}),
      metadata: { ticker: listing?.key ?? null, ...(identity ? listingMetadata(identity) : {}), feed: feed ?? null, ...(wordHint ? { textSearch: quotedSearchCommand(typed.toLowerCase()) } : {}) },
      freshness: rowsFreshness(newsRows(articles), cloudNewsFreshness(await cloudRealtimeAccess())),
    }, {
      ...(identity ? { heading: listingHeading(identity) } : {}),
      rows: newsRows,
      columns: NEWS_COLUMNS,
      rowNote: newsRowNote,
      ...(empty ? { empty } : {}),
      ...(wordHint ? { footnote: wordHint } : {}),
    });
  });
}

// Exports keep the columns they had and add the items after them: codes, then their names.
const FILING_COLUMNS = [
  { key: "filingDate", header: "Date" },
  { key: "form", header: "Form" },
  { key: "companyName", header: "Company", maxWidth: 24 },
  { key: "url", header: "URL", optional: true },
  { key: "items", header: "Items" },
  { key: "itemsLabel", header: "Item names" },
  { key: "pressReleaseUrl", header: "Press release URL" },
];

// The text table names the items before the URL, which a narrow terminal drops first. A current report's
// URL is its press release where it has one, the page its figures are on; exports keep both links.
const FILING_TEXT_COLUMNS = [
  { key: "filingDate", header: "Date" },
  { key: "form", header: "Form" },
  { key: "companyName", header: "Company", maxWidth: 24 },
  { key: "itemsLabel", header: "Items" },
  { key: "url", header: "URL", optional: true,
    format: (value: unknown, row: Record<string, unknown>) => String(row.pressReleaseUrl || (value ?? "")) },
];

/** The US listing the SEC files a symbol under, from the symbol's venues: NYSE for SAN's Banco Santander. */
async function registrantUsExchange(market: MarketContext, symbol: string, registrantName: string): Promise<string | null> {
  const venues = (await listingVenues(symbol, market).catch(logFailure("cli.commands-market", "Read listing venues for filings failed", [])))
    .filter((venue) => !nonUsSecListingVenue(symbol, venue.exchange) && !areDifferentCompanies(venue.name, registrantName));
  return (venues.find((venue) => isUsListingExchange(venue.exchange)) ?? venues[0])?.exchange ?? null;
}

/** ASX announcements as `filings` lists them for a listing that files nothing with the SEC. */
const ANNOUNCEMENT_COLUMNS = [
  { key: "date", header: "Released", format: (value: unknown) => typeof value === "string" ? `${value.slice(0, 16).replace("T", " ")} UTC` : "" },
  { key: "headline", header: "Headline", maxWidth: 60 },
  { key: "type", header: "Type", maxWidth: 36 },
  { key: "priceSensitive", header: "Price sensitive", format: (value: unknown) => value === true ? "yes" : "" },
  { key: "url", header: "URL", optional: true },
];

const ASX_ANNOUNCEMENTS = { source: "ASX company announcements", status: "not-a-feed", basis: "exchange announcements", oldest: null } as const;

function announcementRows(payload: ExchangeAnnouncementsPayload) {
  return payload.announcements.map((item) => ({
    date: item.date,
    headline: item.headline,
    type: item.types.join("; "),
    priceSensitive: item.priceSensitive,
    url: item.url,
  }));
}

async function runFilings(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  // Filings come newest first, so --tail asks for the same first n as --limit.
  const count = parsePositiveInt(takeOption(args, "--count"), ctx.cliOptions.tail ?? ctx.cliOptions.limit ?? 15, "Count", ctx);
  const exchangeOption = takeOption(args, "--exchange");
  const form = takeOption(args, "--form")?.trim() || null;
  const raw = requireOneArg(args, "filings <symbol> [--count <n>] [--form <form>]", "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    // NST.AX is NST:ASX, as quote, valuation and the pane functions read it: the SEC is asked by venue.
    const listing = await requireCliListing(raw, exchangeOption, market, ctx, { venueSuffix: true });
    const venues = loadBareVenues(listing, market);
    const { symbol, exchange } = listing.request;
    // A listing outside the US sends its company to the lookup, which needs its quote first.
    const quotePromise = loadListingQuote(market.dataProvider, listing);
    const identity = nonUsSecListingVenue(symbol, exchange) ? listingIdentity(listing, await quotePromise) : null;
    // Where a listing abroad publishes its announcements, whatever the SEC holds for it.
    const page = identity ? exchangeAnnouncementsPage(identity.symbol, identity.exchange) : null;
    const pageLine = page ? `${page.name}: ${page.url}` : null;
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
      // A company on ASX that files nothing with the SEC lists its ASX announcements instead.
      if (identity && filings.length === 0 && !form && listsExchangeAnnouncements(identity.exchange)) {
        await printExchangeAnnouncements(ctx, { resolved, count, choice, page: page! });
        return;
      }
      ctx.printResult({
        data: filingsWithItemLabels(filings),
        metadata: {
          ...listingMetadata(resolved), ...(form ? { form } : {}),
          ...(page ? { announcementsPage: page.url } : {}),
        },
        freshness: rowsFreshness(filingRows(filings), SEC_FILING_ROWS),
        ...(choice.length > 0 ? { warnings: choice } : {}),
      }, {
        heading: listingHeading(resolved),
        rows: filingRows,
        columns: FILING_COLUMNS,
        textColumns: FILING_TEXT_COLUMNS,
        // A listing abroad is looked up by its company: none found means the company files nothing with the SEC,
        // and the page its own exchange publishes its announcements on is where to read them.
        empty: [form ? `No ${form} filings found for ${listingTitle(resolved)}.`
          : identity ? noSecReportsNotice(resolved)
          : `No SEC filings found for ${listingTitle(resolved)}.`, pageLine].filter(Boolean).join("\n"),
        ...filingsFootnote(pageLine, filings[0]?.companyFrom),
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
        metadata: { ...listingMetadata(resolved), secRegistrant: error.registrantName, ...(page ? { announcementsPage: page.url } : {}) },
        warnings: ctx.cliOptions.format === "text" ? undefined : [message],
      }, { rows: filingRows, columns: FILING_COLUMNS, textColumns: FILING_TEXT_COLUMNS, empty: [message, pageLine].filter(Boolean).join("\n") });
    }
  });
}

/**
 * The lines `filings` prints under its rows and CSV writes as notes: an ASX
 * listing's announcements page, and whose filings a foreign line shows when
 * they are its company's home line's.
 */
function filingsFootnote(pageLine: string | null | undefined, companyFrom: CompanyFrom | undefined): { footnote?: string; exportNotes?: string[] } {
  const lines = [...(pageLine ? [pageLine] : []), ...companyDataNotes(companyFrom)];
  return lines.length ? { footnote: lines.join("\n"), exportNotes: lines } : {};
}

/**
 * `filings` for a company on ASX that files nothing with the SEC: its latest
 * ASX announcements from Gloom Cloud, newest first, under the line saying it
 * files no SEC reports, with its ASX announcements page. A failed read still
 * ends on that page, with the reason.
 */
async function printExchangeAnnouncements(
  ctx: Parameters<CliCommandDef["execute"]>[1],
  input: { resolved: ListingIdentity; count: number; choice: string[]; page: ExchangeAnnouncementsPage },
): Promise<void> {
  const { resolved, count, choice, page } = input;
  const notice = noSecReportsNotice(resolved);
  const pageLine = `${page.name}: ${page.url}`;
  let payload: ExchangeAnnouncementsPayload | null = null;
  let failure: string | null = null;
  try {
    payload = await apiClient.getCloudExchangeAnnouncements({ symbol: resolved.symbol, exchange: resolved.exchange, limit: Math.min(count, 50) });
  } catch (error) {
    failure = `ASX announcements unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const rows = payload ? announcementRows(payload) : [];
  const warnings = [
    ...choice,
    ...payload?.stale ? ["ASX could not be reached; these are the announcements Gloom Cloud read last."] : [],
    ...failure ? [failure] : [],
  ];
  ctx.printResult({
    data: rows,
    metadata: {
      ...listingMetadata(resolved), secFilings: 0, announcementsPage: payload?.page ?? page.url,
      ...(payload ? { announcementsTotal: payload.total, announcementsRetrievedAt: payload.retrievedAt } : {}),
    },
    freshness: rowsFreshness(rows, { ...ASX_ANNOUNCEMENTS, observedKey: "date" }),
    ...(warnings.length > 0 ? { warnings } : {}),
  }, {
    heading: listingHeading(resolved),
    ...(rows.length > 0 ? { summary: () => `${notice} Its latest ASX announcements:` } : {}),
    rows: () => rows,
    columns: ANNOUNCEMENT_COLUMNS,
    empty: `${failure ? notice : `${notice} ASX lists no announcements for it.`}\n${pageLine}`,
    footnote: pageLine,
    exportNotes: [notice, pageLine],
    exportIdentity: { symbolOrSeries: `${resolved.symbol}:${resolved.exchange}` },
  });
}

type Form4Insiders = "available" | "none" | "foreign-private-issuer" | "no-sec-reports";

/** The company's own Form 4 filings as `fn INS` reads them: whether it has any, and its summary of them. */
interface Form4Report {
  status: Form4Insiders;
  /** `fn INS`'s line of the last 90 days' open-market buys and sales in the filings read; null when it has none. */
  summary: string | null;
  /** The Form 4 lines in the filings read, and how many filings that was. */
  lines: number;
  filings: number;
  /** The newest filing's date (YYYY-MM-DD), which dates the report. */
  newestFiled: string | null;
  /** "Canadian insider reports (SEDI) not covered." beside the reason a company from abroad has none. */
  home: string | null;
}

/**
 * The company's Form 4 filings, read as `fn INS` reads its first page (its
 * latest 20 of its own) and summed up as it sums them; null when they could
 * not be read. A listing abroad the SEC lists nothing for files no SEC
 * reports at all, and a company from abroad with none names its home
 * market's insider reports as not covered either.
 */
async function loadForm4Report(market: MarketContext, listing: CliListing): Promise<Form4Report | null> {
  const { symbol, exchange } = listing.request;
  try {
    const { parsed, foreignPrivateIssuer, noFilings } = await loadParsedInsiderFilings(market.dataProvider, symbol, {
      limit: INSIDER_REPORT_FILINGS,
      exchange,
    });
    if (parsed.length > 0) {
      const filed = parsed.map(({ filing }) => new Date(filing.filingDate).getTime()).filter(Number.isFinite);
      return {
        status: "available",
        summary: buildInsiderSummary(parsed, Date.now(), parsed),
        lines: parsed.filter(({ transaction }) => transaction != null).length,
        filings: new Set(parsed.map(({ filing }) => filing.accessionNumber)).size,
        newestFiled: filed.length > 0 ? new Date(Math.max(...filed)).toISOString().slice(0, 10) : null,
        home: null,
      };
    }
    const status: Form4Insiders = noFilings && nonUsSecListingVenue(symbol, exchange) ? "no-sec-reports"
      : foreignPrivateIssuer ? "foreign-private-issuer" : "none";
    const home = await loadHomeInsiderReportsNote(market.dataProvider, listing.key, exchange, foreignPrivateIssuer);
    return { status, summary: null, lines: 0, filings: 0, newestFiled: null, home };
  } catch (error) {
    logFailure("cli.commands-market", "Read insider filings failed")(error);
    return null;
  }
}

/**
 * The insider lines under `insider`'s holders. A company's insiders file
 * Form 4, which 13F holder lists rarely name, so the report leads with
 * `fn INS`'s summary of the Form 4 filings and points to the transactions;
 * a company with none says why, in the words `fn INS` uses. The insider share
 * of the company follows when the holder data reports it.
 */
function insiderSummary(
  data: HolderData,
  listing: Pick<CliListing, "key">,
  identity: ListingIdentity,
  form4: Form4Report | null,
): string {
  const held = data.summary?.insidersPercentHeld;
  const share = held == null || !Number.isFinite(held)
    ? ""
    : `Insiders hold ${formatFractionPercentCell(held)} of shares outstanding.`;
  // The listing as the command read it (CAR:ASX), not the source's spelling of it (CAR.AX), which fn does not take.
  const transactions = form4?.status === "available"
    ? [
      ...form4.summary ? [form4.summary] : [],
      `${form4.lines} Form 4 ${form4.lines === 1 ? "line" : "lines"} in the latest ${form4.filings} ${form4.filings === 1 ? "filing" : "filings"}${form4.newestFiled ? `, newest filed ${form4.newestFiled}` : ""}: gloom fn INS ${listing.key}`,
    ].join("\n")
    : form4?.status === "no-sec-reports" ? [noSecReportsNotice(identity), form4.home].filter(Boolean).join(" ")
    : form4 ? insiderEmptyNotice(form4.status === "foreign-private-issuer", form4.home) : "";
  return [transactions, share].filter(Boolean).join("\n");
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
    market.dataProvider.getHolders?.(symbol, exchange).catch(logFailure("cli.commands-market", "Read company holders failed", null)) ?? null,
    quotePromise,
    // Today's share count, which the filed percents are set against.
    market.dataProvider.getTickerFinancials(symbol, exchange).catch(logFailure("cli.commands-market", "Read company financials for holders failed", null)),
  ]);
  const identity = listingIdentity(listing, quote);
  const sharesOutstanding = classSharesToday(financials);
  const rows = buildBeneficialReportRows(payload, { history, holders, sharesOutstanding });
  const notices = beneficialCoverageNotices(payload.coverage);
  const sharesOutstandingAsOf = classSharesAsOf(financials);
  const legend = beneficialReportLegend(rows, sharesOutstanding, sharesOutstandingAsOf);
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
      ...(sharesOutstandingAsOf ? { sharesOutstandingAsOf } : {}),
    },
  }, {
    heading: `${listingHeading(identity)}${cliStyles.muted(beneficialListFacts(payload, form, rows.length, history).map((fact) => `  ·  ${fact}`).join(""))}`,
    // Text draws each column as the HDS report does; CSV and JSON keep the raw values.
    textColumns: BENEFICIAL_REPORT_COLUMNS.map((column) => ({ ...column, format: column.textFormat ?? column.format })),
    // A foreign line's owners read from its company's home line say whose.
    ...(legend || payload.companyFrom ? { footnote: [legend, ...companyDataNotes(payload.companyFrom)].filter(Boolean).join("\n") } : {}),
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

/** Holder rows `holders` and `13f` print without `--limit`, as fn HDS does. */
const HOLDERS_DEFAULT_ROWS = 25;

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
    const institutional = !ownerTypes?.has("insider");
    const venues = loadBareVenues(listing, market);
    // A US line's institutions are every 13F filer, from the SEC holder index as fn 13F lists them,
    // as many as the limit asks (HDS's 25 by default); elsewhere, or when the index cannot be read, the source's few.
    const indexTicker = institutional ? indexHolderTicker(listing.request.symbol, listing.request.exchange) : null;
    // --tail counts back from the end of the rows loaded, so it loads at least as many as it asks for.
    const tail = ctx.cliOptions.tail;
    const indexLimit = Math.min(ctx.cliOptions.limit ?? Math.max(tail ?? 0, HOLDERS_DEFAULT_ROWS), HOLDER_ROWS_MAX);
    const quoted = loadListingQuote(market.dataProvider, listing);
    const [source, quote, form4, index] = await Promise.all([
      loadForListing(
        listing, market, ctx,
        () => market.dataProvider.getHolders(listing.request.symbol, listing.request.exchange),
        (found) => found.holders.length === 0,
        { command: commandName, noun: "holder data" },
      ).catch(async (error: unknown) => {
        // A fund has no ownership breakdown: say so, and what reads it, rather than the source's NO_DATA.
        const fund = await fundHoldersAnswer(listing.symbol, error, await quoted, apiClient);
        if (fund) fail(fund.message, fund.details.join("\n") || undefined, NO_DATA_CODE);
        throw error;
      }),
      quoted,
      insiderCommand ? loadForm4Report(market, listing) : null,
      indexTicker ? loadIndexedHolders(indexTicker, indexLimit).catch(logFailure("cli.commands-market", "Read the 13F holder index failed", null)) : null,
    ]);
    const indexed = !!index?.rows.length && indexHolderTicker(listing.request.symbol, listing.request.exchange, source) != null;
    const data = indexed
      ? withIndexedHolders(source, indexTicker!, { ...index!, rows: index!.rows.slice(0, indexLimit) }, indexedHolderUnits(source, quote?.price))
      : source;
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
    const total = institutional ? data.summary?.institutionsCount ?? null : null;
    const reportDate = sharedReportDate(rows);
    const valueBasis = rows.length > 0 ? holderValueBasis(reportDate, data.valueBasis, valueCurrency) : null;
    const positionsBasis = rows.length > 0 ? nonUsHolderCaveat(identity.exchange || data.exchange, data.currency) : null;
    const shareBasisNote = holderShareBasisNote(data, rows);
    const markedRows = rows.some((row) => holderShareBasisMarker(row));
    // The heading names the listing; its unit, date and how much of the list follows on the same line.
    // One "as of" only when every row shown is of that date; each row carries its own.
    // An insider list the 13F filings name nobody in is not "none reported": the Form 4 summary under it says what insiders did.
    const form4Only = insiderCommand && rows.length === 0;
    const facts = form4Only ? [] : holderListFacts({
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
    // Dated as HDS dates it: by the list's as-of; an insider report of Form 4 filings alone as INS dates it, by the newest.
    const freshness = form4Only
      ? rowsFreshness(form4?.newestFiled ? [{ filingDate: form4.newestFiled }] : [], { ...SEC_FILING_ROWS, basis: "Form 4 filings" })
      : rowsFreshness(shownRows, { ...SEC_FILINGS, basis: "13F filings" }, { asOf: data.asOf ?? null });
    // Named as fn HDS takes it, so the closing notes point to the same listing.
    const requested = exchangeOption && !raw.includes(":") ? `${raw}:${exchangeOption.toUpperCase()}` : raw;
    const { notices } = holderReportNotices({ data, requested, shown: shownRows, reported: rows.length, total, indexed });
    // The index's smallest filers are pages past what was loaded: --tail is the end of the loaded rows, not of every filer.
    const tailNote = indexed && tail != null && total != null && rows.length < total
      ? `--tail ${tail} is the last ${shown} of the largest ${rows.length} loaded, not the smallest of all ${total.toLocaleString("en-US")} holders.`
      : null;
    const partialNote = indexed ? indexedHoldersPartialNote(index, indexLimit) : null;
    const warnings = [...choice, ...(partialNote ? [partialNote] : []), ...(tailNote ? [tailNote] : [])];
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
        ...(insiderCommand ? {
          form4Insiders: form4?.status ?? null,
          // INS's summary of the latest Form 4 filings, as `fn INS` gives it in its metadata.
          form4: form4 ? { summary: form4.summary, lines: form4.lines, filings: form4.filings, newestFiled: form4.newestFiled, notCovered: form4.home } : null,
        } : {}),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
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
      exportIdentity: { symbolOrSeries: listing.key },
      summary: () => [
        [valueBasis ? `Value = ${valueBasis}.` : "", positionsBasis ?? "", shareBasisNote ?? "", unvaluedNote ?? ""].filter(Boolean).join(" "),
        insiderCommand ? insiderSummary(data, listing, identity, form4) : "",
      ].filter(Boolean).join("\n"),
      empty: `No holders reported for ${listingTitle(identity)}.`,
      // Holders read from the company's home line say whose; the SEC index's are the listing's own.
      ...(!indexed && data.companyFrom ? { footnote: companyDataNotes(data.companyFrom).join("\n") } : {}),
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
    const { upside, reference } = analystUpside(data, quote);
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        recommendationRating: data.recommendationRating,
        priceTarget: data.priceTarget,
        recommendations: data.recommendations,
        upside: upside ?? null,
        upsideReference: analystReferenceMetadata(reference),
      },
      freshness: rowsFreshness(analystRows(data), {
        ...REPORTED_DATA, basis: "analyst ratings", observedKey: "date", oldest: null,
      }, { stale: data.stale === true }),
      ...(choice.length > 0 ? { warnings: choice } : {}),
    }, {
      heading: listingHeading(identity),
      rows: analystRows,
      summary: (research) => analystSummary(research, quote),
      rowNote: analystRowNote,
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
    // The earnings rows are resolved against the calendar `earnings` reads, so the next report is the same in both.
    const calendar = market.dataProvider.getEarningsCalendar?.([listing.key])
      .catch(logFailure("cli.commands-market", "Read the earnings calendar for events failed", [] as EarningsEvent[]));
    const [recorded, quote, events] = await Promise.all([
      loadForListing(
        listing, market, ctx, () => market.dataProvider.getCorporateActions(listing.request.symbol, listing.request.exchange),
        undefined, { command: "events", noun: "corporate events" },
      ),
      loadListingQuote(market.dataProvider, listing),
      calendar,
    ]);
    const data = withResolvedEarnings(recorded, calendarEventOf(events, listing.key), newYorkDay());
    const identity = listingIdentity(listing, quote);
    const choice = await listingChoiceNotes(listing, market, quote, venues);
    ctx.printResult({
      data,
      metadata: listingMetadata(identity),
      // Dated by when it was read, as EE and fn EVT date the same events: a row's
      // date is when the event happens, and the newest past one is no as-of.
      freshness: rowsFreshness([], { ...REPORTED_DATA, basis: "corporate actions", oldest: null }),
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
  const expirationOption = takeExpirationOption(args);
  const { value: expiration, flag: expirationFlag } = expirationOption;
  if (expirationOption.both) ctx.fail("--expiry is --expiration; give one of them.", `Usage: gloom ${OPTIONS_USAGE}`);
  const exchangeOption = takeOption(args, "--exchange");
  if (leapsOptions.leaps) {
    // With --leaps, --expiration is a window of one expiry.
    const criteria = parseLeapsCriteria({ ...leapsOptions.raw, ...expirationOption.given ? { "--expiration": expiration ?? "" } : {} });
    if ("error" in criteria) ctx.fail(criteria.error, `Usage: gloom ${LEAPS_USAGE}`);
    const entries = normalizeSymbols(args);
    if (entries.length === 0) ctx.fail("--leaps needs at least one symbol.", `Usage: gloom ${LEAPS_USAGE}`);
    await withMarketData(ctx, async (market) => runLeapsScreen(await readSymbols(entries, market.dataProvider), exchangeOption, criteria, market, ctx));
    return;
  }
  if (leapsOptions.given.length > 0) {
    ctx.fail(`${leapsOptions.given.join(", ")} only ${leapsOptions.given.length > 1 ? "apply" : "applies"} with --leaps.`, `Usage: gloom ${LEAPS_USAGE}`);
  }
  const raw = requireOneArg(args, OPTIONS_USAGE, "symbol", ctx);
  let expirationDate: number | undefined;
  if (expirationOption.given) {
    const parsed = expiration == null ? null : parseOptionExpiration(expiration);
    if (parsed == null) {
      ctx.fail(
        expiration == null ? `${expirationFlag} needs a date.` : `Invalid ${expirationFlag} "${expiration}".`,
        `Use ${OPTION_EXPIRATION_FORMAT}.${expiration == null ? "" : expirationHint(expiration)}\nUsage: gloom ${OPTIONS_USAGE}`,
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
    const fate = listingFateLoader(listing, market, quotePromise, { successor: true });
    const inputsPromise = loadOptionModelInputs(market.dataProvider, listing, quotePromise, refresh);
    const now = Date.now();
    // Expiries close on the listing's clock: a coin's options (Deribit) settle at 08:00 UTC on any day.
    const expiryVenue = optionExpiryVenue(symbol, exchange);
    const readChain = async (expiry: number | undefined) => {
      const cached = await market.dataProvider.getCachedQuery?.("getOptionsChain", [symbol, exchange, expiry, undefined])
        .load({ force: refresh });
      return {
        result: cached,
        chain: cached?.value ?? await market.dataProvider.getOptionsChain(symbol, exchange, expiry, {
          cacheMode: refresh ? "refresh" : "default",
        }),
      };
    };
    // An expiry whose last session has closed has no chain to show: it says so, and names the nearest live one.
    if (expirationDate != null && !isLiveOptionExpiry(expirationDate, now, expiryVenue)) {
      const listed = await readChain(undefined).then(({ chain }) => chain.expirationDates,
        logFailure("cli-market", "Read available option expirations failed", []));
      ctx.fail(`expiry ${expiryIsoDate(expirationDate)} for ${listing.key} `
        + expiredExpiryText(expirationDate, listed, now, { exchange: expiryVenue, flag: expirationFlag.slice(2) }),
      `Run gloom options ${listing.key} to list the live expiries.`);
    }
    const { result, chain: read } = await loadForListing(listing, market, ctx, async () => {
      const first = await readChain(expirationDate);
      // A source can still default to the expiry that lapsed at Friday's close; the nearest live one is shown instead.
      const live = expirationDate == null ? liveDefaultExpiry(first.chain, now, expiryVenue) : undefined;
      if (live === null) return { ...first, chain: { ...first.chain, calls: [], puts: [] } };
      if (live == null) return first;
      // The default's list stays the catalogue: a dated chain can list fewer expiries.
      const shown = await readChain(live);
      return { ...shown, chain: { ...shown.chain,
        expirationDates: [...new Set([...first.chain.expirationDates, ...shown.chain.expirationDates])].sort((a, b) => a - b) } };
    }, undefined, { command: "options", noun: "options chain", fate }).catch((error: unknown) => {
      if (!isOptionsUnavailableError(error)) throw error;
      // A coin other than BTC and ETH: say which coins have options, and the bitcoin-linked listings.
      if (isCoinWithoutOptions(listing.key)) return ctx.fail(optionsUnavailableTitle(listing.key), coinOptionsAlternativesText("options"));
      // A future or commodity with no chain of its own: name the listed fund whose options stand in.
      const alternative = listedOptionsAlternative(listing.key);
      // A name read as a fund or an index asks about the company's stock it means, whose options are listed.
      const meant = meantQuestion(listing);
      return ctx.fail(meant ? `${optionsUnavailableTitle(listing.key)} ${meant}` : optionsUnavailableTitle(listing.key), alternative
        ? `Nearest listed alternative: ${alternative.symbol} (${alternative.name}), gloom options ${alternative.symbol}.`
          + ` Strategy payoffs: gloom fn OSA ${alternative.symbol}`
        : "Strategy payoffs on a listed underlying: gloom fn OSA <ticker>");
    });
    const loaded = withLiveExpiryList(read, now, expiryVenue);
    const inputs = await inputsPromise;
    if (expirationDate != null && !chainHasExpiry(loaded, expirationDate)) {
      // An unlisted date comes back as an empty chain; its own list of expiries, else the default chain's, says what to pick.
      const listed = loaded.expirationDates.length > 0 ? loaded.expirationDates : await market.dataProvider
        .getOptionsChain(symbol, exchange, undefined, { cacheMode: "default" })
        .then((fallback) => liveOptionExpiries(fallback.expirationDates, now, expiryVenue),
          logFailure("cli-market", "Read available option expirations failed", []));
      const miss = missingExpiryMessage(listing.key, expirationDate, listed);
      ctx.fail(miss.message, miss.details);
    }
    const quote = await quotePromise;
    const identity = listingIdentity(listing, quote);
    // IV and delta are valued at one spot and instant, named under the table and on every exported row.
    const { chain, spot: modelSpot } = valueChainAtModelSpot(loaded, inputs, Date.now(), identity.exchange);
    const basis: OptionsChainBasis = { spot: modelSpot, dividendYield: inputs.dividendYield ?? null,
      openInterest: await loadOptionsChainOpenInterest(symbol, chain), ivFilled: chainHasFilledIv(chain) };
    const basisFields = optionsBasisFields(basis);
    const currency = [...chain.calls, ...chain.puts].find((contract) => contract.currency?.trim())?.currency.trim().toUpperCase()
      ?? quote?.currency ?? null;
    // A failed refresh falls back to the stored chain, which can be days old.
    const refreshWarning = result?.refreshError == null ? null
      : `Options refresh failed; showing the chain stored ${new Date(result.fetchedAt).toISOString()}`
        + (chain.asOf ? ` (last trade ${chain.asOf})` : "");
    const sessionWarning = refreshWarning ? null : priorSessionChainWarning(chain, identity.exchange, Date.now());
    // A venue that marks its contracts (Deribit) states IV and greeks without a quote.
    const marked = isMarkedChain(chain);
    const coin = chainCoinCurrency(chain);
    const modelWarning = !marked && inputs.spot == null && (chain.calls.length > 0 || chain.puts.length > 0)
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
    const contractCount = chain.calls.length + chain.puts.length;
    ctx.printResult({
      data: chain,
      metadata: {
        ...listingMetadata(identity),
        expirations: chain.expirationDates,
        currency,
        interval: OPTIONS_EXPORT_INTERVAL,
        // `iv` is annualised volatility and `delta` the option's change per 1.00 move in the underlying, both decimals.
        units: { iv: "annualized decimal", delta: "decimal per 1.00 move in the underlying" },
        // What each contract's `iv` and `impliedVolatility` are, so neither is read as the other.
        fields: marked ? MARKED_OPTION_FIELDS : OPTION_VOLATILITY_FIELDS,
        // What `iv` and `delta` on each contract are valued from; the provider's own impliedVolatility is left as sent.
        model: marked
          ? { venue: chain.venue ?? null, marks: "venue", rate: chain.rate ?? 0, basis: "the expiry's forward", coin }
          : {
            spot: basisFields.spot, spotBasis: basisFields.spotBasis, spotAsOf: basisFields.spotAsOf,
            valuationTime: modelSpot ? new Date(modelSpot.valuationTime).toISOString() : null,
            dividendYield: inputs.dividendYield ?? null, rate: OPTION_MODEL_RATE,
          },
        openInterest: { asOf: basisFields.openInterestAsOf, listedAsOf: basis.openInterest?.listedDate ?? null,
          compared: basis.openInterest?.compared ?? 0, matched: basis.openInterest?.matched ?? 0 },
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      freshness,
    }, {
      // Options a venue other than the US exchanges lists (Deribit's) are headed by that venue, not the coin's board.
      heading: chain.venue ? `${cliStyles.bold(identity.name || identity.symbol)}${cliStyles.muted(`  ·  ${chain.venue}`)}` : listingHeading(identity),
      rows: (data: OptionsChain) => optionRows(data).map((row) => ({ ...row, ...basisFields })),
      // Choosing an expiry needs the list; once one is chosen the table is that expiry.
      summary: (data: OptionsChain) => expirationDate == null ? formatExpiryList(data.expirationDates) : "",
      empty: `No option contracts for ${listingTitle(identity)}.`,
      ...(contractCount > 0 ? { footnote: optionsBasisFootnote(basis, chain) } : {}),
      exportIdentity: { symbolOrSeries: listing.key, currencyOrUnit: currency, interval: OPTIONS_EXPORT_INTERVAL },
      // Exports state each decimal's unit in its header and end every row with the spot and dates it is as of.
      columns: [
        { key: "side", header: "Side" },
        { key: "contract", header: "Contract" },
        { key: "expiration", header: "Expiry" },
        { key: "strike", header: "Strike" },
        { key: "last", header: "Last" },
        { key: "bid", header: "Bid" },
        { key: "ask", header: "Ask" },
        { key: "iv", header: "IV (annualized decimal)" },
        { key: "ivSource", header: "IV source" },
        { key: "delta", header: "Delta (decimal)" },
        { key: "volume", header: "Vol" },
        { key: "openInterest", header: "OI" },
        { key: "spot", header: "Spot" },
        { key: "spotBasis", header: "Spot basis" },
        { key: "spotAsOf", header: "Spot as of" },
        { key: "openInterestAsOf", header: "OI as of" },
        // A venue's marks and its coin prices (Deribit's BTC and ETH options).
        ...(marked ? [
          { key: "mark", header: "Mark (USD)" }, { key: "gamma", header: "Gamma (per 1.00)" },
          { key: "vega", header: "Vega (USD per vol point)" }, { key: "theta", header: "Theta (USD per day)" },
          { key: "forward", header: "Forward" }, { key: "expiresAt", header: "Settles" },
        ] : []),
        ...(coin ? [
          { key: "coinBid", header: `Bid (${coin})` }, { key: "coinAsk", header: `Ask (${coin})` },
          { key: "coinMark", header: `Mark (${coin})` }, { key: "coinLast", header: `Last (${coin})` },
        ] : []),
      ],
      // A coin's options are quoted in the coin: its bid, ask and mark, then the mark in dollars and the venue's greeks.
      textColumns: coin ? [
        { key: "side", header: "Side" },
        { key: "contract", header: "Contract", shrink: false },
        { key: "strike", header: "Strike", align: "right" },
        { key: "coinBid", header: `Bid ${coin}`, align: "right", format: formatCoinPremiumCell },
        { key: "coinAsk", header: `Ask ${coin}`, align: "right", format: formatCoinPremiumCell },
        { key: "coinMark", header: `Mark ${coin}`, align: "right", format: formatCoinPremiumCell },
        { key: "mark", header: "Mark $", align: "right", format: formatOptionDollarCell },
        { key: "iv", header: "IV", align: "right", format: (value, row) => formatOptionIvCell(value, row) },
        { key: "delta", header: "Delta", align: "right", format: formatOptionDeltaCell },
        { key: "gamma", header: "Gamma", align: "right", format: formatOptionGammaCell, optional: true, dropPriority: 3 },
        { key: "vega", header: "Vega $", align: "right", format: formatOptionDollarCell, optional: true, dropPriority: 2 },
        { key: "theta", header: "Theta $", align: "right", format: formatOptionDollarCell, optional: true, dropPriority: 2 },
        { key: "volume", header: "Vol", align: "right", format: formatCountCell, optional: true, dropPriority: 1 },
        { key: "openInterest", header: "OI", align: "right", format: formatCountCell, optional: true, dropPriority: 1 },
      ] : [
        { key: "side", header: "Side" },
        { key: "contract", header: "Contract", shrink: false },
        // The contract symbol already carries the date, so this goes first when the table is narrow.
        { key: "expiration", header: "Expiry", optional: true, dropPriority: 2 },
        { key: "strike", header: "Strike", align: "right" },
        { key: "last", header: "Last", align: "right" },
        { key: "bid", header: "Bid", align: "right", format: (_value, row) => formatOptionQuoteCell(row, "bid") },
        { key: "ask", header: "Ask", align: "right", format: (_value, row) => formatOptionQuoteCell(row, "ask") },
        { key: "iv", header: "IV", align: "right", format: (value, row) => formatOptionIvCell(value, row) },
        { key: "delta", header: "Delta", align: "right", format: formatOptionDeltaCell },
        { key: "volume", header: "Vol", align: "right", format: formatCountCell, optional: true, dropPriority: 1 },
        { key: "openInterest", header: "OI", align: "right", format: formatCountCell, optional: true, dropPriority: 1 },
      ],
    });
  });
}

/** What an options chain export's `interval` says: one quote snapshot, not bars. */
const OPTIONS_EXPORT_INTERVAL = "snapshot";

/** `fx --date`: a past day as YYYY-MM-DD; today's close is not in yet, so it is refused, as is a day ahead. */
function readFxDate(value: string, ctx: Parameters<CliCommandDef["execute"]>[1]): string {
  let date: string;
  try {
    date = isoDateOption(value, "date");
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : String(error));
  }
  if (!date) return ctx.fail("--date takes a day, such as --date 2026-09-02.");
  const today = isoDateToday();
  if (date >= today) {
    return ctx.fail(`${date} has no daily close yet: --date takes a day before today (${today}).`, "Without --date, fx gives the latest rate.");
  }
  return date;
}

/**
 * `fx <pair> --date <day>`: the rate at that day's daily FX closes, read as
 * a position's purchase-date cost reads them (`fxCloseOnDate`): each
 * currency's USD pair at its close of the day, or of the last trading day
 * before it, which the answer then says, crossed through USD as the latest
 * rate is.
 */
async function runFxOnDate(
  parsed: Exclude<ReturnType<typeof parseFxArgs>, { error: string }>,
  date: string,
  args: readonly string[],
  market: MarketContext,
  ctx: Parameters<CliCommandDef["execute"]>[1],
) {
  const { request, amount, toUsdByDefault } = parsed;
  const { currency, baseCurrency } = request;
  const pair = `${currency}/${baseCurrency}`;
  const history = market.fxHistory ?? apiClient;
  const codes = [...new Set([currency, baseCurrency].filter((code) => code !== "USD"))];
  const legs = new Map<string, FxCloseReading>([["USD", { rate: 1, date }]]);
  if (currency !== baseCurrency) {
    for (const code of codes) {
      const leg = dailyFxLeg(code);
      if (!leg) return ctx.fail(`${code} has no daily FX closes to read a rate for ${date} from.`);
      let reading: FxCloseReading | null;
      try {
        reading = await fxCloseOnDate(leg, date, history);
      } catch (error) {
        return ctx.fail(`The daily ${code} FX closes could not be read.`, error instanceof Error ? error.message : String(error));
      }
      if (!reading) {
        return ctx.fail(`No ${leg.invert ? `USD/${code}` : `${code}/USD`} daily close in the week up to ${date}.`,
          "Without --date, fx gives the latest rate.");
      }
      legs.set(code, reading);
    }
  }
  const from = legs.get(currency), into = legs.get(baseCurrency);
  const rate = currency === baseCurrency ? 1 : crossRate(from?.rate, into?.rate);
  // A cross is as old as its older close; a weekend or holiday reads the trading day before it.
  const closeDate = [...legs.values()].map((leg) => leg.date).sort()[0]!;
  const converted = amount == null ? null : amount * rate;
  const row = {
    currency, baseCurrency, rate, asOf: closeDate, stale: false, pair, inverse: 1 / rate, date,
    ...(amount == null ? {} : { amount, converted }),
  };
  const warnings = [
    ...request.readAs ?? [],
    ...closeDate < date ? [`No daily close on ${date}, a weekend or market holiday: this is the close of ${closeDate}, the trading day before it.`] : [],
    ...toUsdByDefault && amount != null
      ? [`No target currency given, so ${currency} is converted to USD; for another, write fx ${args[0]!.trim()} ${currency}/<to> --date ${date}.`]
      : [],
  ];
  ctx.printResult({
    data: [row],
    // A past close is what was asked for, never stale.
    freshness: rowsFreshness([], { status: "not-a-feed", basis: "daily FX close", asOf: closeDate }),
    warnings: warnings.length > 0 ? warnings : undefined,
  }, {
    text: () => amount == null ? describeFxRate(request, rate) : `${describeFxConversion(request, amount, rate)}\n${describeFxRate(request, rate)}`,
    exportIdentity: { symbolOrSeries: pair, currencyOrUnit: `${baseCurrency} per ${currency}`, interval: "1day" },
    columns: [
      { key: "currency", header: "Currency" },
      { key: "baseCurrency", header: "Base" },
      { key: "rate", header: "Rate", align: "right" },
      { key: "date", header: "Date" },
      { key: "asOf", header: "Close" },
      { key: "stale", header: "Stale" },
      { key: "pair", header: "Pair" },
      { key: "inverse", header: "Inverse", align: "right" },
      ...(amount == null ? [] : [
        { key: "amount", header: "Amount", align: "right" as const },
        { key: "converted", header: "Converted", align: "right" as const },
      ]),
    ],
  });
}

async function runFx(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const dateOption = takeOption(args, "--date");
  const forwardOption = takeOption(args, "--forward");
  if (args.length === 0) ctx.fail(`Usage: gloom ${FX_USAGE}`);
  // A forward is implied from today's spot and the latest short rates, which are all Gloom Cloud serves.
  if (dateOption != null && forwardOption != null) {
    ctx.fail(
      "fx --forward does not take --date: the forward is implied from today's spot and the latest short rates, and past short rates are not served.",
      `For that day's close: gloom fx ${args.join(" ")} --date ${dateOption}. For today's forward, drop --date.`,
    );
  }
  const date = dateOption == null ? null : readFxDate(dateOption, ctx);
  const tenor = forwardOption == null ? null : parseForwardTenor(forwardOption);
  if (tenor && "error" in tenor) ctx.fail(tenor.error, `Usage: gloom ${FX_FORWARD_USAGE}`);
  await withMarketData(ctx, async (market) => {
    const parsed = parseFxArgs(args, market.config.baseCurrency);
    if ("error" in parsed) return ctx.fail(parsed.error, `Usage: gloom ${forwardOption == null ? FX_USAGE : FX_FORWARD_USAGE}`);
    if (date) return runFxOnDate(parsed, date, args, market, ctx);
    const { request, amount, toUsdByDefault } = parsed;
    const { currency, baseCurrency } = request;
    const pair = `${currency}/${baseCurrency}`;
    if (tenor) {
      if (amount != null) ctx.fail("--forward prices a pair, not an amount.", `Usage: gloom ${FX_FORWARD_USAGE}`);
      if (currency === baseCurrency) ctx.fail(`${pair} has no forward: both sides are ${currency}.`, `Usage: gloom ${FX_FORWARD_USAGE}`);
    }
    // The short rates are read alongside spot. A failed read is held as a value, not left to reject
    // unobserved while spot loads, and is raised where the forward needs the rates.
    const shortRates = tenor && !("error" in tenor) ? apiClient.getCloudShortRates().then(
      (payload) => ({ payload }),
      (error: unknown) => ({ error: unavailableOnServer(error, "Forwards are not available from Gloom Cloud yet: it serves no short rates.") }),
    ) : null;
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
    const converted = amount == null ? null : amount * rate;
    const row = { currency, baseCurrency, rate, asOf, stale, pair, inverse: 1 / rate, ...(amount == null ? {} : { amount, converted }) };
    // The closing line dates the rate, and says when it is stale, as `fn FXC` does.
    const loaded = new Map(codes.flatMap((code, index) => {
      const leg = legs[index];
      return leg ? [[code, {
        rate: leg.value,
        timing: {
          asOf: leg.asOf, staleAt: leg.staleAt, error: leg.refreshError, delayMinutes: leg.delayMinutes,
          intradayBar: leg.intradayBar, staleReason: leg.staleReason,
        },
      }] as const] : [];
    }));
    const freshness = fxPairFreshness(loaded);
    // A rate that is its pair's bar says which bar, and a stale one why it stands.
    const timings = new Map([...loaded].map(([code, leg]) => [code, leg.timing]));
    // --refresh read every leg again: one that is still stale says the data service has no newer rate.
    const rateNotes = [...fxRateNotes(timings), ...ctx.cliOptions.refresh ? refreshedFxRateNotes(timings) : []];
    if (tenor && shortRates && !("error" in tenor)) {
      const read = await shortRates;
      if ("error" in read) throw read.error;
      const { rates } = read.payload;
      // BASE/QUOTE: the forward needs the rate of each; a missing one is named, never filled in.
      const base = shortRateFor(currency, rates);
      const quote = shortRateFor(baseCurrency, rates);
      const missing = [base, quote].flatMap((lookup) => "error" in lookup ? [lookup.error] : []);
      if ("error" in base || "error" in quote) {
        return ctx.fail(`No ${tenor.label} forward for ${pair}. ${missing.join(" ")}`, "The forward is implied from both currencies' short rates by covered interest parity.");
      }
      const implied = impliedForward(rate, tenor.days, base.rate, quote.rate);
      const forwardDate = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + tenor.days * 86_400_000).toISOString().slice(0, 10);
      const rateFields = (short: typeof base.rate) => ({
        currency: short.currency, name: short.name, tenor: short.tenor, value: short.value, asOf: short.asOf,
        dayCountBasis: short.dayCountBasis, publisher: short.publisher, sourceUrl: short.sourceUrl, stale: short.stale,
      });
      const staleRates = [base.rate, quote.rate].filter((short) => short.stale)
        .map((short) => `${short.name} (${short.currency}) is the last copy read, dated ${short.asOf ?? "undated"}; its source could not be read since.`);
      const forwardRow = {
        pair, tenor: tenor.label, days: tenor.days, forwardDate, spot: rate, spotAsOf: asOf, forward: implied.forward,
        points: implied.points, pointSize: implied.pointSize, premiumPercent: implied.premiumPercent, annualizedPercent: implied.annualizedPercent,
        baseRate: rateFields(base.rate), quoteRate: rateFields(quote.rate), method: "covered interest parity", label: IMPLIED_FORWARD_LABEL,
      };
      const growth = (short: typeof base.rate) => `(1 + ${formatRatePercent(short.value)} × ${tenor.days}/${short.dayCountBasis})`;
      // A currency typed as its name (yen) says which code it was read as, as the spot answer does.
      const forwardWarnings = [...request.readAs ?? [], ...rateNotes, ...staleRates];
      return ctx.printResult({ data: [forwardRow], freshness, ...(forwardWarnings.length > 0 ? { warnings: forwardWarnings } : {}) }, {
        text: () => [
          `${pair} ${tenor.label} forward ${formatFxRate(implied.forward)}, ${IMPLIED_FORWARD_LABEL}`,
          `Spot ${formatFxRate(rate)} · forward points ${formatForwardPoints(implied.points)} (pips of ${implied.pointSize}) · ${implied.premiumPercent >= 0 ? "premium" : "discount"} ${formatSignedPercent(implied.premiumPercent)} over ${tenor.days} days to ${forwardDate}, ${formatSignedPercent(implied.annualizedPercent, 2)} a year (×360/${tenor.days})`,
          `${currency} rate: ${describeShortRate(base.rate)}`,
          `${baseCurrency} rate: ${describeShortRate(quote.rate)}`,
          `Covered interest parity: ${formatFxRate(rate)} × ${growth(quote.rate)} / ${growth(base.rate)}; each rate earns simple interest over the ${tenor.days} days, standing in for a ${tenor.label} term rate.`,
        ].join("\n"),
        exportIdentity: { symbolOrSeries: pair, currencyOrUnit: `${baseCurrency} per ${currency}`, interval: `forward ${tenor.label}` },
        columns: [
          { key: "pair", header: "Pair" },
          { key: "tenor", header: "Tenor" },
          { key: "days", header: "Days", align: "right" },
          { key: "forwardDate", header: "Forward date" },
          { key: "spot", header: "Spot", align: "right" },
          { key: "forward", header: "Forward", align: "right" },
          { key: "points", header: "Points", align: "right" },
          { key: "premiumPercent", header: "Premium %", align: "right" },
          { key: "annualizedPercent", header: "Annualized %", align: "right" },
        ],
      });
    }
    // An amount with one currency names no target; the answer says it went to USD.
    const warnings = [
      // A currency typed as its name (yen) says which code it was read as.
      ...request.readAs ?? [],
      ...toUsdByDefault && amount != null
        ? [`No target currency given, so ${currency} is converted to USD; for another, write fx ${args[0]!.trim()} ${currency}/<to>.`]
        : [],
      ...rateNotes,
    ];
    // The peso's dollar rate is the official one; the market rates Buenos Aires prices imply follow it, each with its inputs.
    const peso = isPesoDollarPair(currency, baseCurrency)
      ? await loadPesoDollarRates((targets) => market.dataProvider.getQuotesBatch(targets, { forceRefresh: ctx.cliOptions.refresh }))
      : null;
    if (peso && peso.missing.length > 0) warnings.push(`No price for ${peso.missing.join(", ")}, so the rates from ${peso.missing.length === 1 ? "it are" : "them are"} left out.`);
    const rateText = peso ? `${describeFxRate(request, rate)}  ·  ${peso.spotKind} rate` : describeFxRate(request, rate);
    ctx.printResult({ data: [peso ? { ...row, ...pesoDollarRatesJson(peso) } : row], freshness, warnings: warnings.length > 0 ? warnings : undefined }, {
      // The conversion, then the rate it used; the source line under it dates that rate.
      text: () => [
        ...amount == null ? [] : [describeFxConversion(request, amount, rate)],
        rateText,
        ...peso ? pesoDollarRateLines(peso) : [],
      ].join("\n"),
      // The rate is the base currency's price of one unit of the other, at the latest quote of each leg: USD per ZAR.
      exportIdentity: { symbolOrSeries: pair, currencyOrUnit: `${baseCurrency} per ${currency}`, interval: "spot" },
      columns: [
        { key: "currency", header: "Currency" },
        { key: "baseCurrency", header: "Base" },
        { key: "rate", header: "Rate", align: "right" },
        { key: "asOf", header: "As Of" },
        { key: "stale", header: "Stale" },
        { key: "pair", header: "Pair" },
        { key: "inverse", header: "Inverse", align: "right" },
        ...(amount == null ? [] : [
          { key: "amount", header: "Amount", align: "right" as const },
          { key: "converted", header: "Converted", align: "right" as const },
        ]),
      ],
    });
  });
}

async function runEarnings(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const entries = normalizeSymbols(args);
  if (entries.length === 0) ctx.fail("Usage: gloom earnings <symbol...>");
  await withCliServices(ctx, async (services) => {
    const symbols = await readSymbols(entries, services.dataProvider);
    const listings = await Promise.all(symbols.map((symbol) => requireCliListing(
      symbol, exchangeOption, services, ctx, { ownExchangeWins: symbols.length > 1 },
    )));
    const keys = listings.map((listing) => listing.key);
    // Each bare symbol's venues cost a search, so a long list (a portfolio check, not a lookup) names none.
    const venues = new Map(listings.length > MAX_CHOICE_LOOKUPS ? []
      : listings.map((listing) => [listing, loadBareVenues(listing, services)] as const));
    let calendar: EarningsEvent[];
    try {
      calendar = await loadForListing(
        listings, services, ctx,
        () => services.dataProvider.getEarningsCalendar(keys),
        (found) => found.length === 0,
      );
    } catch (error) {
      const failure = earningsCalendarFailure(error, keys);
      if (failure) ctx.fail(failure);
      throw error;
    }
    // Each date is resolved as events, EE, ERN and OSA resolve it: one that has come is read against the
    // company's quarters on record, for its actual and the next report on record (shared/earnings-calendar).
    const today = newYorkDay();
    const resolved = await resolveListingEvents(services.dataProvider, listings.map((listing) => ({
      key: listing.key, symbol: listing.request.symbol, exchange: listing.request.exchange,
    })), calendar, today);
    const events: ResolvedEarningsEvent[] = calendar
      .map((event) => resolved.get(event.symbol.toUpperCase()) ?? { ...event, dateStatus: calendarStatus(event, today) })
      .sort((left, right) => left.earningsDate.getTime() - right.earningsDate.getTime());
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
    // A listing at home the calendar has no date for is named as well: a list never drops a symbol unsaid.
    const undated = undatedListingsNote(listings.filter((listing) => !isListingAbroad(listing) && !eventOf(listing)));
    const noCalendar = [...abroadNotes, ...undated ? [undated] : []].join("\n");
    // Text prints the listings without a calendar under the table; other formats carry them as warnings.
    const warnings = [
      ...listings.flatMap(listingReadNotes),
      ...choiceNotes.filter((note): note is string => !!note),
      ...ctx.cliOptions.format === "text" ? [] : [...abroadNotes, ...undated ? [undated] : []],
    ];
    ctx.printResult({
      data: events,
      // Dated by when it was read: a row's date is when the report is, not how old the calendar is.
      freshness: rowsFreshness([], { status: "not-a-feed", basis: "calendar", oldest: null }),
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
      usage: ["quote <symbol...>", "quote --file <path>"],
      options: [EXCHANGE_OPTION, LIST_FILE_OPTION],
      sections: [QUOTE_CSV_SECTION],
      examples: ["quote AAPL MSFT NVDA", "quote SAN:EPA BHP:ASX", "quote BTC-USD EURUSD=X", "quote binance:BZUSDT", "quote AAPL --json", "quote --file holdings.csv",
        "quote --file holdings.csv --csv > quotes.csv"],
    },
    execute: (args, ctx) => runQuote(args, ctx, "quote"),
  },
  {
    name: "compare",
    description: "Compare quotes for several symbols side by side",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["compare <symbol...>", "compare --file <path>"],
      options: [EXCHANGE_OPTION, LIST_FILE_OPTION],
      sections: [QUOTE_CSV_SECTION],
      examples: ["compare KO PEP", "compare SAN:EPA SAN:NYSE", "compare SPY QQQ IWM --csv", "compare - < peers.txt"],
    },
    execute: (args, ctx) => runQuote(args, ctx, "compare"),
  },
  {
    name: "history",
    description: "Fetch open, high, low, close, and volume over a range",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: [HISTORY_USAGE, "history --file <path> [--range <range> | --from <year|date> [--to <year|date>]]"],
      options: [
        { flags: "--range <range>", description: `${HISTORY_RANGES.join(", ")} (default 1Y); ${HISTORY_YTD_RANGE}; ${HISTORY_ALL_RANGE}` },
        { flags: "--from <year|date>, --start <year|date>", description: `${PRICE_WINDOW_FROM_HELP}. Up to five years come in daily bars, up to twenty weekly, longer monthly` },
        { flags: "--to <year|date>, --end <year|date>", description: PRICE_WINDOW_TO_HELP },
        { flags: "--file <path>", description: "Read the symbols from a text or CSV file, one per line (- reads standard input), and write every symbol's bars in one table" },
        { flags: "--wide", description: "One row per date and one close column per symbol, its unit in the header, in place of one long table" },
        EXCHANGE_OPTION,
      ],
      sections: [{
        title: "Bars",
        lines: [
          `Each range comes in one bar size: ${historyIntervalsByRange()}. The line under the heading, and the --json metadata, give the currency, the bar size actually served, the first and last bar and the bar count. A warning says when the bars are coarser, or start later, than the range asked for, and for a coin, which trades every day, names each day it has no bar for.`,
          "A bar whose prices contradict each other (high below the open or close, or low above them) is left blank and flagged, such as high<open, with the count in a warning. A low under half the open and close, or a high over twice them, is left blank alone and flagged low<close/2 or high>2*open. --json rows carry currency, unit, interval and flag.",
          "A break in the series flags the bar after it, which keeps its prices: gap after more than three months with no bar (weeks for weekly, daily and intraday bars), jump when the close is over 100 times the one before or under a hundredth of it. A warning names each break, and the heading says the date the series runs unbroken from.",
          "The heading's last line is the max drawdown of the bars shown: the largest fall from a close to a later close, with the peak and the trough, their dates, and the date a close got back to the peak, if one did (maxDrawdown in --json).",
        ],
      }, {
        title: "CSV",
        lines: [
          "Every --csv has one header, whatever the symbol, range or market state: Date, Open, High, Low, Close, Volume, Flag, Partial, Filled, Unsettled, Volume unit, Volume note, Venue volume, Volume venue, Volume basis, status, then symbol_or_series, currency_or_unit, interval, source and as_of. Prices are plain numbers in the unit currency_or_unit names: the currency, a pair's quote currency per base (JPY per USD for USDJPY=X) or index points. Partial, Filled and Unsettled are true or false, and status says why a row has no prices.",
          "A continuous future whose bars name their contracts (NG=F) adds Contract, Roll and Thin before status: the contract per bar, and true or false for the bar it rolled at and a bar that traded far below those around it.",
        ],
      }, {
        title: "Several symbols",
        lines: [
          `history AAPL MSFT 000660.KS, or --file with one symbol a line (- reads standard input), writes every symbol's bars in one long table, ${HISTORY_LIST_CONCURRENCY} symbols loading at once. Each row names its symbol, its unit and the as-of of that symbol's bars in symbol_or_series, currency_or_unit and as_of.`,
          "A symbol with no history is one row with its reason in status, and a warning names it; the command fails only when no symbol has any. --tail 5 keeps each symbol's newest five bars.",
          "--wide sets the symbols side by side instead: one row per date, one close column per symbol headed with its unit (USDJPY=X close (JPY per USD)), a blank where a symbol has no bar that day. history USDJPY=X USDCHF=X EURCHF=X --csv --wide is a spreadsheet of the three closes; --tail 5 keeps the newest five dates.",
        ],
      }, {
        title: "Long history",
        lines: [
          "ZAR has daily FRED data from 1980: gloom fred DEXSFUS --start 1980 --sort asc --csv",
          "NGN, SAR and ILS have no FRED series. Their daily bars cover the last five years (gloom fn G USDNGN=X --range-preset 5Y --chart-resolution 1d --csv); before that there are monthly bars only (gloom history USDNGN=X --range ALL).",
        ],
      }],
      examples: [
        "history AAPL", "history BHP:ASX --range 5Y", "history JPM --from 2007 --to 2009", "history ZAR=X --range ALL", "history ZAR=X --tail 5",
        "history AAPL --range 5Y --csv > aapl.csv", "history AAPL MSFT 000660.KS --range 1M --csv",
        "history --file holdings.txt --start 2024-01-01 --end 2024-12-31 --csv > bars.csv",
      ],
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
          flags: `--expiration <${OPTION_EXPIRATION_PLACEHOLDER}>, --expiry <${OPTION_EXPIRATION_PLACEHOLDER}>`,
          description: "Expiration as a date (2028-01-21) or Unix seconds; defaults to the nearest one, and lists the others. With --leaps: rank that expiry alone",
        },
        EXCHANGE_OPTION,
        { flags: "--leaps", description: "Rank long-dated contracts across the symbols given, as a stock replacement; more than a year out unless a window says otherwise" },
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
          flags: "--min-days <days>",
          description: `With --leaps: fewest calendar days to expiry (default ${DEFAULT_LEAPS_CRITERIA.minDays}); 180 reaches six months out`,
        },
        { flags: "--max-days <days>", description: "With --leaps: most calendar days to expiry; --min-days 365 --max-days 730 is 12 to 24 months" },
        { flags: "--expiry-from <date>", description: `With --leaps: first expiry date kept, as ${DATE_OPTION_EXAMPLES}; replaces the one-year floor` },
        { flags: "--expiry-to <date>", description: "With --leaps: last expiry date kept" },
        {
          flags: "--columns <list>",
          description: `With --leaps: add figures, comma-separated: ${LEAPS_EXTRA_COLUMNS.join(", ")}`,
        },
        {
          flags: "--sort <order>",
          description: "With --leaps: carry (extrinsic per year, lowest first; the default), spread, oi, delta, expiry or symbol",
        },
      ],
      sections: [{
        title: "LEAPS",
        lines: [
          "--leaps reads each symbol's expiries in the window and keeps the liquid contracts in the delta band, ranked by extrinsic per year: time value (midpoint less intrinsic) as a percent of spot, per year to expiry.",
          "--min-days, --max-days, --expiry-from and --expiry-to set the window together; without a lower bound it starts a year out. Each symbol reads at most 8 expiries, the ones nearest the window's start, and a warning names any it left.",
          "--columns adds iv (the contract's implied vol), ivr (the underlying's IV rank), cost (midpoint x 100 per contract), breakeven (at the midpoint, and its distance from spot), next-earnings, ex-dividend and carry-net "
            + `(extrinsic per year net of the ${Number((OPTION_MODEL_RATE * 100).toFixed(2))}% rate on the strike and the dividend yield). A figure a symbol lacks is blank, with a warning.`,
          "A symbol without LEAPS, a quote or a chain is named in a warning and the others still rank. docs/research-data.md defines each figure.",
        ],
      }],
      examples: [
        "options AAPL",
        "options AAPL --expiration 2028-01-21",
        "options AAPL:NASDAQ --json",
        "options AAPL MSFT NVDA GOOGL AMZN META --leaps",
        "options SPY QQQ --leaps --side puts --delta 0.20-0.40 --csv",
        "options MSFT --leaps --min-days 365 --max-days 730",
        "options AAPL MSFT NVDA --leaps --min-days 180 --columns iv,ivr,cost,breakeven,carry-net",
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
      if (!query) ctx.fail("Usage: gloom provider-search <query>");
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
    unknownOptionHint: financialsOptionHint,
    execute: (args, ctx) => runFinancials(args, ctx, "statements"),
  },
  {
    name: "fundamentals",
    description: "Fetch fundamentals and the company profile",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["fundamentals <symbol>"],
      options: [EXCHANGE_OPTION, TABLE_SECTION_OPTION, ...TAX_RATE_HELP_OPTIONS],
      examples: ["fundamentals NVDA", "fundamentals ASML:AMS", "fundamentals NVDA --csv --section fundamentals", "fundamentals MUB --tax-rate 40.8",
        "fundamentals CMF --tax-rate 40.8 --state-rate 13.3 --state CA"],
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
          "A US listing lists every 13F filer, as fn 13F does: the largest 25, or as many as --limit asks up to 200; --tail counts back from the end of those, not from the smallest filer. A listing abroad has only the source's largest few.",
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
        lines: ["For each fund's reported position and its change over the quarter, run gloom fn 13F <symbol>."],
      }],
      examples: ["13f AAPL", "13f BP:NYSE"],
    },
    execute: (args, ctx) => runHolders(args, ctx, "13f", new Set(["institution", "fund"])),
  },
  {
    name: "filings",
    description: "Fetch recent SEC filings; a listing abroad gets its exchange's announcements page, and ASX's list",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["filings <symbol> [--count <n>] [--form <form>]"],
      options: [
        { flags: "--count <n>", description: "Number of filings (default 15)" },
        { flags: "--form <form>", description: "Only this form and its amendments, such as 10-K or 13D" },
        EXCHANGE_OPTION,
      ],
      examples: ["filings AAPL", "filings BHP:ASX", "filings NST.AX", "filings AAPL --count 40 --json", "filings CAR --form 13G"],
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
          "A shell drops the quotes around one word, so news \"gold\" is the ticker GOLD. Keep them to search the text: news '\"gold\"'. When a word you type is also the name of the company it found, and the stories that mention it are mostly about something else, the listing says so under its stories with that command.",
        ],
      }],
      examples: ["news", "news TSLA", "news SAN:EPA", "news TTF", "news \"european gas\"", "news '\"gold\"'", "news --feed top --limit 10"],
    },
    execute: runNews,
  },
  {
    name: "fx",
    description: "Convert a currency into your base currency, quote a pair such as USD/NGN, or convert an amount such as fx 1234.5 EUR/USD",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["fx <currency>", "fx <base>/<quote>", "fx <amount> <from>/<to>", "fx <amount> <from> <to>", "fx <pair> --date <day>", FX_FORWARD_USAGE],
      options: [
        { flags: "--date <day>", description: `The rate at that day's daily FX close, such as a transaction date (${DATE_OPTION_EXAMPLES}); a weekend or holiday reads the trading day before it` },
        { flags: "--forward <tenor>", description: "The forward implied by both currencies' short rates (covered interest parity), not a dealer quote: 30d, 2w, 3m, up to 1y; today's only, so not with --date" },
      ],
      sections: [{
        title: "Direction",
        lines: [
          "A bare code is one unit of it in your base currency. A pair reads as markets quote it: USD/NGN is how many NGN one USD buys. Two codes neither of which is USD, such as ZAR/NGN, cross through their USD rates.",
          "A currency's name stands for its code: fx yen is JPY, fx rand ZAR, fx Swiss franc CHF, and the answer says which it read. A name several currencies share (peso, dollar, franc, krona, rupee) lists them: write one as its code.",
          "The answer states both directions: 1 NGN = 0.000752791 USD  (USD/NGN 1328.39). --json, --csv and --ndjson carry rate (base currency per currency), pair, inverse, asOf and stale.",
        ],
      }, {
        title: "Amounts",
        lines: [
          "An amount in front converts it from the first currency to the second: fx 1234.5 EUR/USD, or fx 1234,5 EUR USD. It takes either decimal mark (1.234,5 and 1,234.5 are 1234.5) and reads as an amount of the first currency: 1.234 EUR is thousands, a third decimal being below a cent, while in a currency with three decimals (KWD) fx asks which. A comma before exactly three digits (fx 1,234 EUR) could be either, so fx asks which: type 1234 or 1.2340. An amount and one currency converts to USD. The answer gives the converted amount, then the rate it used, dated by the source line; --json adds amount and converted.",
        ],
      }, {
        title: "A past day",
        lines: [
          "--date gives the rate at that day's daily FX close instead of the latest: fx USD/CAD --date 2026-09-02, or with an amount, fx 1250 USD/CAD --date 2026-09-02. Each currency's USD pair is read at its close of that day and crossed through USD, as the latest rate is. A weekend or market holiday has no close: the answer then gives the trading day before it and says so. The source line dates the close; --json adds date (the day asked for) and asOf (the close used).",
        ],
      }, {
        title: "Forwards",
        lines: [
          "--forward <tenor> gives the forward implied by covered interest parity: spot × (1 + quote rate × days/basis) / (1 + base rate × days/basis), with the forward points (pips of 0.0001, 0.01 against JPY) and the premium over spot for the period and a year. It is implied by rates, not a dealer quote.",
          "The rates are SOFR (USD), €STR (EUR), SONIA (GBP) and TIIE 28d (MXN), each with its day and publisher. A pair whose rate is missing says which one. Tenors count calendar days from today: 30d, 2w, 3m, 1y. The forward is today's: it does not take --date, as only the latest short rates are served.",
        ],
      }],
      examples: ["fx EUR", "fx NGN", "fx yen", "fx USD/NGN", "fx ZAR/NGN", "fx 1234.5 EUR/USD", "fx 1234,5 EUR USD", "fx USD/CAD --date 2026-09-02", "fx JPY --json", "fx USD/MXN --forward 30d", "fx EUR/USD --forward 3m"],
    },
    execute: runFx,
  },
];
