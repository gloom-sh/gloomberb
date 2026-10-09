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
import { getActiveQuoteDisplay, marketStateLabel } from "../../market-data/market/status";
import { formatCompact, formatDistributionAmount, formatPercent } from "../../utils/format";
import { withCliServices, withMarketData } from "../context";
import { isoDate, parsePositiveInt, requireArg, takeOption } from "./command-utils";
import { CLI_COMMAND_GROUPS } from "../help";
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
import { optionQuoteSide } from "../../plugins/builtin/options/market-reference";
import { getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../../market-data/published-us-sessions";
import { renderFundamentalsReport } from "./ticker";
import { historyPriceDecimals, historyRows } from "../history-rows";
import { CRYPTO_BOARD_HINT, isCryptoPairSymbol, quoteNotes } from "./crypto-hints";
import { formatUtcTime } from "../../utils/utc-time";
import {
  EXCHANGE_OPTION,
  listingHeading,
  listingIdentity,
  listingTitle,
  listingVenues,
  loadListingQuote,
  requireCliListing,
  type ListingIdentity,
} from "../listing-arg";
import { secRegistrantMismatchMessage, SecRegistrantMismatchError, areDifferentCompanies } from "../../sources/sec-registrant";
import { isUsListingExchange } from "../../utils/exchanges";
import { nonUsSecListingVenue } from "../../utils/sec";
import type { MarketContext } from "../types";
import {
  holderListFacts,
  holderValueBasis,
  moneyColumnHeader,
  nonUsHolderCaveat,
  sharedReportDate,
} from "../../plugins/builtin/holders/report-header";

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

const QUOTE_LEAD_COLUMNS = [
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  {
    key: "price",
    header: "Last",
    align: "right" as const,
    format: (value: unknown, row: ReturnType<typeof quoteRows>[number]) => (
      row.error && !value ? cliStyles.danger("unavailable") : String(value ?? "")
    ),
  },
  { key: "changePercent", header: "Chg%", align: "right" as const, format: formatChangePercentCell },
  { key: "session", header: "Session" },
];

function quoteColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "currency", header: "Cur" },
    // Whether the price is real-time or delayed: a feed state, not where it came from.
    { key: "source", header: "Feed", format: (value: unknown) => value === "live" || value === "delayed" ? value : "" },
    { key: "updatedAt", header: "Updated" },
  ];
}

function compareColumns() {
  return [
    ...QUOTE_LEAD_COLUMNS,
    { key: "previousClose", header: "Prev Close", align: "right" as const },
    { key: "dayRange", header: "Day Range", align: "right" as const },
    { key: "volume", header: "Volume", align: "right" as const, format: formatCountCell },
    { key: "currency", header: "Cur" },
  ];
}

function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  return error instanceof Error ? error.message : String(error);
}

