import { logFailure } from "../../utils/log-failure";
import type { CliCommandDef } from "../../types/plugin";
import { TIME_RANGES, type TimeRange } from "../../time-series/range";
import { yearToDateStartIndex } from "../../market-data/market/year-to-date";
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
import { currencyPriceMinDigits, formatMarketPrice, formatMarketPriceWithCurrency, quoteFormatOptions, resolveAssetDisplayKind, withCurrencyMinorDigits } from "../../market-data/market/format";
import { INDEX_POINTS_EXPORT_UNIT, isIndexLevel, reportedQuoteVolume } from "../../market-data/market/index-level";
import { changeBasisJson, changeBasisLabel, changeBasisNote, quoteChangeBasis, quotePreviousCloseDate } from "../../market-data/market/change-basis";
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
import { formatCompact, formatCurrency, formatDistributionAmount, formatNumber, formatPercent, formatPercentRaw } from "../../utils/format";
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
import { cliStyles, colorBySign, renderSection, renderStats } from "../../utils/cli-output";
import { statementHistoryNotes } from "../../utils/financial-statements";
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
import {
  cliFuturesContract, futuresContractMetrics, exportedDividendFundamentals, fundamentalsReportTables, loadDividendDistributions, loadReportBondFacts,
  renderFundamentalsReport, writesCurrencyCodes,
} from "./ticker";
import { loadStatementFilings } from "../statement-filings";
import { loadBankFigures } from "../bank-section";
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import type { FuturesContractTermsPayload } from "../../api-client/futures-curve";
import { currencyCodeLabel } from "../../utils/currency-units";
import { futuresContractLines, futuresRollLines, futuresSettleText, isFuturesInstrument, minorUnitPricePer } from "../../market-data/futures-contract";
import {
  chainHasExpiry,
  formatExpiryList,
  loadOptionModelInputs,
  loadOptionsChainOpenInterest,
  formatOptionDeltaCell,
  formatOptionIvCell,
  formatOptionQuoteCell,
  OPTION_MODEL_RATE,
  OPTION_VOLATILITY_FIELDS,
  OPTIONS_USAGE,
  optionRows,
  optionsBasisFields,
  optionsBasisFootnote,
  parseOptionExpiration,
  valueChainAtModelSpot,
  type OptionsChainBasis,
} from "./options-chain";
import { missingExpiryMessage, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER } from "../../utils/option-expiry";
import { DATE_OPTION_EXAMPLES, isoDateOption, isoDateToday } from "../../utils/calendar-date";
import { apiClient } from "../../api-client";
import { dailyFxLeg, fxCloseOnDate, type FxCloseReading } from "../../market-data/fx-closes";
import { declaredDividends } from "../../utils/declared-dividends";
import {
  DEFAULT_LEAPS_CRITERIA, LEAPS_EXTRA_COLUMNS, LEAPS_USAGE, parseLeapsCriteria, runLeapsScreen, takeLeapsOptions,
} from "./options-leaps";
import type { CliResultColumn } from "../result";
import type { PriceHistoryResult } from "../../types/price-history";
import {
  exportRowsTable,
  reportFooterLines,
  selectReportTables,
  type CliReportTables,
} from "../report-tables";
import {
  closedPeriodBarDay,
  formingPeriodBar,
  historyBarStatusNote,
  historyCoverageWarning,
  historyFacts,
  historyFlagNote,
  historyGapNote,
  historyJumpNote,
  historyUnbrokenFrom,
  historyAllRangeYears,
  historyIntervalsByRange,
  historyMissingVolumeNote,
  historyNotes,
  historyReportsVolume,
  historyPriceDecimals,
  historyRows,
  historyUnit,
  historyVolume,
  historyVolumeText,
} from "../history-rows";
import { MISSING_VOLUME_TEXT } from "../../utils/price-history-integrity";
import { CRYPTO_BOARD_HINT, quoteNotes } from "./crypto-hints";
import { bareFuturesCode, futuresBoardContract } from "../../market-data/futures-board";
import { commodityNamedIn, commoditySearchName } from "../../market-data/commodity-names";
import { newsEmptyMessage } from "./news-hints";
import { commodityNewsRoute, commonWordCandidate, newsFallbackText, newsSearchHeading, newsSearchText, newsSearchTextProblem, noStoriesMessage, quotedSearchCommand, searchNewsStories, wordMeansMore } from "./news-search";
import { formatUtcTime } from "../../utils/utc-time";
import { DAY_SO_FAR_TEXT, withSessionBar } from "../../time-series/session-bar";
import { isFiniteNumber } from "../../utils/guards";
import { exportedFundamentals } from "../../utils/price-earnings";
import { fundamentalsFreshness, fxPairFreshness, quotesFreshness, rowsFreshness, valuationFreshness } from "../freshness";
import { atRegularSessionPrice } from "../../market-data/quotes/regular-session-valuation";
import { selectMarketCapitalization } from "../../utils/market-capitalization";
import {
  barHistoryFreshness,
  barResolutionFromDates,
  cloudNewsFreshness,
  cloudRealtimeAccess,
  REPORTED_DATA,
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
  EXCHANGE_OPTION,
  listingHeading,
  listingIdentity,
  listingTitle,
  listingVenues,
  listingChoiceNotes,
  listingReadNotes,
  loadBareVenues,
  loadForListing,
  loadListingQuote,
  listingFateLoader,
  movedSymbolLine,
  requireCliListing,
  type CliListing,
  type ListingIdentity,
} from "../listing-arg";
import { bareListingNote, listingFateNotes, noLongerTradingNote, tradingListing } from "../../tickers/listing-fate";
import { isYieldIndexSymbol } from "../index-roots";
import {
  analyzeTaxEquivalent, distributionBasis, loadTreasuryTenors, parseTaxRates, TAX_RATE_HELP_OPTIONS, taxEquivalentJson, type TaxRates,
} from "../../market-data/tax-equivalent";
import { CBOE_YIELD_INDEX_CLOSE } from "../../plugins/builtin/shared/treasury-cutoffs";
import { earningsCalendarFailure, earningsChoiceNote, earningsDateLabel, isListingAbroad, noListingCalendarNote } from "../earnings-calendar";
import { formatBasisPoints, toBasisPoints } from "../../utils/basis-points";
import { providerMissReason } from "../../sources/provider-errors";
import { isNotATickerMessage } from "../not-a-ticker";
import { primeBoardCoins } from "../board-coins";
import { suggestUsTicker, type ListingSuggestion } from "../listing-suggestion";
import { quotedPhrase, splitSymbolArgs, uniqueSecuritySymbols } from "../symbol-args";
import { isCompanyNameInput } from "../../tickers/company-name-listing";
import { readNameEntries, readPhraseArgument } from "../name-entries";
import { readSymbolList, SymbolListError } from "../symbol-list";
import { cliPerpetualContract, perpetualContractStats, type PerpetualContractPayload } from "../perpetual-contract";
import { knownGapMessage, subMinuteDataMessage } from "../known-gaps";
import { phraseSearchReport } from "./search";
import { secRegistrantMismatchMessage, SecRegistrantMismatchError, areDifferentCompanies } from "../../sources/sec-registrant";
import { isCryptoPairSymbol } from "../../utils/crypto-pair";
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
import { centralBankEventsMessage } from "../central-bank-events";
import { classSharesToday } from "../../plugins/builtin/holders/client";
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
 * The symbols of `--file <path>` or standard input (`-`), with any typed
 * beside them, read by the parser `watchlist add` uses, and its notes on what
 * it left out. Standard input is read only when asked for, so a script that
 * pipes in nothing never waits on it.
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
    if (list.symbols.length === 0) ctx.fail(`No symbols in ${file && file !== "-" ? file : "standard input"}.`, usage);
    return { symbols: uniqueEntries(list.symbols), notes: list.notes };
  } catch (error) {
    if (error instanceof SymbolListError) ctx.fail(error.message, usage);
    throw error;
  }
}

