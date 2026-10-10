import type { CliCommandDef } from "../../types/plugin";
import { TIME_RANGES, type TimeRange } from "../../time-series/range";
import type { EarningsEvent, QuoteBatchResult, QuoteSubscriptionTarget, SecFilingItem } from "../../types/data-provider";
import type { NewsArticle, NewsFeed, NewsQuery } from "../../news/types";
import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  OptionsChain,
  TickerFinancials,
} from "../../types/financials";
import { currencyMinorDigits, formatMarketPrice, formatMarketPriceWithCurrency, quoteFormatOptions } from "../../market-data/market/format";
import {
  EXTENDED_SESSION_LABELS,
  getExtendedSessionDisplay,
  getQuoteSessionFields,
  getRegularSessionDisplay,
  marketStateLabel,
  type ExtendedSession,
} from "../../market-data/market/status";
import { formatCompact, formatDistributionAmount, formatPercent, formatPercentRaw } from "../../utils/format";
import { withCliServices, withMarketData } from "../context";
import { isoDate, parsePositiveInt, rejectExtraArgs, requireOneArg, takeFlag, takeOption } from "./command-utils";
import type { BuiltinCliCommandDef } from "../command-options";
import { CLI_COMMAND_GROUPS, TABLE_SECTION_OPTION } from "../help";
import {
  formatChangePercentCell,
  formatCountCell,
  formatFractionPercentCell,
  formatPriceRange,
} from "../helpers";
import { cliStyles, renderStats } from "../../utils/cli-output";
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
import { fundamentalsReportTables, renderFundamentalsReport } from "./ticker";
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
import {
  exportRowsTable,
  reportFooterLines,
  selectReportTables,
  type CliReportTables,
} from "../report-tables";
import {
  historyFacts,
  historyFlagNote,
  historyAllRangeYears,
  historyIntervalsByRange,
  historyNotes,
  historyPriceDecimals,
  historyRows,
  historyUnit,
} from "../history-rows";
import { CRYPTO_BOARD_HINT, quoteNotes } from "./crypto-hints";
import { formatUtcTime } from "../../utils/utc-time";
import { isFiniteNumber } from "../../utils/guards";
import { exportedFundamentals } from "../../utils/price-earnings";
import { fundamentalsFreshness, quotesFreshness, rowsFreshness } from "../freshness";
import {
  barHistoryFreshness,
  barResolutionFromDates,
  cloudNewsFreshness,
  cloudRealtimeAccess,
  REPORTED_DATA,
  SEC_FILINGS,
} from "../../plugins/builtin/shared/report-freshness";
import {
  EXCHANGE_OPTION,
  isNoProviderError,
  listingHeading,
  listingIdentity,
  listingTitle,
  listingVenues,
  loadForListing,
  loadListingQuote,
  notTradedMessage,
  otherListingsMessage,
  requireCliListing,
  type CliListing,
  type ListingIdentity,
} from "../listing-arg";
import { providerMissReason } from "../../sources/provider-errors";
import { isNotATickerMessage } from "../not-a-ticker";
import { secRegistrantMismatchMessage, SecRegistrantMismatchError, areDifferentCompanies } from "../../sources/sec-registrant";
import { isCryptoPairSymbol } from "../../utils/crypto-pair";
import { isUsListingExchange } from "../../utils/exchanges";
import { nonUsSecListingVenue } from "../../utils/sec";
import type { MarketContext } from "../types";
import { windowRows } from "../row-window";
import { crossRate, describeFxRate, isUsableRate, parseFxRequest } from "../fx-pair";
import {
  holderListFacts,
  holderShareBasisMarker,
  holderShareBasisNote,
  holderValueBasis,
  moneyColumnHeader,
  nonUsHolderCaveat,
  sharedReportDate,
} from "../../plugins/builtin/holders/report-header";
import { formatHolderOwnershipPercent, holderValueCurrency } from "../../plugins/builtin/holders/format";
import { fetchBeneficialOwners } from "../../plugins/builtin/holders/beneficial-client";
import { filingFormMatches, SEC_FILING_FETCH_LIMIT } from "../../plugins/builtin/sec/forms";
import {
  BENEFICIAL_REPORT_COLUMNS,
  beneficialCoverageNotices,
  beneficialListComplete,
  beneficialListFacts,
  beneficialListUnreadable,
  beneficialRouteForm,
  buildBeneficialReportRows,
  HOLDER_FORMS,
  parseHolderForm,
  type HolderForm,
} from "../../plugins/builtin/holders/beneficial-report";