function quoteRows(results: QuoteCliRecord[]) {
  return results.map((result) => {
    const quote = result.quote;
    // Same price and move as the quote monitor: the live session's print against the daily reference.
    const display = getActiveQuoteDisplay(quote);
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
      changePercent: display?.changePercent == null ? null : Number(display.changePercent.toFixed(2)),
      session: quote?.marketState ? marketStateLabel(quote.marketState) : "",
      // The close the shown move is measured from; a pre-market move starts at the last close.
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

function optionRows(chain: OptionsChain) {
  return [...chain.calls.map((contract) => ({ side: "call", ...contract })), ...chain.puts.map((contract) => ({ side: "put", ...contract }))]
    .map((contract) => ({
      side: contract.side,
      contract: contract.contractSymbol,
      strike: contract.strike,
      last: contract.lastPrice,
      bid: contract.bid,
      ask: contract.ask,
      volume: contract.volume,
      openInterest: contract.openInterest,
      iv: contract.impliedVolatility,
      expiration: new Date(contract.expiration * 1000).toISOString().slice(0, 10),
    }));
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

function formatOptionQuoteCell(row: Record<string, unknown>, side: "bid" | "ask"): string {
  const quote = optionQuoteSide({ bid: Number(row.bid), ask: Number(row.ask) }, side);
  return quote == null ? "—" : String(quote);
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
    // Each row names its listing by key (SAN:EPA) and company, so the table needs no line above it.
    const data = results.map((result, index) => ({
      target: result.target,
      listing: listingMetadata(listingIdentity(listings[targets.indexOf(result.target)] ?? listings[index]!, result.quote)),
      quote: result.quote,
      error: errorMessage(result.error),
    }));
    // Text mode shows only "unavailable" in the cell; the JSON rows already carry each reason.
    const notes = ctx.cliOptions.format === "text" ? quoteNotes(data, { exchange }) : [];
    ctx.printResult({ data, warnings: notes.length > 0 ? notes : undefined }, {
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

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const range = parseRange(takeOption(args, "--range"), ctx);
  const requestedExchange = takeOption(args, "--exchange");
  const raw = requireArg(args[0], "Usage: gloomberb history <symbol> [--range <range>]", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, requestedExchange, market, ctx);
    const { symbol, exchange } = listing.request;
    const context = { cacheMode: ctx.cliOptions.refresh ? "refresh" as const : "default" as const };
    const loaded = market.dataProvider.getPriceHistoryWithMetadata
      ? market.dataProvider.getPriceHistoryWithMetadata(symbol, exchange, range, context)
      : market.dataProvider.getPriceHistory(symbol, exchange, range, context).then((points) => ({ points, resolution: null }));
    const [{ points, resolution }, quote] = await Promise.all([
      loaded.catch((error) => failHistory(error, listing.key, ctx)),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    const data = historyRows(points, resolution);
    const decimals = historyPriceDecimals(data, listing.saved?.metadata.assetCategory);
    const price = (value: unknown) => typeof value === "number" ? value.toFixed(decimals) : "";
    // Intraday bars print in UTC, as the charts and time and sales label them, not the host zone.
    const intraday = data.some((row) => row.date.length > 10);
    ctx.printResult({ data, metadata: { ...listingMetadata(identity), range, resolution } }, {
      heading: listingHeading(identity),
      columns: [
        intraday
          ? { key: "date", header: "Time", format: (value) => typeof value === "string" ? formatUtcTime(value) : "" }
          : { key: "date", header: "Date" },
        { key: "open", header: "Open", align: "right", format: price },
        { key: "high", header: "High", align: "right", format: price },
        { key: "low", header: "Low", align: "right", format: price },
        { key: "close", header: "Close", align: "right", format: price },
        { key: "volume", header: "Volume", align: "right", format: formatCountCell },
      ],
    });
  });
}

type FinancialsView = "statements" | "fundamentals" | "valuation";

async function runFinancials(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], view: FinancialsView) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const commandName = view === "statements" ? "financials" : view;
  const raw = requireArg(args[0], `Usage: gloomberb ${commandName} <symbol>`, ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const financials = await market.dataProvider.getTickerFinancials(listing.request.symbol, listing.request.exchange, {
      cacheMode: ctx.cliOptions.refresh ? "refresh" : "default",
    });
    const identity = listingIdentity(listing, financials.quote);
    const data: FinancialsCliData = {
      symbol: listing.key,
      exchange: identity.exchange,
      providerId: financials.quote?.providerId ?? null,
      ...financials,
    };
    if (view !== "statements") {
      ctx.printResult({ data }, { text: (financialsData) => renderFundamentalsReport(financialsData, view) });
      return;
    }
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        providerId: financials.quote?.providerId,
        annualStatements: financials.annualStatements.length,
        quarterlyStatements: financials.quarterlyStatements.length,
        fundamentals: financials.fundamentals,
        profile: financials.profile,
      },
    }, {
      heading: listingHeading(identity),
      rows: financialStatementRows,
      columns: [
        { key: "date", header: "Date" },
        { key: "revenue", header: "Revenue", align: "right", value: (row) => row.revenue == null ? "" : formatCompact(Number(row.revenue)) },
        { key: "grossProfit", header: "Gross", align: "right", value: (row) => row.grossProfit == null ? "" : formatCompact(Number(row.grossProfit)) },
        { key: "operatingIncome", header: "Op Inc", align: "right", value: (row) => row.operatingIncome == null ? "" : formatCompact(Number(row.operatingIncome)) },
        { key: "netIncome", header: "Net Inc", align: "right", value: (row) => row.netIncome == null ? "" : formatCompact(Number(row.netIncome)) },
        { key: "eps", header: "EPS", align: "right", format: (value) => value == null ? "" : formatPerShareNumber(Number(value)) },
        { key: "currency", header: "Cur" },
      ],
    });
  });
}