/** `--file` of quote and compare, as `watchlist add` takes it. */
const LIST_FILE_OPTION = {
  flags: "--file <path>",
  description: "Read the symbols from a CSV or text file, as watchlist add does (- reads standard input)",
};

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
  key: "changeBasis", header: "Chg Basis", shrink: false, optional: true, format: (value: unknown) => cliStyles.muted(String(value ?? "")),
};
const CHANGE_BASIS_EXPORT_COLUMNS = [
  { key: "changeBasis", header: "Chg Basis" },
  { key: "changeBasisNote", header: "Chg Basis Note" },
];

/** The table's columns: Chg Basis follows Chg%, and the note is a line under the table. */
function quoteTextColumns<Column extends { key: string }>(columns: Column[]): Array<Column | typeof CHANGE_BASIS_COLUMN> {
  const exported = new Set(CHANGE_BASIS_EXPORT_COLUMNS.map((column) => column.key));
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

/** The quote's currency code, US cents as US¢; an export keeps the code (USX). */
function currencyCell(value: unknown): string {
  return currencyCodeLabel(typeof value === "string" ? value : "");
}

function quoteColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "currency", header: "Cur", shrink: false, optional: true, dropPriority: 1, format: currencyCell },
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
    ...CHANGE_BASIS_EXPORT_COLUMNS,
  ];
}

function compareColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "previousClose", header: "Prev Close", align: "right" as const, format: yieldLevelCell },
    // A narrow terminal drops these before it cuts the names short.
    { key: "dayRange", header: "Day Range", align: "right" as const, optional: true, dropPriority: 1 },
    { key: "volume", header: "Volume", align: "right" as const, format: formatCountCell, optional: true, dropPriority: 2 },
    { key: "currency", header: "Cur", shrink: false, optional: true, dropPriority: 3, format: currencyCell },
    ...CHANGE_BASIS_EXPORT_COLUMNS,
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
  const entries = Object.entries(quote);
  const at = entries.findIndex(([key]) => key === "previousClose");
  entries.splice(at < 0 ? entries.length : at + 1, 0, ["previousCloseDate", previousCloseDate]);
  return Object.fromEntries(entries) as Quote & { previousCloseDate?: string | null };
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
    const indexPoints = isIndexLevel(quote?.instrumentType);
    // Pad to two decimals so a column lines up, but never past the currency's minor unit (JPY has none).
    // Points have no minor unit, so a yen-listed index still pads to two.
    const options = {
      ...quoteFormatOptions(quote),
      minimumFractionDigits: indexPoints ? 2 : currencyPriceMinDigits(quote?.currency),
      ...nearParCoin(quote) ? { fixedFractionDigits: STABLECOIN_PRICE_DIGITS } : {},
    };
    const price = (value: number | undefined) => (
      quote && value != null
        ? indexPoints ? formatMarketPrice(value, options) : formatMarketPriceWithCurrency(value, quote.currency, options)
        : ""
    );
    // A price in cents says what it is per, as the contract terms word it: 314.95¢/lb.
    const per = display?.price != null ? minorUnitPricePer(result.futuresContract, quote?.currency) : "";
    return {
      symbol: result.target.symbol,
      name: quote?.name || result.listing?.name || "",
      price: `${price(display?.price)}${per}`,
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
      session: quoteSessionStateLabel(quote, now) ?? "",
      sessionLabel: quoteSessionLabel(quote, now) ?? "",
      // The close the shown move is measured from: the one before the session Last is.
      previousClose: price(display?.change != null ? display.price - display.change : quote?.previousClose),
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
      detail: `declared ${currency ? formatDistributionAmount(event.amount, currency) : cleanDecimal(event.amount)}`
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

/**
 * The line `quote` prints beside a symbol that changed, as `history` and
 * `ticker` word it: a company that moved, with nothing new listed there,
 * names the quote of its new symbol ("HFC became DINO on 2022-03-15:
 * `gloomberb quote DINO`"); its old line's last price stays in the row.
 */
function quoteChangeLine(change: TickerChange | null | undefined, formerIssuer?: FormerIssuer | null): string | null {
  const moved = movedAwayChange(change);
  // One line per symbol: a company that left it, else the company that merged away from it (GOGL).
  return (moved ? movedSymbolLine(moved, `gloomberb quote ${moved.tradesAs}`) : tickerChangeLine(change)) ?? formerIssuer?.note ?? null;
}

async function runQuote(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], commandName: "quote" | "compare") {
  const args = [...rawArgs];
  const usage = `Usage: gloomberb ${commandName} <symbol...> [--file <path>]`;
  const exchange = takeOption(args, "--exchange") ?? "";
  // A list from a file or standard input (`-`), read as `watchlist add` reads one.
  const file = args.some((arg) => arg === "--file" || arg.startsWith("--file=")) ? takeOption(args, "--file") ?? "" : undefined;
  const listed = file != null || args.includes("-");
  const entries = normalizeSymbols(args);
  if (entries.length === 0 && !listed) ctx.fail(usage);
  // One quoted argument with spaces is a company's name, a pasted line of tickers, or a phrase to search for.
  const phrase = exchange || listed ? null : quotedPhrase(args);

  await withMarketData(ctx, async (market) => {
    const read = phrase ? await readPhraseArgument(phrase, market.dataProvider) : null;
    if (read?.kind === "phrase") return answerPhrase(read.phrase, market, ctx);
    // A list read from a file names what it left out: a stray separator, the cells beside a table's symbols.
    const list = listed && !read ? await readListedSymbols(args, file, market, ctx, usage) : null;
    const symbols = read?.kind === "name" ? [read.name]
      : read?.kind === "symbols" ? uniqueEntries(read.symbols)
      : list ? list.symbols
      : await readSymbols(entries, market.dataProvider);
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
    // The service's quote of the moment, not each form's local copy from whenever it was last asked for:
    // BRK.B saved on NYSE, BRK-B and BRK.B:NYSE print one quote (GLO-735). A local copy answers only offline.
    const results = await market.dataProvider.getQuotesBatch(targets, { forceRefresh: ctx.cliOptions.refresh, revalidate: true });
    const listingOf = (result: QuoteBatchResult, index: number) => listings[targets.indexOf(result.target)] ?? listings[index]!;
    const asked = results.map(listingOf);
    const request = { command: commandName, noun: "quote" };
    const answers = await Promise.all(results.map((result, index) => {
      const listing = asked[index]!;
      return answerQuote(result, listing, market, request, ctx.cliOptions.refresh, venues.get(listing) ?? null);
    }));
    const now = Date.now();
    const symbolChanges = await Promise.all(answers.map(async ({ result }, index) => {
      const listing = asked[index]!;
      // A bare symbol read on a listing abroad (SXR8 -> XETRA) is not the US symbol the changes are of.
      if (result.quote && bareListingNote(listing, result.quote)) return { change: null, formerIssuer: null };
      const payload = await changes.get(listing)?.settle() ?? null;
      const current = tradingListing(result.quote, now);
      return { change: describeTickerChange(listing.symbol, payload, current), formerIssuer: describeFormerIssuer(listing.symbol, payload, current) };
    }));
    const tickerChanges = symbolChanges.map(({ change }) => change);
    const formerIssuers = symbolChanges.map(({ formerIssuer }) => formerIssuer);
    const failed = answers[0]?.failure;
    if (listings.length === 1 && failed) {
      ctx.fail(failed.message, [quoteChangeLine(tickerChanges[0], formerIssuers[0]), failed.details].filter(Boolean).join("\n") || undefined);
    }
    // A futures quote adds its dated settlement and contract terms, as `ticker` prints them; `compare` stays a table.
    const contracts = await Promise.all(answers.map(({ result }) => commandName === "quote" && result.quote
      ? cliFuturesContract(result.quote.symbol || result.target.symbol, result.quote.instrumentType)
      : null));
    // A contract that is not its root's front (NGF27, NG2) prints the front's own price beside it, read in one batch.
    const fronts = await loadFuturesFrontQuotes(contracts, market.dataProvider);
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
      ...getQuoteSessionFields(result.quote),
      // What `change` is measured from, with the label and holiday note the table shows.
      changeBasis: changeBasisJson(quoteChangeBasis(result.quote, { terms: contracts[index] }), now),
      quote: withPreviousCloseDate(result.quote),
      ...contracts[index] ? { futuresContract: contracts[index] } : {},
      ...fronts[index] ? { futuresFront: fronts[index] } : {},
      ...perpetualContracts[index] ? { perpetualContract: perpetualContracts[index] } : {},
      ...usSuggestions[index] ? { usSuggestion: usSuggestions[index] } : {},
      error: failure?.oneLine ?? errorMessage(result.error),
      ...yieldIndexFields(result),
      ...tickerChanges[index] ? { tickerChange: tickerChanges[index] } : {},
      ...formerIssuers[index] ? { formerIssuer: formerIssuers[index] } : {},
    }));
    const notes = [
      ...list?.notes ?? [],
      // FB now lists another security; the company that was FB trades as META. A symbol a
      // company renamed into (META) is what was typed: its change is in the row, not here.
      // GOGL was Golden Ocean, which merged into CMB.Tech; a fund lists there now.
      ...tickerChanges.flatMap((change, index) => quoteChangeLine(change, formerIssuers[index]) ?? []),
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
    const basisNotes = changeBasisNotes(data, now);
    if (ctx.cliOptions.format !== "json") await primeBoardCoins(notes);
    // Only yield indices: their change is in bp, so the text header drops the percent sign (CSV keeps the percent it holds).
    const yieldsOnly = data.length > 0 && data.every((row) => isYieldIndexSymbol(row.target.symbol));
    ctx.printResult({
      data,
      warnings: notes.length > 0 ? notes : undefined,
      // A Cboe yield index stops at its 15:00 ET close, before the Treasury's curve is taken: the line says so, so its
      // close does not read as a contradiction of DGS10 or GC for the same day.
      freshness: quotesFreshness(data.map((row) => row.quote), yieldsOnly ? { schedule: `Cboe close ${CBOE_YIELD_INDEX_CLOSE}` } : undefined),
    }, {
      rows: quoteRows,
      // An index row's Cur is blank, its level having no currency; the export names what it is in instead.
      exportIdentity: (row) => ({
        symbolOrSeries: row.symbol,
        currencyOrUnit: row.currency || (row.yieldIndex ? "pct" : isIndexLevel(row.instrumentType) ? INDEX_POINTS_EXPORT_UNIT : null),
      }),
      details: quoteDetailsText,
      ...(basisNotes.length ? { footnote: basisNotes.join("\n") } : {}),
      columns,
      textColumns: quoteTextColumns(yieldsOnly
        ? columns.map((column) => column.key === "changePercent" ? { ...column, header: "Chg" } : column)
        : columns),
    });
    // The table names each symbol it found nothing for; with none found, the exit status says so too.
    if (data.every((row) => !row.quote)) process.exitCode = CLI_EXIT_CODES.error;
  });
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
    ctx.fail(said, [knownGapMessage(phrase), `Search for it: gloomberb search "${phrase}"`, `Functions and data: gloomberb catalog "${phrase}"`]
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
    const settle: [string, string] = ["Settle", futuresSettleText(terms, row.quote)];
    // The move Chg% gives, in the quote's money and with what it is measured from: "vs Fri settle".
    const session = getRegularSessionDisplay(row.quote);
    const change: Array<[string, string]> = session?.change != null && Number.isFinite(session.change)
      ? [["Change", quoteChangeText(row.quote, session, withCurrencyMinorDigits(quoteFormatOptions(row.quote, "FUTURE"), row.quote.currency), terms)]]
      : [];
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

/** A crypto pair that will not load points at the crypto board. Structured formats keep the error as thrown. */
function failHistory(error: unknown, symbol: string, ctx: Parameters<CliCommandDef["execute"]>[1]): never {
  if (ctx.cliOptions.format !== "text" || !isCryptoPairSymbol(symbol)) throw error;
  return ctx.fail(errorMessage(error) ?? `No history available for ${symbol}`, CRYPTO_BOARD_HINT);
}

const HISTORY_USAGE = "history <symbol> [--range <range>]";
const HISTORY_ALL_RANGE = `ALL gives the full history the source has, up to ${historyAllRangeYears()} years`;
const HISTORY_YTD_RANGE = "YTD starts at the prior year's last close, the one year-to-date returns are measured from";
/** Options people reach for to ask for dates, which history answers with a range. */
const DATE_WINDOW_OPTIONS = new Set(["--from", "--to", "--start", "--end", "--since", "--until", "--date", "--start-date", "--end-date"]);
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
  return `financials lists fiscal years. For quarters: gloomberb fn GF ${symbol} --period quarterly --periods 40 (one metric at a time), `
    + `or gloomberb fn FA ${symbol} --period quarterly (the statements).`;
}