const VALID_RANGES = new Set<TimeRange>(TIME_RANGES);
const VALID_NEWS_FEEDS = new Set<NewsFeed>(["latest", "top", "breaking", "ticker", "sector", "topic"]);

type QuoteCliRecord = Omit<QuoteBatchResult, "error"> & { error: string | null };
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

function normalizeSymbols(args: string[]): string[] {
  return args
    .flatMap((arg) => arg.split(","))
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
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
        : String(value ?? "")
    ),
  },
  { key: "changePercent", header: "Chg%", align: "right" as const, format: formatChangePercentCell },
  // Text drops a column no row fills, so a table without an extended print stays as narrow as before.
  extendedColumn("PRE"),
  extendedColumn("POST"),
  { key: "session", header: "Session", shrink: false },
];

type QuoteRow = ReturnType<typeof quoteRows>[number];

/** The pre-market or after-hours print and its move from the regular close, in its own column. */
function extendedColumn(session: ExtendedSession) {
  return {
    key: session === "PRE" ? "preMarket" : "afterHours",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right" as const,
    value: (row: QuoteRow) => row.extendedSession === session && row.extendedPrice
      ? [row.extendedPrice, row.extendedChangePercent == null ? "" : formatPercentRaw(row.extendedChangePercent)].join(" ").trim()
      : "",
    format: (value: unknown, row: QuoteRow) => (
      value ? [row.extendedPrice, formatChangePercentCell(row.extendedChangePercent)].join(" ").trim() : ""
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
    // Whether the price is real-time or delayed: a feed state, not where it came from.
    { key: "source", header: "Feed", shrink: false, optional: true, dropPriority: 2, format: (value: unknown) => value === "live" || value === "delayed" ? value : "" },
    // In a narrow terminal the closing line's as-of stands in for each row's.
    { key: "updatedAt", header: "Updated", shrink: false, optional: true, dropPriority: 3 },
  ];
}

function compareColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "previousClose", header: "Prev Close", align: "right" as const },
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