async function runNews(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const feed = parseNewsFeed(takeOption(args, "--feed"));
  const exchangeOption = takeOption(args, "--exchange");
  if (exchangeOption && !args[0]) ctx.fail("--exchange needs a symbol: gloomberb news <symbol> --exchange <code>");
  await withMarketData(ctx, async (market) => {
    const listing = args[0] ? await requireCliListing(args[0], exchangeOption, market, ctx) : null;
    const limit = ctx.cliOptions.limit ?? 20;
    const [articles, quote] = await Promise.all([
      market.dataProvider.getNews({
        feed: feed ?? (listing ? "ticker" : "latest"),
        // Still set for news plugins that read the deprecated scope.
        scope: listing ? "ticker" : "global",
        ticker: listing?.request.symbol,
        exchange: listing?.request.exchange || undefined,
        limit,
      }),
      listing ? loadListingQuote(market.dataProvider, listing) : null,
    ]);
    const identity = listing ? listingIdentity(listing, quote) : null;
    ctx.printResult({
      data: articles,
      metadata: { ticker: listing?.key ?? null, ...(identity ? listingMetadata(identity) : {}), feed: feed ?? null },
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
  const count = parsePositiveInt(takeOption(args, "--count"), ctx.cliOptions.limit ?? 15, "Count", ctx);
  const exchangeOption = takeOption(args, "--exchange");
  const raw = requireArg(args[0], "Usage: gloomberb filings <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const { symbol, exchange } = listing.request;
    // A listing outside the US sends its company to the lookup, which needs its quote first.
    const quotePromise = loadListingQuote(market.dataProvider, listing);
    const identity = nonUsSecListingVenue(symbol, exchange) ? listingIdentity(listing, await quotePromise) : null;
    try {
      const [filings, quote] = await Promise.all([
        market.dataProvider.getSecFilings(symbol, count, exchange, identity?.name ? { listingName: identity.name } : undefined),
        quotePromise,
      ]);
      const resolved = identity ?? listingIdentity(listing, quote);
      ctx.printResult({ data: filings, metadata: listingMetadata(resolved) }, {
        heading: listingHeading(resolved),
        rows: filingRows,
        columns: FILING_COLUMNS,
        empty: `No SEC filings found for ${listingTitle(resolved)}.`,
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

async function runHolders(
  rawArgs: string[],
  ctx: Parameters<CliCommandDef["execute"]>[1],
  commandName: string,
  ownerTypes?: Set<string>,
) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const raw = requireArg(args[0], `Usage: gloomberb ${commandName} <symbol>`, ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const [data, quote] = await Promise.all([
      market.dataProvider.getHolders(listing.request.symbol, listing.request.exchange),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    const rows = holderRows(data, ownerTypes);
    const limit = ctx.cliOptions.limit;
    const shown = limit == null ? rows.length : Math.min(limit, rows.length);
    const institutional = !ownerTypes?.has("insider");
    const total = institutional ? data.summary?.institutionsCount ?? null : null;
    const reportDate = sharedReportDate(rows);
    const valueBasis = rows.length > 0 ? holderValueBasis(reportDate) : null;
    const positionsBasis = rows.length > 0 ? nonUsHolderCaveat(identity.exchange || data.exchange, data.currency) : null;
    // The heading names the listing; its unit, date and how much of the list follows on the same line.
    const facts = holderListFacts({ currency: data.currency, asOf: data.asOf, shown, reported: rows.length, total });
    ctx.printResult({
      data,
      metadata: {
        ...listingMetadata(identity),
        summary: data.summary,
        currency: data.currency ?? null,
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
        {
          key: "value",
          header: moneyColumnHeader("Value", data.currency),
          align: "right",
          value: (row) => row.value == null ? "" : formatCompact(Number(row.value)),
        },
        { key: "percentHeld", header: "% Held", align: "right", format: formatFractionPercentCell },
      ],
      summary: (holderData: HolderData) => [
        [valueBasis ? `Value = ${valueBasis}.` : "", positionsBasis ?? ""].filter(Boolean).join(" "),
        commandName === "insider" && ownerTypes ? insiderSummary(holderData, ownerTypes) : "",
      ].filter(Boolean).join("\n"),
      empty: `No holders reported for ${listingTitle(identity)}.`,
    });
  });
}

async function runAnalyst(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchangeOption = takeOption(args, "--exchange");
  const raw = requireArg(args[0], "Usage: gloomberb analyst <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const [data, quote] = await Promise.all([
      market.dataProvider.getAnalystResearch(listing.request.symbol, listing.request.exchange),
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
  const raw = requireArg(args[0], "Usage: gloomberb events <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const [data, quote] = await Promise.all([
      market.dataProvider.getCorporateActions(listing.request.symbol, listing.request.exchange),
      loadListingQuote(market.dataProvider, listing),
    ]);
    const identity = listingIdentity(listing, quote);
    ctx.printResult({ data, metadata: listingMetadata(identity) }, {
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
  const expiration = takeOption(args, "--expiration");
  const exchangeOption = takeOption(args, "--exchange");
  const raw = requireArg(args[0], "Usage: gloomberb options <symbol> [--expiration <unix>]", ctx);
  await withMarketData(ctx, async (market) => {
    const listing = await requireCliListing(raw, exchangeOption, market, ctx);
    const { symbol, exchange } = listing.request;
    const expirationDate = expiration == null ? undefined : Number(expiration);
    const quotePromise = loadListingQuote(market.dataProvider, listing);
    const result = await market.dataProvider.getCachedQuery?.("getOptionsChain", [symbol, exchange, expirationDate, undefined])
      .load({ force: ctx.cliOptions.refresh });
    const chain = result?.value ?? await market.dataProvider.getOptionsChain(symbol, exchange, expirationDate, {
      cacheMode: ctx.cliOptions.refresh ? "refresh" : "default",
    });
    const identity = listingIdentity(listing, await quotePromise);
    // A failed refresh falls back to the stored chain, which can be days old.
    const refreshWarning = result?.refreshError == null ? null
      : `Options refresh failed; showing the chain stored ${new Date(result.fetchedAt).toISOString()}`
        + (chain.asOf ? ` (last trade ${chain.asOf})` : "");
    const sessionWarning = refreshWarning ? null : priorSessionChainWarning(chain, identity.exchange, Date.now());
    const warnings = refreshWarning ? [refreshWarning] : sessionWarning ? [sessionWarning] : undefined;
    ctx.printResult({ data: chain, metadata: { ...listingMetadata(identity), expirations: chain.expirationDates }, warnings }, {
      heading: listingHeading(identity),
      rows: optionRows,
      columns: [
        { key: "side", header: "Side" },
        { key: "contract", header: "Contract", shrink: false },
        { key: "expiration", header: "Expiry" },
        { key: "strike", header: "Strike", align: "right" },
        { key: "last", header: "Last", align: "right" },
        { key: "bid", header: "Bid", align: "right", format: (_value, row) => formatOptionQuoteCell(row, "bid") },
        { key: "ask", header: "Ask", align: "right", format: (_value, row) => formatOptionQuoteCell(row, "ask") },
        { key: "volume", header: "Vol", align: "right", format: formatCountCell },
        { key: "openInterest", header: "OI", align: "right", format: formatCountCell },
      ],
    });
  });
}

async function runFx(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const currency = requireArg(rawArgs[0]?.trim().toUpperCase(), "Usage: gloomberb fx <currency>", ctx);
  await withMarketData(ctx, async (market) => {
    const baseCurrency = market.config.baseCurrency.trim().toUpperCase();
    const load = (code: string) => market.dataProvider.getCachedQuery("getExchangeRate", [code])
      .load({ force: ctx.cliOptions.refresh }).catch(() => null);
    const legs = currency === baseCurrency ? [] : await Promise.all([load(currency), load(baseCurrency)]);
    const [from, base] = legs;
    const rate = currency === baseCurrency ? 1 : from && base ? from.value / base.value : Number.NaN;
    if (!Number.isFinite(rate) || rate <= 0) ctx.fail(`Exchange rate unavailable for ${currency}/${baseCurrency}`);
    // A cross rate is only as current as its older leg.
    const observed = legs.flatMap((leg) => leg?.asOf ?? []);
    const asOf = observed.length > 0 ? new Date(Math.min(...observed)).toISOString() : null;
    const stale = legs.some((leg) => leg != null && (leg.staleAt <= Date.now() || leg.refreshError != null));
    ctx.printResult({ data: [{ currency, baseCurrency, rate, asOf, stale }] }, {
      layout: "record",
      columns: [
        { key: "currency", header: "Currency" },
        { key: "baseCurrency", header: "Base" },
        { key: "rate", header: "Rate", align: "right" },
        ...(asOf || stale ? [{
          key: "asOf",
          header: "As Of",
          format: (value: unknown, row: { stale: boolean }) => {
            const time = typeof value === "string" ? formatUtcTime(value) : "";
            return row.stale ? cliStyles.warning(`${time} stale`.trim()) : time;
          },
        }] : []),
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
    const events = await services.dataProvider.getEarningsCalendar(listings.map((listing) => listing.key));
    ctx.printResult({ data: events }, {
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

export const marketDataCliCommands: CliCommandDef[] = [
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
      usage: ["history <symbol> [--range <range>]"],
      options: [
        { flags: "--range <range>", description: `${TIME_RANGES.join(", ")} (default 1Y)` },
        EXCHANGE_OPTION,
      ],
      examples: ["history AAPL", "history BHP:ASX --range 5Y", "history AAPL --range 5Y --csv > aapl.csv"],
    },
    execute: runHistory,
  },
  {
    name: "options",
    description: "Fetch an options chain",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["options <symbol> [--expiration <unix>]"],
      options: [
        { flags: "--expiration <unix>", description: "Expiration as Unix seconds; defaults to the nearest one" },
        EXCHANGE_OPTION,
      ],
      examples: ["options AAPL", "options AAPL:NASDAQ --json"],
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
      options: [EXCHANGE_OPTION],
      examples: ["financials MSFT", "financials SAN:EPA", "financials MSFT --json"],
    },
    execute: (args, ctx) => runFinancials(args, ctx, "statements"),
  },
  {
    name: "fundamentals",
    description: "Fetch fundamentals and the company profile",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["fundamentals <symbol>"],
      options: [EXCHANGE_OPTION],
      examples: ["fundamentals NVDA", "fundamentals ASML:AMS"],
    },
    execute: (args, ctx) => runFinancials(args, ctx, "fundamentals"),
  },
  {
    name: "valuation",
    description: "Fetch market cap, enterprise value, and valuation multiples",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["valuation <symbol>"],
      options: [EXCHANGE_OPTION],
      examples: ["valuation NVDA", "valuation BP:LSE"],
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
    description: "Fetch institutional, fund, and insider holders",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["holders <symbol>"],
      options: [EXCHANGE_OPTION],
      examples: ["holders AAPL", "holders SAN:EPA"],
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
      usage: ["filings <symbol> [--count <n>]"],
      options: [
        { flags: "--count <n>", description: "Number of filings (default 15)" },
        EXCHANGE_OPTION,
      ],
      examples: ["filings AAPL", "filings BHP:ASX", "filings AAPL --count 40 --json"],
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
    description: "Convert a currency into your base currency",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["fx <currency>"],
      examples: ["fx EUR", "fx JPY --json"],
    },
    execute: runFx,
  },
];