function historyOptionHint(flag: string, args: readonly string[]): string | null {
  if (DATE_WINDOW_OPTIONS.has(flag)) return `history takes a --range instead of dates: ${HISTORY_RANGES.join(", ")}. ${HISTORY_YTD_RANGE}; ${HISTORY_ALL_RANGE}.`;
  if (BAR_SIZE_OPTIONS.has(flag)) return `history serves each --range in one bar size. ${subMinuteDataMessage(historySymbolArg(args))}`;
  return null;
}

/** "Asked YTD, data starts 2026-03-05 (first available bar)" when no bar reaches the prior year's last close. */
function ytdHistoryNotes(rows: readonly { date: string }[]): string[] {
  const first = rows[0]?.date.slice(0, 10);
  const last = rows.at(-1)?.date.slice(0, 10);
  return first && last && first > `${Number(last.slice(0, 4)) - 1}-12-31` ? [`Asked YTD, data starts ${first} (first available bar)`] : [];
}

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const range = parseRange(takeOption(args, "--range"), ctx);
  // YTD reads the year's daily bars and starts at the last one on or before 31 Dec.
  const loadRange: TimeRange = range === "YTD" ? "1Y" : range;
  const requestedExchange = takeOption(args, "--exchange");
  const raw = requireOneArg(args, HISTORY_USAGE, "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, requestedExchange, market, ctx);
    const venues = loadBareVenues(listing, market);
    const { symbol, exchange } = listing.request;
    const context = { cacheMode: ctx.cliOptions.refresh ? "refresh" as const : "default" as const };
    const load = () => market.dataProvider.getPriceHistoryWithMetadata
      ? market.dataProvider.getPriceHistoryWithMetadata(symbol, exchange, loadRange, context)
      : market.dataProvider.getPriceHistory(symbol, exchange, loadRange, context).then((points): PriceHistoryResult => ({ points, resolution: null }));
    const quoted = loadListingQuote(market.dataProvider, listing);
    const fate = listingFateLoader(listing, market, quoted);
    const [loaded, quote] = await Promise.all([
      loadForListing(listing, market, ctx, load, (loaded) => loaded.points.length === 0, {
        command: range === "1Y" ? "history" : `history --range ${range}`, noun: "history", fate,
      })
        .catch((error) => failHistory(error, listing.key, ctx)),
      quoted,
    ]);
    const { resolution } = loaded;
    // While the session trades the day's bar is the quote's, whatever range the history was cut for (withSessionBar).
    const points = withSessionBar(loaded.points, quote, { now: Date.now(), venue: quote?.listingExchangeName || exchange || undefined });
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
    const rows = historyRows(points, resolution, unit.currency, unit.unit, volume);
    const served = range === "YTD" ? rows.slice(Math.max(0, yearToDateStartIndex(rows.map((row) => row.date), rows[0]?.interval))) : rows;
    // Bars stop arriving on the listing's own trading days, not New York's.
    const venue = quote?.listingExchangeName || exchange || undefined;
    // October's monthly bar on 16 Oct runs through the 15th: marked partial, and the status line says how far.
    const forming = formingPeriodBar(served, venue);
    // A complete one is dated by the day its last session closed, the day its close is from.
    const closedDay = forming ? null : closedPeriodBarDay(served, venue);
    const data = forming?.rows ?? served;
    const interval = data[0]?.interval ?? null;
    const decimals = historyPriceDecimals(data, listing.saved?.metadata.assetCategory);
    const price = (value: unknown) => typeof value === "number" ? value.toFixed(decimals) : "";
    // Intraday bars print in UTC, as the charts and time and sales label them, not the host zone.
    const intraday = data.some((row) => row.date.length > 10);
    // A bar history: dated by its last bar, stale once bars of its size stop arriving.
    // The day's own bar, while its session trades, is not a close: dated by the quote it was read from.
    const dayToDate = fromQuote && interval === "1d" && data.at(-1)?.partial === true;
    const freshness = rowsFreshness(data, {
      ...barHistoryFreshness(intraday ? null : barResolutionFromDates(data.map((row) => row.date))),
      observedKey: "date",
      oldest: null,
      cadenceExchange: venue,
      ...(forming ? { periodToDate: forming.periodToDate } : closedDay ? { asOf: closedDay } : {}),
      ...(dayToDate ? { basis: "daily bars", ...(quote && Number.isFinite(quote.lastUpdated) ? { asOf: new Date(quote.lastUpdated).toISOString() } : {}) } : {}),
      ...(volume || dayToDate ? { note: [volume ? historyVolumeText(volume, interval) : null, dayToDate ? `the newest bar is ${DAY_SO_FAR_TEXT}` : null].filter(Boolean).join("; ") } : {}),
    });
    const gaps = historyGapNote(data, traded);
    const coverage = range === "YTD" ? null : historyCoverageWarning(range, loaded);
    const notes = [
      // FB's bars are the fund listed there now; META's from 2021 are from when it was FB.
      ...listingFateNotes(await fate(), { served: data.length > 0, firstDate: data[0]?.date }),
      ...await listingChoiceNotes(listing, market, quote, venues),
      // ALL says where the source's bars start (BTC-USD's in 2014-09), unless the coverage line does.
      ...range === "YTD" ? ytdHistoryNotes(data) : [...historyNotes(range, interval, data[0]?.date, Date.now(), coverage != null), coverage ?? []],
      // The status line says how far a bar still forming runs; the note is for the bars it does not name.
      gaps ?? [], historyJumpNote(data) ?? [], historyFlagNote(data) ?? [], historyMissingVolumeNote(data) ?? [],
      historyBarStatusNote(forming ? served : data) ?? [],
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
    // A bar without volume in a history that reports it prints as missing, never as 0 or blank beside the others.
    const missingVolume = historyReportsVolume(data) ? MISSING_VOLUME_TEXT : "";
    const textPriceColumns = priceColumns.map((column) => column.key !== "volume" ? column
      : { ...column, format: (value: unknown) => formatCountCell(value) || missingVolume });
    // Text shows a flag only on a bar that has one; the column is dropped when none does.
    const flagColumn: CliResultColumn = {
      key: "flag", header: "Flag", format: (value) => typeof value === "string" ? cliStyles.warning(value) : "",
    };
    // Text also marks a bar still forming, rebuilt from hourly bars or closing before its settlement; exports keep them as fields.
    const flagTextColumn: CliResultColumn = {
      ...flagColumn,
      format: (value, row) => [
        typeof value === "string" ? cliStyles.warning(value) : "",
        row.partial ? cliStyles.muted("partial") : "",
        row.filled ? cliStyles.muted("filled") : "",
        row.unsettled ? cliStyles.muted("unsettled") : "",
      ].filter(Boolean).join(" "),
    };
    const marked = data.some((row) => row.partial || row.filled);
    const unsettled = data.some((row) => row.unsettled);
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
      textColumns: [...textPriceColumns, flagTextColumn],
      columns: [
        ...priceColumns,
        flagColumn,
        ...marked ? [{ key: "partial", header: "Partial" }, { key: "filled", header: "Filled" }] : [],
        ...unsettled ? [{ key: "unsettled", header: "Unsettled" }] : [],
        ...volume ? [{ key: "volumeUnit", header: "Volume unit" }, { key: "volumeNote", header: "Volume note" }] : [],
      ],
      // Every exported row says what it is a bar of, the currency a price is in and its bar size, so it survives head and concatenation.
      exportIdentity: { symbolOrSeries: listing.key, currencyOrUnit: unit.currency ?? unit.unit, interval },
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
    // A trailing yield is measured from the cash history as DVD measures it, a forward yield dated ahead names the
    // declared distribution it annualizes (not in JSON), and one whose dividend stopped says so; read beside the listing notes.
    const distributions = view === "statements" ? null : loadDividendDistributions(
      market.dataProvider, listing.request, financials, { declared: ctx.cliOptions.format !== "json" });
    // A bond fund's SEC yield, yield to worst and duration, beside its distribution yield.
    const bondFund = view === "statements" ? null : loadReportBondFacts(listing.request.symbol,
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
      const capitalization = selectMarketCapitalization(priced.quote, priced.fundamentals);
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
      const bond = await bondFund;
      // On the SEC yield when the sponsor publishes one, else the distribution yield the line above shows.
      const taxEquivalent = rates ? analyzeTaxEquivalent({
        symbol: identity.symbol || listing.key, bond, rates, treasury: await treasury,
        distribution: distributionBasis(priced.fundamentals?.dividendYield, priced.fundamentals?.dividendYieldBasis === "trailing" ? "trailing" : "forward"),
      }) : null;
      const report = { ...data, distributions: await distributions, statementFilings, bank: bank.bank, bankNote: bank.note, bondFund: bond, taxEquivalent,
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
    // The rows are the annual years served; older ones are not, and the closing lines say so.
    const historyNotes = statementHistoryNotes("annual", rows.map((row) => row.date), listing.key);
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
  { key: "url", header: "URL", optional: true },
];

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
  { reason, empty, commodity = true, failure }: { reason?: string; empty?: string; commodity?: boolean; failure?: string },
  ctx: Parameters<CliCommandDef["execute"]>[1],
) {
  const searched = failure === undefined;
  const named = searched && commodity && articles.length === 0 && commodityNamedIn(text) !== null;
  const route = named ? await commodityNewsRoute(text) : null;
  ctx.printResult({
    data: articles,
    ...(searched ? {} : { warnings: [`Searching stories for "${text}" failed: ${failure}`] }),
    metadata: { ticker: null, search: text, feed: null, ...(route ? { futuresNews: route.command } : {}) },
    freshness: rowsFreshness(newsRows(articles), cloudNewsFreshness(await cloudRealtimeAccess())),
  }, {
    heading: newsSearchHeading(text, reason),
    rows: newsRows,
    columns: NEWS_COLUMNS,
    empty: named ? noStoriesMessage(text, route) : empty ?? (searched ? noStoriesMessage(text, null) : "No stories to show."),
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
    const read = listing ? listingReadNotes(listing) : [];
    // A word that is also the company's name ("gold" for Gold.com Inc.) says once which ticker it found and how
    // to search the stories that mention it instead, when those stories are mostly about something else.
    const typed = args[0]?.trim() ?? "";
    const wordHint = listing && resolved && !listing.exchange && !feed && !exchangeOption && commonWordCandidate(typed, identity?.name)
      && wordMeansMore(await searchNewsStories(typed, 20).catch(logFailure("cli.commands-market", "Search news stories for a ticker word failed", [])), listing.symbol)
      ? `${typed} → ${identity?.name ?? listing.symbol} (ticker ${listing.symbol}). For stories that mention ${typed.toLowerCase()}, try: ${quotedSearchCommand(typed.toLowerCase())}`
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
];

// The text table names the items before the URL, which a narrow terminal drops first.
const FILING_TEXT_COLUMNS = [
  { key: "filingDate", header: "Date" },
  { key: "form", header: "Form" },
  { key: "companyName", header: "Company", maxWidth: 24 },
  { key: "itemsLabel", header: "Items" },
  { key: "url", header: "URL", optional: true },
];

/** The US listing the SEC files a symbol under, from the symbol's venues: NYSE for SAN's Banco Santander. */
async function registrantUsExchange(market: MarketContext, symbol: string, registrantName: string): Promise<string | null> {
  const venues = (await listingVenues(symbol, market).catch(logFailure("cli.commands-market", "Read listing venues for filings failed", [])))
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
        data: filingsWithItemLabels(filings),
        metadata: { ...listingMetadata(resolved), ...(form ? { form } : {}) },
        freshness: rowsFreshness(filingRows(filings), { ...SEC_FILINGS, observedKey: "filingDate" }),
        ...(choice.length > 0 ? { warnings: choice } : {}),
      }, {
        heading: listingHeading(resolved),
        rows: filingRows,
        columns: FILING_COLUMNS,
        textColumns: FILING_TEXT_COLUMNS,
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
      }, { rows: filingRows, columns: FILING_COLUMNS, textColumns: FILING_TEXT_COLUMNS, empty: message });
    }
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
      `${form4.lines} Form 4 ${form4.lines === 1 ? "line" : "lines"} in the latest ${form4.filings} ${form4.filings === 1 ? "filing" : "filings"}${form4.newestFiled ? `, newest filed ${form4.newestFiled}` : ""}: gloomberb fn INS ${listing.key}`,
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
      insiderCommand ? loadForm4Report(market, listing) : null,
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
      ? rowsFreshness(form4?.newestFiled ? [{ filingDate: form4.newestFiled }] : [], { ...SEC_FILINGS, basis: "Form 4 filings", observedKey: "filingDate" })
      : rowsFreshness(shownRows, { ...SEC_FILINGS, basis: "13F filings" }, { asOf: data.asOf ?? null });
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
        ...(insiderCommand ? {
          form4Insiders: form4?.status ?? null,
          // INS's summary of the latest Form 4 filings, as `fn INS` gives it in its metadata.
          form4: form4 ? { summary: form4.summary, lines: form4.lines, filings: form4.filings, newestFiled: form4.newestFiled, notCovered: form4.home } : null,
        } : {}),
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
      exportIdentity: { symbolOrSeries: listing.key },
      summary: () => [
        [valueBasis ? `Value = ${valueBasis}.` : "", positionsBasis ?? "", shareBasisNote ?? "", unvaluedNote ?? ""].filter(Boolean).join(" "),
        insiderCommand ? insiderSummary(data, listing, identity, form4) : "",
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
  const expiration = takeOption(args, "--expiration");
  const exchangeOption = takeOption(args, "--exchange");
  if (leapsOptions.leaps) {
    // With --leaps, --expiration is a window of one expiry.
    const expirationGiven = expiration != null || rawArgs.some((arg) => arg === "--expiration" || arg.startsWith("--expiration="));
    const criteria = parseLeapsCriteria({ ...leapsOptions.raw, ...expirationGiven ? { "--expiration": expiration ?? "" } : {} });
    if ("error" in criteria) ctx.fail(criteria.error, `Usage: gloomberb ${LEAPS_USAGE}`);
    const entries = normalizeSymbols(args);
    if (entries.length === 0) ctx.fail("--leaps needs at least one symbol.", `Usage: gloomberb ${LEAPS_USAGE}`);
    await withMarketData(ctx, async (market) => runLeapsScreen(await readSymbols(entries, market.dataProvider), exchangeOption, criteria, market, ctx));
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
        `Use ${OPTION_EXPIRATION_FORMAT}.\nUsage: gloomberb ${OPTIONS_USAGE}`,
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
        .then((fallback) => fallback.expirationDates, logFailure("cli-market", "Read available option expirations failed", []));
      const miss = missingExpiryMessage(listing.key, expirationDate, listed);
      ctx.fail(miss.message, miss.details);
    }
    const quote = await quotePromise;
    const identity = listingIdentity(listing, quote);
    // IV and delta are valued at one spot and instant, named under the table and on every exported row.
    const { chain, spot: modelSpot } = valueChainAtModelSpot(loaded, inputs, Date.now(), identity.exchange);
    const basis: OptionsChainBasis = { spot: modelSpot, dividendYield: inputs.dividendYield ?? null,
      openInterest: await loadOptionsChainOpenInterest(symbol, chain) };
    const basisFields = optionsBasisFields(basis);
    const currency = [...chain.calls, ...chain.puts].find((contract) => contract.currency?.trim())?.currency.trim().toUpperCase()
      ?? quote?.currency ?? null;
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
        fields: OPTION_VOLATILITY_FIELDS,
        // What `iv` and `delta` on each contract are valued from; the provider's own impliedVolatility is left as sent.
        model: {
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
      heading: listingHeading(identity),
      rows: (data: OptionsChain) => optionRows(data).map((row) => ({ ...row, ...basisFields })),
      // Choosing an expiry needs the list; once one is chosen the table is that expiry.
      summary: (data: OptionsChain) => expirationDate == null ? formatExpiryList(data.expirationDates) : "",
      empty: `No option contracts for ${listingTitle(identity)}.`,
      ...(contractCount > 0 ? { footnote: optionsBasisFootnote(basis) } : {}),
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
        { key: "delta", header: "Delta (decimal)" },
        { key: "volume", header: "Vol" },
        { key: "openInterest", header: "OI" },
        { key: "spot", header: "Spot" },
        { key: "spotBasis", header: "Spot basis" },
        { key: "spotAsOf", header: "Spot as of" },
        { key: "openInterestAsOf", header: "OI as of" },
      ],
      textColumns: [
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
    exportIdentity: { symbolOrSeries: pair, currencyOrUnit: baseCurrency, interval: "1day" },
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
  if (args.length === 0) ctx.fail(`Usage: gloomberb ${FX_USAGE}`);
  // A forward is implied from today's spot and the latest short rates, which are all Gloom Cloud serves.
  if (dateOption != null && forwardOption != null) {
    ctx.fail(
      "fx --forward does not take --date: the forward is implied from today's spot and the latest short rates, and past short rates are not served.",
      `For that day's close: gloomberb fx ${args.join(" ")} --date ${dateOption}. For today's forward, drop --date.`,
    );
  }
  const date = dateOption == null ? null : readFxDate(dateOption, ctx);
  const tenor = forwardOption == null ? null : parseForwardTenor(forwardOption);
  if (tenor && "error" in tenor) ctx.fail(tenor.error, `Usage: gloomberb ${FX_FORWARD_USAGE}`);
  await withMarketData(ctx, async (market) => {
    const parsed = parseFxArgs(args, market.config.baseCurrency);
    if ("error" in parsed) return ctx.fail(parsed.error, `Usage: gloomberb ${forwardOption == null ? FX_USAGE : FX_FORWARD_USAGE}`);
    if (date) return runFxOnDate(parsed, date, args, market, ctx);
    const { request, amount, toUsdByDefault } = parsed;
    const { currency, baseCurrency } = request;
    const pair = `${currency}/${baseCurrency}`;
    if (tenor) {
      if (amount != null) ctx.fail("--forward prices a pair, not an amount.", `Usage: gloomberb ${FX_FORWARD_USAGE}`);
      if (currency === baseCurrency) ctx.fail(`${pair} has no forward: both sides are ${currency}.`, `Usage: gloomberb ${FX_FORWARD_USAGE}`);
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
    const freshness = fxPairFreshness(new Map(codes.flatMap((code, index) => {
      const leg = legs[index];
      return leg ? [[code, {
        rate: leg.value,
        timing: { asOf: leg.asOf, staleAt: leg.staleAt, error: leg.refreshError, delayMinutes: leg.delayMinutes },
      }] as const] : [];
    })));
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
      const forwardWarnings = [...request.readAs ?? [], ...staleRates];
      return ctx.printResult({ data: [forwardRow], freshness, ...(forwardWarnings.length > 0 ? { warnings: forwardWarnings } : {}) }, {
        text: () => [
          `${pair} ${tenor.label} forward ${formatFxRate(implied.forward)}, ${IMPLIED_FORWARD_LABEL}`,
          `Spot ${formatFxRate(rate)} · forward points ${formatForwardPoints(implied.points)} (pips of ${implied.pointSize}) · ${implied.premiumPercent >= 0 ? "premium" : "discount"} ${formatSignedPercent(implied.premiumPercent)} over ${tenor.days} days to ${forwardDate}, ${formatSignedPercent(implied.annualizedPercent, 2)} a year (×360/${tenor.days})`,
          `${currency} rate: ${describeShortRate(base.rate)}`,
          `${baseCurrency} rate: ${describeShortRate(quote.rate)}`,
          `Covered interest parity: ${formatFxRate(rate)} × ${growth(quote.rate)} / ${growth(base.rate)}; each rate earns simple interest over the ${tenor.days} days, standing in for a ${tenor.label} term rate.`,
        ].join("\n"),
        exportIdentity: { symbolOrSeries: pair, currencyOrUnit: baseCurrency, interval: `forward ${tenor.label}` },
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
    ];
    ctx.printResult({ data: [row], freshness, warnings: warnings.length > 0 ? warnings : undefined }, {
      // The conversion, then the rate it used; the source line under it dates that rate.
      text: () => amount == null ? describeFxRate(request, rate) : `${describeFxConversion(request, amount, rate)}\n${describeFxRate(request, rate)}`,
      // The rate is the base currency's price of one unit of the other, at the latest quote of each leg.
      exportIdentity: { symbolOrSeries: pair, currencyOrUnit: baseCurrency, interval: "spot" },
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
  if (entries.length === 0) ctx.fail("Usage: gloomberb earnings <symbol...>");
  await withCliServices(ctx, async (services) => {
    const symbols = await readSymbols(entries, services.dataProvider);
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
      usage: ["quote <symbol...>", "quote --file <path>"],
      options: [EXCHANGE_OPTION, LIST_FILE_OPTION],
      examples: ["quote AAPL MSFT NVDA", "quote SAN:EPA BHP:ASX", "quote BTC-USD EURUSD=X", "quote binance:BZUSDT", "quote AAPL --json", "quote --file holdings.csv"],
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
      examples: ["compare KO PEP", "compare SAN:EPA SAN:NYSE", "compare SPY QQQ IWM --csv", "compare - < peers.txt"],
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
        { flags: "--range <range>", description: `${HISTORY_RANGES.join(", ")} (default 1Y); ${HISTORY_YTD_RANGE}; ${HISTORY_ALL_RANGE}` },
        EXCHANGE_OPTION,
      ],
      sections: [{
        title: "Bars",
        lines: [
          `Each range comes in one bar size: ${historyIntervalsByRange()}. The line under the heading, and the --json metadata, give the currency, the bar size actually served, the first and last bar and the bar count. A warning says when the bars are coarser, or start later, than the range asked for, and for a coin, which trades every day, names each day it has no bar for.`,
          "A bar whose prices contradict each other (high below the open or close, or low above them) is left blank and flagged, such as high<open, with the count in a warning. Every --csv and --ndjson row carries its flag and ends with symbol_or_series, currency_or_unit, interval, source and as_of; --json rows carry currency, unit, interval and flag.",
          "A break in the series flags the bar after it, which keeps its prices: gap after more than three months with no bar (weeks for weekly, daily and intraday bars), jump when the close is over 100 times the one before or under a hundredth of it. A warning names each break, and the heading says the date the series runs unbroken from.",
        ],
      }, {
        title: "Long history",
        lines: [
          "ZAR has daily FRED data from 1980: gloomberb fred DEXSFUS --start 1980 --sort asc --csv",
          "NGN, SAR and ILS have no FRED series. Their daily bars cover the last five years (gloomberb fn G USDNGN=X --rangePreset 5Y --chartResolution 1d --csv); before that there are monthly bars only (gloomberb history USDNGN=X --range ALL).",
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
          flags: `--expiration <${OPTION_EXPIRATION_PLACEHOLDER}>`,
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
          "An amount in front converts it from the first currency to the second: fx 1234.5 EUR/USD, or fx 1234,5 EUR USD. It takes either decimal mark (1.234,5 and 1,234.5 are 1234.5) and reads as an amount of the first currency: 1,234 or 1.234 EUR are thousands, a third decimal being below a cent, while in a currency with three decimals (KWD) fx asks which. An amount and one currency converts to USD. The answer gives the converted amount, then the rate it used, dated by the source line; --json adds amount and converted.",
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