function quoteRows(results: QuoteCliRecord[]) {
  return results.map((result) => {
    const quote = result.quote;
    // Last and Chg% are the regular session, as `ticker` and the quote monitor read it; a
    // pre-market or after-hours print is its own column, measured from that session's close.
    const display = getRegularSessionDisplay(quote);
    const extended = getExtendedSessionDisplay(quote);
    // An index level is in points, not in the currency its members trade in.
    const indexPoints = quote?.instrumentType?.trim().toUpperCase() === "INDEX";
    // Pad to two decimals so a column lines up, but never past the currency's minor unit (JPY has none).
    // Points have no minor unit, so a yen-listed index still pads to two.
    const options = {
      ...quoteFormatOptions(quote),
      minimumFractionDigits: indexPoints ? 2 : Math.min(2, currencyMinorDigits(quote?.currency)),
    };
    const price = (value: number | undefined) => (
      quote && value != null
        ? indexPoints ? formatMarketPrice(value, options) : formatMarketPriceWithCurrency(value, quote.currency, options)
        : ""
    );
    return {
      symbol: result.target.symbol,
      name: quote?.name ?? "",
      price: price(display?.price),
      rawPrice: display?.price ?? null,
      priceBasis: quote?.priceBasis ?? null,
      instrumentType: quote?.instrumentType ?? null,
      change: display?.change ?? null,
      changePercent: roundedPercent(display?.changePercent),
      extendedSession: extended?.session ?? null,
      extendedPrice: price(extended?.price),
      rawExtendedPrice: extended?.price ?? null,
      extendedChange: extended?.change ?? null,
      extendedChangePercent: roundedPercent(extended?.changePercent),
      session: quote?.marketState ? marketStateLabel(quote.marketState) : "",
      // The close the shown move is measured from: the one before the session Last is.
      previousClose: price(display?.change != null ? display.price - display.change : quote?.previousClose),
      dayRange: quote?.low != null && quote.high != null
        ? indexPoints ? `${price(quote.low)}-${price(quote.high)}` : formatPriceRange(quote.low, quote.high, quote.currency, options, "-")
        : "",
      volume: quote?.volume ?? null,
      currency: quote?.currency ?? "",
      providerId: quote?.providerId ?? "",
      source: quote?.dataSource ?? quote?.providerId ?? "",
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

function holderRows(data: HolderData, ownerTypes?: Set<string>) {
  const holders = ownerTypes
    ? data.holders.filter((holder) => ownerTypes.has(holder.ownerType))
    : data.holders;
  return holders.map((holder) => ({
    type: holder.ownerType,
    name: holder.name,
    reportDate: holder.reportDate ?? "",
    shares: holder.shares ?? null,
    value: holder.value ?? null,
    percentHeld: holder.percentHeld ?? null,
    changeShares: holder.changeShares ?? null,
    shareBasis: holder.shareBasis ?? null,
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
    timing: event.timing,
    epsEstimate: event.epsEstimate,
    epsActual: event.epsActual,
    revenueEstimate: event.revenueEstimate,
    revenueActual: event.revenueActual,
  }));
}

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
    const results = await market.dataProvider.getQuotesBatch(targets, { forceRefresh: ctx.cliOptions.refresh });
    const listingOf = (result: QuoteBatchResult, index: number) => listings[targets.indexOf(result.target)] ?? listings[index]!;
    // A listing with no quote on an exchange its symbol is not listed on says so, and a bare
    // symbol no source quotes names its other listings; venues are only looked up for those.
    const request = { command: commandName, noun: "quote" };
    const unquoted = await Promise.all(results.map(async (result, index) => {
      if (result.quote) return null;
      const listing = listingOf(result, index);
      const notTraded = await notTradedMessage(listing, market);
      if (notTraded) return { message: notTraded, details: undefined, oneLine: notTraded };
      const other = isNoProviderError(result.error) ? await otherListingsMessage(listing, market, request) : null;
      return other && { ...other, oneLine: `${other.message} Other listings: ${other.others.join(", ")}.` };
    }));
    if (listings.length === 1 && unquoted[0]) ctx.fail(unquoted[0].message, unquoted[0].details);
    const notTraded = unquoted.map((entry) => entry?.oneLine ?? null);
    // Each row names its listing by key (SAN:EPA) and company, so the table needs no line above it.
    const data = results.map((result, index) => ({
      target: result.target,
      listing: listingMetadata(listingIdentity(listingOf(result, index), result.quote)),
      // The figures the table shows, beside the quote as the source sent it.
      ...getQuoteSessionFields(result.quote),
      quote: result.quote,
      error: notTraded[index] ?? errorMessage(result.error),
    }));
    // Text mode shows only "unavailable" in the cell; the JSON rows already carry each reason.
    const notes = ctx.cliOptions.format === "text" ? quoteNotes(data, { exchange }) : [];
    ctx.printResult({
      data,
      warnings: notes.length > 0 ? notes : undefined,
      freshness: quotesFreshness(data.map((row) => row.quote)),
    }, {
      rows: quoteRows,
      columns: commandName === "compare" ? compareColumns() : quoteColumns(),
    });
  });
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

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const range = parseRange(takeOption(args, "--range"), ctx);
  const requestedExchange = takeOption(args, "--exchange");
  const raw = requireOneArg(args, HISTORY_USAGE, "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, requestedExchange, market, ctx);
    const { symbol, exchange } = listing.request;
    const context = { cacheMode: ctx.cliOptions.refresh ? "refresh" as const : "default" as const };
    const load = () => market.dataProvider.getPriceHistoryWithMetadata
      ? market.dataProvider.getPriceHistoryWithMetadata(symbol, exchange, range, context)
      : market.dataProvider.getPriceHistory(symbol, exchange, range, context).then((points) => ({ points, resolution: null }));
    const [{ points, resolution }, quote] = await Promise.all([
      loadForListing(listing, market, ctx, load, (loaded) => loaded.points.length === 0, {
        command: range === "1Y" ? "history" : `history --range ${range}`, noun: "history",
      })
        .catch((error) => failHistory(error, listing.key, ctx)),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    // Without a quote currency, the listing metadata research reads (as `ticker` does) may still state it.
    const listed = quote?.currency ? quote : await market.dataProvider.getQuoteMetadata?.(symbol, exchange).catch(() => null);
    const unit = historyUnit(listing.symbol, listed ?? quote);
    const data = historyRows(points, resolution, unit.currency);
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
    });
    const notes = [...historyNotes(range, interval, data[0]?.date), historyFlagNote(data) ?? []].flat();
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
        bars: data.length,
        asOf: freshness?.asOf ?? null,
      },
      ...(notes.length > 0 ? { warnings: notes } : {}),
      freshness,
    }, {
      heading: `${listingHeading(identity)}\n${cliStyles.muted(historyFacts(unit, data).join("  ·  "))}`,
      dateKey: "date",
      textColumns: [...priceColumns, flagColumn],
      // Every exported row says its currency and bar size, so it survives head and concatenation.
      columns: [
        ...priceColumns,
        { key: "currency", header: "Currency" },
        { key: "interval", header: "Interval" },
        flagColumn,
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
    const financials = await loadForListing(listing, market, ctx, () => market.dataProvider.getTickerFinancials(
      listing.request.symbol, listing.request.exchange, { cacheMode: ctx.cliOptions.refresh ? "refresh" : "default" },
    ), undefined, { command: commandName, noun: commandName === "valuation" ? "valuation data" : commandName });
    const identity = listingIdentity(listing, financials.quote);
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
    }, {
      heading: listingHeading(identity),
      rows: () => rows,
      columns: STATEMENT_COLUMNS,
      ...(tables && ctx.cliOptions.format === "csv" ? { tables } : {}),
    });
  });
}

async function runNews(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const feed = parseNewsFeed(takeOption(args, "--feed"));
  const exchangeOption = takeOption(args, "--exchange");
  if (exchangeOption && !args[0]) ctx.fail("--exchange needs a symbol: gloomberb news <symbol> --exchange <code>");
  rejectExtraArgs(args, 1, { usage: "news [symbol] [--feed <feed>]", takes: "one symbol at most", advice: "Run it once per symbol." }, ctx);
  await withMarketData(ctx, async (market) => {
    const listing = args[0] ? await requireCliListing(args[0], exchangeOption, market, ctx) : null;
    // Stories come newest first, so the newest n are the first n either way.
    const limit = ctx.cliOptions.tail ?? ctx.cliOptions.limit ?? 20;
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
    ctx.printResult({
      data: articles,
      metadata: { ticker: listing?.key ?? null, ...(identity ? listingMetadata(identity) : {}), feed: feed ?? null },
      freshness: rowsFreshness(newsRows(articles), cloudNewsFreshness(await cloudRealtimeAccess())),
    }, {
      ...(identity ? { heading: listingHeading(identity) } : {}),
      rows: newsRows,
      columns: [
        // UTC with the zone named, as every CLI time prints, rather than the host zone unlabeled.
        {
          key: "publishedAt",
          header: "Published",
          format: (value) => typeof value === "string" ? formatUtcTime(value) : "",
        },
        { key: "source", header: "Source", maxWidth: 20 },
        { key: "title", header: "Title" },
        { key: "tickers", header: "Tickers", maxWidth: 16 },
        { key: "url", header: "URL", optional: true },
      ],
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
      ctx.printResult({
        data: filings,
        metadata: { ...listingMetadata(resolved), ...(form ? { form } : {}) },
        freshness: rowsFreshness(filingRows(filings), { ...SEC_FILINGS, observedKey: "filingDate" }),
      }, {
        heading: listingHeading(resolved),
        rows: filingRows,
        columns: FILING_COLUMNS,
        empty: form ? `No ${form} filings found for ${listingTitle(resolved)}.` : `No SEC filings found for ${listingTitle(resolved)}.`,
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

/**
 * Holder lists name institutions and funds; individual insiders rarely appear.
 * The insider share of the company is reported either way, so say it.
 */
function insiderSummary(data: HolderData, ownerTypes: Set<string>): string {
  const held = data.summary?.insidersPercentHeld;
  const share = held == null || !Number.isFinite(held)
    ? ""
    : `Insiders hold ${formatFractionPercentCell(held)} of shares outstanding.`;
  const listed = data.holders.some((holder) => ownerTypes.has(holder.ownerType));
  const transactions = listed ? "" : `Form 4 transactions: gloomberb fn INS ${data.symbol}`;
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
  const [payload, holders, quote] = await Promise.all([
    loadForListing(listing, market, ctx, () => fetchBeneficialOwners(symbol, request)),
    market.dataProvider.getHolders?.(symbol, exchange).catch(() => null) ?? null,
    quotePromise,
  ]);
  const identity = listingIdentity(listing, quote);
  const rows = buildBeneficialReportRows(payload, { history, holders });
  const notices = beneficialCoverageNotices(payload.coverage);
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
    },
  }, {
    heading: `${listingHeading(identity)}${cliStyles.muted(beneficialListFacts(payload, form, rows.length, history).map((fact) => `  ·  ${fact}`).join(""))}`,
    textColumns: BENEFICIAL_REPORT_COLUMNS,
    columns: [
      ...BENEFICIAL_REPORT_COLUMNS,
      { key: "status", header: "Status" },
      { key: "filerCik", header: "Filer CIK" },
      { key: "accessionNumber", header: "Accession" },
      { key: "filingUrl", header: "URL" },
    ],
    empty: beneficialListUnreadable(payload)
      ? `13D/13G filings for ${listingTitle(identity)} are listed but could not be read.`
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
    const [data, quote] = await Promise.all([
      loadForListing(
        listing, market, ctx,
        () => market.dataProvider.getHolders(listing.request.symbol, listing.request.exchange),
        (found) => found.holders.length === 0,
        { command: commandName, noun: "holder data" },
      ),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    const rows = holderRows(data, ownerTypes);
    const shown = windowRows(rows, ctx.cliOptions).rows.length;
    const institutional = !ownerTypes?.has("insider");
    const total = institutional ? data.summary?.institutionsCount ?? null : null;
    const reportDate = sharedReportDate(rows);
    // A London line's values can be dollars from the 13F filings; the listing's currency is not their unit.
    const valueCurrency = holderValueCurrency(data);
    const valueBasis = rows.length > 0 ? holderValueBasis(reportDate, data.valueBasis, valueCurrency) : null;
    const positionsBasis = rows.length > 0 ? nonUsHolderCaveat(identity.exchange || data.exchange, data.currency) : null;
    const shareBasisNote = holderShareBasisNote(data, rows);
    const markedRows = rows.some((row) => holderShareBasisMarker(row));
    // The heading names the listing; its unit, date and how much of the list follows on the same line.
    const facts = holderListFacts({
      currency: valueCurrency, listingCurrency: data.currency, asOf: data.asOf, shown, reported: rows.length, total,
    });
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        summary: data.summary,
        currency: data.currency ?? null,
        valueCurrency: valueCurrency ?? null,
        asOf: data.asOf ?? null,
        shown,
        reported: rows.length,
        total,
        truncated: shown < (total ?? rows.length),
        valueBasis,
        positionsBasis,
      },
    }, {
      heading: `${listingHeading(identity)}${cliStyles.muted(facts.map((fact) => `  ·  ${fact}`).join(""))}`,
      rows: () => rows,
      columns: [
        { key: "type", header: "Type" },
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
          format: (value) => isFiniteNumber(value) ? formatHolderOwnershipPercent(value) : "",
        },
      ],
      summary: (holderData: HolderData) => [
        [valueBasis ? `Value = ${valueBasis}.` : "", positionsBasis ?? "", shareBasisNote ?? ""].filter(Boolean).join(" "),
        commandName === "insider" && ownerTypes ? insiderSummary(holderData, ownerTypes) : "",
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
    const [data, quote] = await Promise.all([
      loadForListing(
        listing, market, ctx, () => market.dataProvider.getAnalystResearch(listing.request.symbol, listing.request.exchange),
        undefined, { command: "analyst", noun: "analyst research" },
      ),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
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
  const raw = requireOneArg(args, "events <symbol>", "symbol", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const [data, quote] = await Promise.all([
      loadForListing(
        listing, market, ctx, () => market.dataProvider.getCorporateActions(listing.request.symbol, listing.request.exchange),
        undefined, { command: "events", noun: "corporate events" },
      ),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    ctx.printResult({
      data,
      metadata: listingMetadata(identity),
      freshness: rowsFreshness(corporateActionRows(data), {
        ...REPORTED_DATA, basis: "corporate actions", observedKey: "date", oldest: null,
      }),
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
    const quotePromise = loadListingQuote(market.dataProvider, listing);
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
    }, undefined, { command: "options", noun: "options chain" });
    const inputs = await inputsPromise;
    if (expirationDate != null && !chainHasExpiry(loaded, expirationDate)) {
      // An unlisted date comes back as an empty chain; its own list of expiries, else the default chain's, says what to pick.
      const listed = loaded.expirationDates.length > 0 ? loaded.expirationDates : await market.dataProvider
        .getOptionsChain(symbol, exchange, undefined, { cacheMode: "default" })
        .then((fallback) => fallback.expirationDates, () => []);
      const miss = missingExpiryMessage(listing.key, expirationDate, listed);
      ctx.fail(miss.message, miss.details);
    }
    const identity = listingIdentity(listing, await quotePromise);
    const chain = chainWithModelFigures(loaded, inputs);
    // A failed refresh falls back to the stored chain, which can be days old.
    const refreshWarning = result?.refreshError == null ? null
      : `Options refresh failed; showing the chain stored ${new Date(result.fetchedAt).toISOString()}`
        + (chain.asOf ? ` (last trade ${chain.asOf})` : "");
    const sessionWarning = refreshWarning ? null : priorSessionChainWarning(chain, identity.exchange, Date.now());
    const modelWarning = inputs.spot == null && (chain.calls.length > 0 || chain.puts.length > 0)
      ? `IV and delta need a current ${listing.key} quote; those columns are blank`
      : null;
    const warnings = [refreshWarning ?? sessionWarning, modelWarning].filter((warning): warning is string => warning != null);
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
    ctx.printResult({ data: [row] }, {
      text: () => {
        const time = asOf ? `As of ${formatUtcTime(asOf)}` : "";
        const when = stale ? cliStyles.warning(time ? `${time}, stale` : "Stale") : time && cliStyles.muted(time);
        return [describeFxRate(request, rate), when].filter(Boolean).join("\n");
      },
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
    const events = await loadForListing(
      listings, services, ctx,
      () => services.dataProvider.getEarningsCalendar(listings.map((listing) => listing.key)),
      (found) => found.length === 0,
    );
    ctx.printResult({
      data: events,
      freshness: rowsFreshness(earningsRows(events), { status: "not-a-feed", basis: "calendar", observedKey: "date", oldest: null }),
    }, {
      rows: earningsRows,
      columns: [
        { key: "date", header: "Date" },
        { key: "symbol", header: "Symbol" },
        { key: "name", header: "Name" },
        { key: "timing", header: "Timing" },
        { key: "epsEstimate", header: "EPS Est", align: "right", format: formatEpsCell },
        { key: "epsActual", header: "EPS", align: "right", format: formatEpsCell },
      ],
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
      examples: ["quote AAPL MSFT NVDA", "quote SAN:EPA BHP:ASX", "quote BTC-USD EURUSD=X", "quote AAPL --json"],
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
          `Each range comes in one bar size: ${historyIntervalsByRange()}. The line under the heading, and the --json metadata, give the currency, the bar size actually served, the first and last bar and the bar count. A warning says when the bars are coarser, or start later, than the range asked for.`,
          "A bar whose prices contradict each other (high below the open or close, or low above them) is left blank and flagged, such as high<open, with the count in a warning. Every exported row (--csv, --ndjson, --json) carries currency, interval and flag.",
        ],
      }],
      examples: ["history AAPL", "history BHP:ASX --range 5Y", "history ZAR=X --range ALL", "history ZAR=X --tail 5", "history AAPL --range 5Y --csv > aapl.csv"],
    },
    unknownOptionHint: (flag) => DATE_WINDOW_OPTIONS.has(flag)
      ? `history takes a --range instead of dates: ${TIME_RANGES.join(", ")}. ${HISTORY_ALL_RANGE}.`
      : null,
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
      examples: ["holders AAPL", "holders SAN:EPA", "holders CAR --form all", "holders CAR --form 13g --history --json"],
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
    description: "Fetch market headlines, or news for one symbol",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["news [symbol] [--feed <feed>]"],
      options: [
        { flags: "--feed <feed>", description: "latest, top, or breaking for market news (default latest)" },
        EXCHANGE_OPTION,
      ],
      examples: ["news", "news TSLA", "news SAN:EPA", "news --feed top --limit 10"],
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
