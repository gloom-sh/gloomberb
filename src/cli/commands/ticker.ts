import { logFailure } from "../../utils/log-failure";
import { formatShortDate, parseDisplayDate } from "../../utils/datetime-format";
import { formatReportedMoney } from "../../utils/reported-money";
import { convertedPriceEarningsNote, enterpriseValueLabel, enterpriseValueReconciliationNote, epsConversionNote, fundamentalsCurrency, reportedEnterpriseValue, ttmConversionNote } from "../../utils/fundamentals";
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import { exportedFundamentals, formatPriceEarnings, priceEarningsOnEarnings } from "../../utils/price-earnings";
import { describeFundamentalMarketCap, marketCapShareBasisNote, selectMarketCapitalization } from "../../utils/market-capitalization";
import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "../../utils/format";
import { formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity, formatMarketChangeWithCurrency, quoteFormatOptions, withCurrencyMinorDigits, type MarketFormatOptions } from "../../market-data/market/format";
import {
  cliStyles,
  cliTerminalWidth,
  colorBySign,
  renderSection,
  renderStats,
  wrapText,
  type CliStatEntry,
} from "../../utils/cli-output";
import {
  EXTENDED_SESSION_LABELS,
  exchangeShortName,
  getExtendedSessionDisplay,
  getQuoteSessionFields,
  getRegularSessionDisplay,
  quoteHeadlineTime,
  quoteMarketStateLabel,
} from "../../market-data/market/status";
import type { FuturesContractTermsPayload } from "../../api-client/futures-curve";
import { futuresContractLines, futuresSettleText, isFuturesInstrument, loadFuturesContractTerms } from "../../market-data/futures-contract";
import type { AppConfig } from "../../types/config";
import type { DeclaredDividendAction, FinancialStatement, Quote, TickerFinancials } from "../../types/financials";
import { quoteTradingDay } from "../../market-data/quotes/day-range";
import { atRegularSessionPrice, regularSessionValuationPrice } from "../../market-data/quotes/regular-session-valuation";
import { computeTickerPriceReturns } from "../../market-data/ticker-price-returns";
import { instrumentTypeLabel, resolveTickerInstrumentKind } from "../../tickers/instrument-kind";
import { INDEX_POINTS_LABEL, isIndexLevel, reportedQuoteVolume } from "../../market-data/market/index-level";
import type { SecFilingItem } from "../../types/data-provider";
import type { NewsArticle } from "../../news/types";
import type { TickerRecord } from "../../types/ticker";
import type { CliCommandContext } from "../../types/plugin";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl } from "../../portfolio/position-metrics";
import { createBaseConverter } from "../base-converter";
import { initMarketData, withMarketData } from "../context";
import { fail } from "../errors";
import type { MarketContext } from "../types";
import {
  formatBidAsk,
  formatFractionPercentCell,
  formatPriceRange,
  formatPortfolioNames,
  formatSignedCurrency,
  formatTimestamp,
  formatWatchlistNames,
} from "../helpers";
import { NotesFiles } from "../../plugins/builtin/notes/files";
import { isKnownNonUsListing } from "../../utils/sec";
import { canonicalExchange, exchangeLabel, isKnownExchangeCode, isUsListingExchange } from "../../utils/exchanges";
import {
  failIfNotTraded, failMovedSymbol, ListingArgError, listingChoiceNotes, listingFateLoader, listingIdentity, loadBareVenues,
  resolveCliListing, type CliListing, type ListingDataRequest,
} from "../listing-arg";
import { movedAwayChange } from "../../tickers/ticker-changes";
import { isNotATickerMessage } from "../not-a-ticker";
import { sharesOutstandingInReceipts } from "../../utils/depositary-receipt";
import { cliFreshnessFooter } from "../result";
import { providerMissReason } from "../../sources/provider-errors";
import { exportEntriesTable, reportFooterLines, type CliReportTables } from "../report-tables";
import type { ReportFreshness } from "../pane-functions/freshness";
import { fundamentalsFreshness, quotesFreshness } from "../freshness";
import { distributionHistory, forwardDividendBasis, forwardDividendMayHaveLapsed, lapsedDividend, noCurrentDividend, TRAILING_DIVIDEND_BASIS, type DistributionHistory, type DividendLapse } from "../../utils/forward-dividend";
import { declaredDividends } from "../../utils/declared-dividends";
import { notTheCoinNote } from "./crypto-hints";
import { loadStatementFilings, resultsReleaseText, statementPeriodText, type StatementFilingsReport } from "../statement-filings";
import type { BankFiguresPayload } from "../../api-client/bank-figures";
import { bankSection } from "../bank-section";

const NEWS_ITEM_LIMIT = 5;
const SEC_FILING_LIMIT = 5;
// Prose such as a company description stays readable on wide terminals.
const MAX_PROSE_WIDTH = 100;
const METADATA_SEPARATOR = "  ·  ";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** The states the header reads as CLOSED: the venue is between sessions, so nobody is quoting. */
const CLOSED_MARKET_STATES = new Set<string>(["CLOSED", "PREPRE", "POSTPOST"]);

interface TickerCommandDependencies {
  /** `--exchange`: the listing, for a symbol that trades in several places. */
  exchange?: string;
  initMarketData?: () => Promise<MarketContext>;
  fail?: (message: string, details?: string) => never;
  printResult?: CliCommandContext["printResult"];
  /** A futures symbol's contract terms and settlement; a failure leaves them out of the report. */
  futuresContract?: (symbol: string) => Promise<FuturesContractTermsPayload | null>;
}

/**
 * A futures symbol's contract terms and latest confirmed settlement. Any other
 * symbol is not looked up, and a failed request leaves both out of the report.
 */
export async function cliFuturesContract(
  symbol: string,
  instrumentType: string | undefined,
  load: (symbol: string) => Promise<FuturesContractTermsPayload | null> = loadFuturesContractTerms,
): Promise<FuturesContractTermsPayload | null> {
  return isFuturesInstrument(symbol, instrumentType) ? load(symbol).catch(logFailure("cli.commands-ticker", "Read futures contract details failed", null)) : null;
}

/** The Contract block as `ticker` and `quote` print it; a contract past first notice is in the warning colour. */
export function futuresContractMetrics(terms: FuturesContractTermsPayload, symbol: string): Array<[string, string]> {
  return futuresContractLines(terms, symbol).map((line) => [line.label, line.warning ? cliStyles.warning(line.value) : line.value]);
}

function appendMetricSection(lines: string[], title: string, metrics: Array<[string, string]>) {
  const populated = metrics.filter(([, value]) => value !== "—");
  if (populated.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(renderSection(title));
  lines.push(renderStats(populated));
}

/**
 * A closed market's bid and ask are the last quote of its session, not an open book (ITA's $202.00 against
 * $208.74 around a $206.65 close): say so, with the day the quote is from.
 */
function bidAskText(quote: Quote, options: MarketFormatOptions): string {
  const text = formatBidAsk(quote.bid, quote.ask, quote.bidSize, quote.askSize, quote.currency, options);
  if (text === "—" || !quote.marketState || !CLOSED_MARKET_STATES.has(quote.marketState)) return text;
  const day = quoteTradingDay(quote);
  const date = day ? new Date(`${day}T00:00:00Z`) : null;
  const label = date && Number.isFinite(date.getTime())
    ? `, ${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}` : "";
  return `${text}  ${cliStyles.muted(`(last quote${label})`)}`;
}

function wrapProse(text: string): string {
  return wrapText(text, Math.min(cliTerminalWidth() ?? MAX_PROSE_WIDTH, MAX_PROSE_WIDTH)).join("\n");
}

function buildStatementMetrics(statement: FinancialStatement, currency?: string): Array<[string, string]> {
  const money = (value: number | undefined, perShare = false) => formatReportedMoney(value, currency, perShare);
  return [
    ["Revenue", money(statement.totalRevenue)],
    ["Gross Profit", money(statement.grossProfit)],
    ["Operating Income", money(statement.operatingIncome)],
    ["Net Income", money(statement.netIncome)],
    ["Income incl. NCI", money(statement.netIncomeIncludingNoncontrollingInterests)],
    ["Income Common", money(statement.netIncomeCommonStockholders)],
    ["EBITDA", money(statement.ebitda)],
    ["Operating Cash Flow", money(statement.operatingCashFlow)],
    ["Free Cash Flow", money(statement.freeCashFlow)],
    ["Cash", money(statement.cashAndCashEquivalents)],
    ["Total Assets", money(statement.totalAssets)],
    ["Total Liabilities", money(statement.totalLiabilities)],
    ["Total Debt", money(statement.totalDebt)],
    ["Equity", money(statement.totalEquity)],
    ["Diluted EPS", money(statement.eps, true)],
    // Labelled only when the service says the row counts receipts.
    ["Diluted Shares", statement.dilutedShares != null && statement.shareBasis === "depositary_receipt"
      ? `${formatCompact(statement.dilutedShares)} (ADR equivalent)`
      : formatCompact(statement.dilutedShares)],
  ];
}

/**
 * A receipt's count is its ordinary shares expressed in receipts, as its
 * market cap is; the ordinary count follows when the service gives it.
 */
function sharesOutstandingText(fundamentals: TickerFinancials["fundamentals"], inReceipts: boolean): string {
  const shares = fundamentals?.sharesOutstanding;
  if (shares == null || !inReceipts) return formatCompact(shares);
  const ordinary = fundamentals?.shareBasis === "depositary_receipt" ? fundamentals.underlyingOrdinaryShares : undefined;
  return ordinary != null && Number.isFinite(ordinary) && ordinary > 0
    ? `${formatCompact(shares)} (ADR equivalent = ${formatCompact(ordinary)} ordinary shares)`
    : `${formatCompact(shares)} (ADR equivalent)`;
}

/** Provider prose is wrapped; `verbatim` keeps the user's own spacing, such as a table in a note. */
function appendTextSection(lines: string[], title: string, content: string | undefined, verbatim = false) {
  const text = content?.trim();
  if (!text) return;
  lines.push("");
  lines.push(renderSection(title));
  lines.push(verbatim ? text : wrapProse(text));
}

function appendFeedSection(
  lines: string[],
  title: string,
  entries: Array<{
    title: string;
    meta?: string[];
    body?: string;
    link?: string;
  }>,
) {
  const populated = entries.filter((entry) => entry.title.trim().length > 0);
  if (populated.length === 0) return;

  lines.push("");
  lines.push(renderSection(title));

  for (const [index, entry] of populated.entries()) {
    lines.push(cliStyles.bold(entry.title.trim()));
    const meta = (entry.meta ?? []).filter((value) => value.trim().length > 0);
    if (meta.length > 0) {
      lines.push(cliStyles.muted(meta.join(METADATA_SEPARATOR)));
    }
    if (entry.body?.trim()) {
      lines.push(wrapProse(entry.body.trim()));
    }
    if (entry.link?.trim()) {
      lines.push(cliStyles.muted(entry.link.trim()));
    }
    if (index < populated.length - 1) {
      lines.push("");
    }
  }
}

function normalizeComparable(value: string): string {
  return value.toUpperCase().replace(/\bFORM\b/g, "").replace(/[^A-Z0-9]+/g, "");
}

function getFilingDescription(filing: SecFilingItem): string | undefined {
  const description = filing.primaryDocDescription?.trim();
  if (!description) return undefined;
  if (normalizeComparable(description) === normalizeComparable(filing.form)) {
    return undefined;
  }
  return description;
}

/**
 * SEC filings are asked for unless the listing is known to be outside the US:
 * by the saved ticker, the requested venue, the quote, or the listing the
 * source still describes when it has no current quote. A symbol nothing is
 * known about yet is looked up as a US ticker.
 */
function shouldFetchSecFilings(
  symbol: string,
  exchange: string,
  tickerFile: TickerRecord | null,
  financials: TickerFinancials,
): boolean {
  const saved = tickerFile?.metadata;
  const { quote, quoteMetadata } = financials;
  return !isKnownNonUsListing({
    metadata: {
      ticker: saved?.ticker ?? symbol,
      exchange: saved?.exchange || exchange || quote?.listingExchangeName || quote?.exchangeName
        || quoteMetadata?.listingExchangeName || "",
      currency: saved?.currency || quote?.currency || quoteMetadata?.currency || "",
      name: saved?.name ?? symbol,
      broker_contracts: saved?.broker_contracts,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  });
}

async function appendTickerPositions(lines: string[], tickerFile: TickerRecord | null, quote: TickerFinancials["quote"],
  config: AppConfig, toBase: (value: number, currency: string) => Promise<number>): Promise<void> {
  const quoteCurrency = quote?.currency?.trim() || tickerFile?.metadata.currency?.trim() || "";
  if (tickerFile && tickerFile.metadata.positions.length > 0) {
    lines.push("");
    lines.push(renderSection("Positions"));
    const positions = tickerFile.metadata.positions.filter((position) => position.shares !== 0);

    for (const [index, position] of positions.entries()) {
      const portfolioName = config.portfolios.find((portfolio) => portfolio.id === position.portfolio)?.name ?? position.portfolio;
      const multiplier = position.multiplier ?? 1;
      const metrics = getPortfolioPositionMetrics({ ...tickerFile, metadata: { ...tickerFile.metadata, positions: [position] } }, undefined, quoteCurrency, undefined, quote);
      const positionCurrency = metrics.positionCurrency;
      const currentPrice = getPortfolioQuoteDisplay(metrics, quote)?.price ?? null;
      const currentPriceBase = currentPrice != null && quoteCurrency ? await toBase(currentPrice, quoteCurrency) : null;
      const costBasisBase = positionCurrency ? await toBase(metrics.signedCost, positionCurrency) : Number.NaN;
      const positionRate = positionCurrency ? await toBase(1, positionCurrency) : Number.NaN;
      const baseMetrics = getPortfolioPositionMetrics({ ...tickerFile, metadata: { ...tickerFile.metadata, positions: [position] } }, undefined, quoteCurrency,
        { currency: config.baseCurrency, convert: value => value * positionRate }, quote);
      const marketValueBase = resolvePortfolioMarketValue(baseMetrics, currentPriceBase)?.net ?? Number.NaN;
      const selectedPnl = resolvePortfolioPositionPnl(baseMetrics, currentPriceBase);
      const pnl = selectedPnl.value;

      lines.push(cliStyles.bold(`${portfolioName} (${position.broker})`));
      if (!positionCurrency) lines.push(cliStyles.muted("Currency unavailable."));
      const stats: CliStatEntry[] = [
        [
          "Position",
          `${formatMarketQuantity(metrics.totalShares, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency })} ${metrics.priceBasis === "percent-of-par" ? "@" : `${tickerFile.metadata.assetCategory === "BOND" ? "units" : multiplier > 1 ? "contracts" : "shares"} @`} ${positionCurrency ? formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis }) : "—"}`,
        ],
        ["Cost Basis", formatCurrency(costBasisBase, config.baseCurrency)],
        ["Market Value", formatCurrency(marketValueBase, config.baseCurrency)],
        [
          selectedPnl.basis === "broker-snapshot" ? "Broker P&L" : "P&L",
          pnl === null ? "—" : colorBySign(formatSignedCurrency(pnl, config.baseCurrency), pnl),
        ],
      ];
      if (position.markPrice != null) {
        stats.push(["Broker Mark", positionCurrency ? formatMarketPriceWithCurrency(position.markPrice, positionCurrency, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis }) : "—"]);
      }
      lines.push(renderStats(stats));
      if (index < positions.length - 1) {
        lines.push("");
      }
    }
  }
}

/** A source's enterprise value is in the units of the capitalization it reports beside it,
 * which without a declared unit is the listing's quote currency (as the overview labels it). */
function enterpriseValueCurrency(
  quote: TickerFinancials["quote"],
  fundamentals: TickerFinancials["fundamentals"],
): string | undefined {
  return fundamentals?.marketCapCurrency?.trim()
    || selectMarketCapitalization(quote, fundamentals)?.currency
    || quote?.currency?.trim()
    || undefined;
}

/** A fundamentals line: the text the report prints, and for CSV the figure behind it in `unit`. */
interface FundamentalsMetric {
  label: string;
  text: string;
  value?: number | string | null;
  unit?: string;
  /** A figure the text prints inside another line, which CSV gives a row of its own. */
  exportOnly?: boolean;
}

type MetricFigure = Omit<FundamentalsMetric, "label">;

/** An amount in the currency the source reported it in; `ccy?` when it named none, as the text says. */
function reportedMoney(value: number | undefined, currency: string | undefined, perShare = false): MetricFigure {
  return { text: formatReportedMoney(value, currency, perShare), value, unit: currency?.trim() || "ccy?" };
}

/** The EV line: labelled "(provider)" when it is more than 5% from market cap + debt - cash, "unavailable" when withdrawn. */
function enterpriseValueFigure(figure: MetricFigure, fundamentals: TickerFinancials["fundamentals"]): MetricFigure {
  const label = enterpriseValueLabel(fundamentals);
  if (label === "unavailable") return { text: "unavailable", value: null, unit: figure.unit };
  return label === "provider" && figure.text !== "—" ? { ...figure, text: `${figure.text} (provider)` } : figure;
}

function percentFigure(fraction: number | null | undefined, format: (value: number) => string): MetricFigure {
  return fraction != null ? { text: format(fraction), value: fraction * 100, unit: "%" } : { text: "—" };
}

/**
 * The listing's distributions a forward yield is read with: the declared,
 * unpaid ones a yield dated ahead is named from, in their own currency, and
 * the history that says whether the dividend is still paid.
 */
export interface ForwardYieldDistributions {
  rows: DeclaredDividendAction[];
  currency?: string;
  history: DistributionHistory | null;
}

/**
 * The listing's distributions, read only for a forward yield whose ex-date is
 * still ahead (the one case its basis names a declared one, which JSON does
 * not print, so `declared: false` skips it) or long enough past for its
 * dividend to have stopped; null otherwise, and when they cannot be read,
 * which leaves the basis to its dates and the lapse to Gloom Cloud's fifteen
 * months.
 */
export async function loadForwardYieldDistributions(
  dataProvider: Pick<MarketContext["dataProvider"], "getCorporateActions">,
  listing: { symbol: string; exchange: string },
  fundamentals: TickerFinancials["fundamentals"],
  { declared = true, now = new Date() }: { declared?: boolean; now?: Date } = {},
): Promise<ForwardYieldDistributions | null> {
  if (fundamentals?.dividendYieldBasis !== "forward" || fundamentals.dividendYield == null || !dataProvider.getCorporateActions) return null;
  const exDate = fundamentals.exDividendDate ?? "";
  const declaredAhead = declared && /^\d{4}-\d{2}-\d{2}$/.test(exDate) && exDate > now.toISOString().slice(0, 10);
  if (!declaredAhead && !forwardDividendMayHaveLapsed(exDate, now)) return null;
  try {
    const actions = await dataProvider.getCorporateActions(listing.symbol, listing.exchange);
    return { rows: declaredDividends(actions, now), ...(actions.currency ? { currency: actions.currency } : {}),
      history: distributionHistory(actions, now) };
  } catch (error) {
    logFailure("cli.commands-ticker", "Read forward dividend distributions failed")(error);
    return null;
  }
}

/** The stopped dividend behind a forward yield, if it has stopped (lapsedDividend); null for any other yield. */
function forwardYieldLapse(
  fundamentals: TickerFinancials["fundamentals"],
  distributions: ForwardYieldDistributions | null,
  now = new Date(),
): DividendLapse | null {
  return fundamentals?.dividendYieldBasis === "forward" && fundamentals.dividendYield != null
    ? lapsedDividend(fundamentals.exDividendDate, distributions?.history, now) : null;
}

/**
 * A dividend yield says its basis in the words DVD uses: a forward yield what
 * it annualizes and when (a declared distribution by its ex-date and stated
 * amount), and once its dividend has stopped, that there is none and when it
 * was last paid; a trailing one the twelve months it covers. A yield of no
 * stated basis is the figure alone.
 */
function forwardYieldFigure(fundamentals: TickerFinancials["fundamentals"], distributions: ForwardYieldDistributions | null): MetricFigure {
  const lapse = forwardYieldLapse(fundamentals, distributions);
  if (lapse) return { text: noCurrentDividend(lapse), value: null };
  const figure = percentFigure(fundamentals?.dividendYield, formatFractionPercentCell);
  if (fundamentals?.dividendYield == null) return figure;
  const basis = fundamentals.dividendYieldBasis === "forward"
    ? forwardDividendBasis(fundamentals.exDividendDate, { declared: distributions?.rows, currency: distributions?.currency })
    : fundamentals.dividendYieldBasis === "trailing" ? TRAILING_DIVIDEND_BASIS : null;
  return basis ? { ...figure, text: `${figure.text} (${basis})` } : figure;
}

/**
 * Fundamentals as JSON exports them: a forward yield whose dividend has
 * stopped is null, as is its rate, with the last ex-date under `dividendLapse`.
 */
export function exportedDividendFundamentals<T extends object & Pick<NonNullable<TickerFinancials["fundamentals"]>, "dividendYield" | "dividendYieldBasis" | "exDividendDate">>(
  fundamentals: T,
  distributions: ForwardYieldDistributions | null,
): T | (Omit<T, "dividendYield" | "dividendRate"> & { dividendYield: null; dividendRate: null; dividendLapse: DividendLapse }) {
  const lapse = forwardYieldLapse(fundamentals, distributions);
  return lapse ? { ...fundamentals, dividendYield: null, dividendRate: null, dividendLapse: lapse } : fundamentals;
}

function multipleFigure(value: ReturnType<typeof priceEarningsOnEarnings> | number | undefined): MetricFigure {
  const text = formatPriceEarnings(value, 2);
  return { text, value: typeof value === "number" && Number.isFinite(value) && value > 0 ? value : text === "N/M" ? text : null };
}

function fundamentalsMetrics(
  quote: TickerFinancials["quote"],
  fundamentals: TickerFinancials["fundamentals"],
  profile: TickerFinancials["profile"],
  marketCap: MetricFigure,
  priceReturns: { return1Y?: number | null; return3Y?: number | null },
  reportingCurrency: string | undefined,
  enterpriseValue = reportedMoney(reportedEnterpriseValue(fundamentals), enterpriseValueCurrency(quote, fundamentals)),
  distributions: ForwardYieldDistributions | null = null,
): FundamentalsMetric[] {
  const signed = (value: number) => colorBySign(formatPercent(value), value);
  const receipt = fundamentals?.sharesOutstanding != null && sharesOutstandingInReceipts(quote, fundamentals, profile?.description);
  return [
    { label: "Market Cap", ...marketCap },
    { label: "Enterprise Value", ...enterpriseValueFigure(enterpriseValue, fundamentals) },
    // A multiple over a loss is N/M, even beside a positive one the source served from an older period.
    { label: "P/E (TTM)", ...multipleFigure(priceEarningsOnEarnings(fundamentals?.trailingPE, fundamentals?.eps)) },
    { label: "Forward P/E", ...multipleFigure(priceEarningsOnEarnings(fundamentals?.forwardPE, fundamentals?.forwardEps)) },
    { label: "PEG", ...multipleFigure(fundamentals?.pegRatio) },
    // The flows and EPS are one trailing-twelve-month block, the same twelve months for each line.
    { label: "EPS (TTM)", ...reportedMoney(fundamentals?.eps, fundamentals?.epsCurrency?.trim() || reportingCurrency, true) },
    {
      label: `Dividend Yield${fundamentals?.dividendYieldBasis ? ` (${fundamentals.dividendYieldBasis})` : ""}`,
      ...forwardYieldFigure(fundamentals, distributions),
    },
    { label: "Revenue (TTM)", ...reportedMoney(fundamentals?.revenue, reportingCurrency) },
    { label: "Net Income (TTM)", ...reportedMoney(fundamentals?.netIncome, reportingCurrency) },
    { label: "Operating Cash Flow (TTM)", ...reportedMoney(fundamentals?.operatingCashFlow, reportingCurrency) },
    { label: "Free Cash Flow (TTM)", ...reportedMoney(fundamentals?.freeCashFlow, reportingCurrency) },
    // Levels, not changes, so they carry no sign.
    { label: "Operating Margin", ...percentFigure(fundamentals?.operatingMargin, formatFractionPercentCell) },
    { label: "Profit Margin", ...percentFigure(fundamentals?.profitMargin, formatFractionPercentCell) },
    { label: "Revenue Growth", ...percentFigure(fundamentals?.revenueGrowth, signed) },
    { label: "Last Quarter Growth", ...percentFigure(fundamentals?.lastQuarterGrowth, signed) },
    { label: "1Y Return", ...percentFigure(priceReturns.return1Y, signed) },
    { label: "3Y Return", ...percentFigure(priceReturns.return3Y, signed) },
    {
      label: "Shares Outstanding",
      text: sharesOutstandingText(fundamentals, receipt),
      value: fundamentals?.sharesOutstanding,
      ...(receipt ? { unit: "ADR equivalent" } : {}),
    },
  ];
}

/**
 * The float and the short interest `fundamentals` prints after the share count: the shares short, short % of float
 * and days to cover of one settlement, dated, as the JSON gives them and `SI` and `SIW` show them.
 */
function floatAndShortInterestMetrics(
  quote: TickerFinancials["quote"],
  fundamentals: TickerFinancials["fundamentals"],
  profile: TickerFinancials["profile"],
): FundamentalsMetric[] {
  const finite = (value: number | undefined): value is number => value != null && Number.isFinite(value);
  const float = fundamentals?.floatShares;
  const short = fundamentals?.sharesShort;
  const days = fundamentals?.shortRatio;
  const date = fundamentals?.shortInterestDate;
  const receipt = finite(float) && sharesOutstandingInReceipts(quote, fundamentals, profile?.description);
  return [
    finite(float) && float > 0
      ? { label: "Float", text: formatCompact(float), value: float, ...(receipt ? { unit: "ADR equivalent" } : {}) }
      : { label: "Float", text: "—" },
    finite(short)
      ? { label: "Short Interest", text: `${formatCompact(short)}${date ? ` (settled ${date})` : ""}`, value: short, unit: "shares" }
      : { label: "Short Interest", text: "—" },
    ...finite(short) && date ? [{ label: "Short Interest Settlement", text: date, value: date, exportOnly: true }] : [],
    { label: "Short % of Float", ...percentFigure(fundamentals?.shortPercentOfFloat, formatFractionPercentCell) },
    finite(days) ? { label: "Days to Cover", text: formatNumber(days, 2), value: days } : { label: "Days to Cover", text: "—" },
  ];
}

function metricLines(metrics: readonly FundamentalsMetric[]): Array<[string, string]> {
  return metrics.filter((metric) => !metric.exportOnly).map((metric) => [metric.label, metric.text]);
}

const TRAILING_MONEY_METRICS = new Set(["EPS (TTM)", "Revenue (TTM)", "Net Income (TTM)", "Operating Cash Flow (TTM)", "Free Cash Flow (TTM)"]);

/**
 * The notes under shown fundamentals: a market cap that does not rest on the share count shown, how a labelled or
 * withdrawn EV compares with market cap + debt - cash, what a converted TTM block was converted from, an EPS in
 * another currency than the amounts beside it, and what a P/E on such an EPS divides. `priced` is the snapshot at
 * the regular session price (atRegularSessionPrice), the figures the lines show, so each note reads those.
 */
function fundamentalsNotes(
  priced: Pick<TickerFinancials, "quote" | "fundamentals">,
  metrics: readonly FundamentalsMetric[],
  quoteCurrency: string | undefined,
): string[] {
  const fundamentals = priced.fundamentals;
  const shown = (label: string) => metrics.some((metric) => metric.label === label && metric.text !== "—");
  const shareBasis = shown("Market Cap") && shown("Shares Outstanding")
    ? marketCapShareBasisNote(selectMarketCapitalization(priced.quote, fundamentals), fundamentals?.sharesOutstanding,
      regularSessionValuationPrice(priced.quote), priced.quote?.currency)
    : undefined;
  const conversion = [...TRAILING_MONEY_METRICS].some(shown) ? ttmConversionNote(fundamentals) : undefined;
  const eps = shown("EPS (TTM)") ? epsConversionNote(fundamentals) : undefined;
  const priceEarnings = metrics.some((metric) => metric.label === "P/E (TTM)" && typeof metric.value === "number")
    ? convertedPriceEarningsNote(fundamentals, quoteCurrency)
    : undefined;
  const enterpriseValue = shown("Enterprise Value") ? enterpriseValueReconciliationNote(fundamentals) : undefined;
  return [shareBasis, enterpriseValue, conversion, eps, priceEarnings].filter((note): note is string => !!note);
}

// The share count is the market cap's basis: the cap is the count times the price, or a note says why not.
const VALUATION_METRICS = new Set(["Market Cap", "Shares Outstanding", "Enterprise Value", "P/E (TTM)", "Forward P/E", "PEG", "EPS (TTM)"]);

type FundamentalsReportData = TickerFinancials & {
  symbol: string;
  exchange?: string;
  distributions?: ForwardYieldDistributions | null;
  /** The filings behind the latest statements, and a newer quarter's results release. */
  statementFilings?: StatementFilingsReport | null;
  /** A bank holding company's deposits, uninsured share and CRE (`fundamentals` only). */
  bank?: BankFiguresPayload | null;
  /** In place of `bank`, for a bank whose figures could not be read. */
  bankNote?: string | null;
};

/** "Latest quarter 2026-06-30, 10-Q filed 2026-08-06." and the newer quarter's results release, for the lines under a report's figures. */
function statementFilingsNotes(report: StatementFilingsReport | null | undefined): string[] {
  if (!report) return [];
  const latest = report.latestQuarter ?? report.latestAnnual;
  return [
    ...latest ? [`Latest ${report.latestQuarter ? "quarter" : "annual period"} ${statementPeriodText(latest.date, latest)}.`] : [],
    ...report.resultsRelease ? [resultsReleaseText(report.resultsRelease)] : [],
  ];
}

/**
 * Where a fund's facts are: for a US listing, the ETF function (fee, NAV,
 * premium, net assets); a fund listed elsewhere has none yet. Only for a
 * fund: a stock's report says nothing of it.
 */
function fundFactsNote(
  symbol: string,
  exchange: string | undefined,
  financials: Pick<TickerFinancials, "quote" | "quoteMetadata">,
  tickerFile: TickerRecord | null = null,
): string | null {
  if (resolveTickerInstrumentKind(tickerFile, financials) !== "fund") return null;
  return !exchange || isUsListingExchange(exchange)
    ? `Fund facts (fee, NAV, premium, net assets): fn ETF ${symbol}.`
    : "Fund facts (fee, NAV, premium) cover US-listed funds only.";
}

/**
 * The price a valuation is measured at, as `quote` and `ticker` read it: Last
 * and Change are the regular session (after the close, its close and that
 * close's move), and a pre-market, after-hours or overnight print is a line
 * of its own, measured from that close.
 */
function valuationPriceMetrics(financials: FundamentalsReportData): FundamentalsMetric[] {
  const quote = financials.quote;
  const session = getRegularSessionDisplay(quote);
  if (!quote || !session) return [];
  const options = withCurrencyMinorDigits(quoteFormatOptions(quote, undefined, financials.quoteMetadata?.instrumentType), quote.currency);
  const price = (value: number) => formatMarketPriceWithCurrency(value, quote.currency, options);
  const extended = getExtendedSessionDisplay(quote);
  const extendedLabel = extended ? EXTENDED_SESSION_LABELS[extended.session] : "";
  return [
    { label: "Last", text: price(session.price), value: session.price, unit: quote.currency },
    session.changePercent != null && Number.isFinite(session.changePercent)
      ? {
        label: "Change",
        text: colorBySign(`${formatMarketChangeWithCurrency(session.change, quote.currency, options, session.price)} (${formatPercentRaw(session.changePercent)})`, session.change),
        value: session.changePercent,
        unit: "%",
      }
      : { label: "Change", text: "—" },
    ...extended ? [
      {
        label: extendedLabel,
        // "mid" when the overnight price is the session's bid and ask midpoint, as `quote` marks it.
        text: colorBySign(`${price(extended.price)}${extended.mark ? " mid" : ""}${extended.changePercent != null ? ` (${formatPercentRaw(extended.changePercent)})` : ""}`, extended.change),
        value: extended.price,
        unit: quote.currency,
      },
      extended.changePercent != null
        ? { label: `${extendedLabel} Change`, text: formatPercentRaw(extended.changePercent), value: extended.changePercent, unit: "%", exportOnly: true }
        : { label: `${extendedLabel} Change`, text: "—" },
    ] : [],
  ];
}

/**
 * The lines `fundamentals` or `valuation` reports, the ones with a value.
 * Market cap, the P/E multiples and the dividend yield are measured at the
 * regular session price (atRegularSessionPrice), which `valuation` names in
 * its first lines.
 */
function fundamentalsReportMetrics(snapshot: FundamentalsReportData, view: "fundamentals" | "valuation"): FundamentalsMetric[] {
  const financials = atRegularSessionPrice(snapshot);
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const capitalization = selectMarketCapitalization(quote, fundamentals);
  const marketCap: MetricFigure = capitalization
    ? { text: `${formatCompact(capitalization.value)} ${capitalization.currency}`, value: capitalization.value, unit: capitalization.currency }
    : { text: "—" };
  const metrics = fundamentalsMetrics(quote, fundamentals, financials.profile, marketCap, computeTickerPriceReturns(financials), fundamentalsCurrency(financials),
    undefined, snapshot.distributions ?? null);
  if (view === "fundamentals") {
    return [...metrics, ...floatAndShortInterestMetrics(quote, fundamentals, financials.profile)]
      .filter((metric) => metric.text !== "—");
  }
  const valued = metrics.filter(({ label, text }) => (VALUATION_METRICS.has(label) || label.startsWith("Dividend Yield")) && text !== "—");
  // The share count follows the market cap it is the basis of.
  const shares = valued.filter((metric) => metric.label === "Shares Outstanding");
  const valuation = valued.flatMap((metric) => metric.label === "Shares Outstanding" ? [] : metric.label === "Market Cap" ? [metric, ...shares] : [metric]);
  // A listing with no valuation (a fund) says so rather than printing its price alone.
  return valuation.length === 0 ? [] : [...valuationPriceMetrics(financials).filter((metric) => metric.text !== "—"), ...valuation];
}

/** Text for `gloomberb fundamentals` and `gloomberb valuation`: the ticker report's fundamentals without the rest. */
export function renderFundamentalsReport(
  financials: FundamentalsReportData,
  view: "fundamentals" | "valuation",
): string {
  const quote = financials.quote;
  const profile = financials.profile;
  const symbol = quote?.symbol ?? financials.symbol;
  const name = quote?.name && quote.name !== symbol ? ` ${cliStyles.bold(quote.name)}` : "";
  const lines = [`${cliStyles.accent(symbol)}${name}`];
  const profileParts = [
    financials.exchange ? exchangeLabel(financials.exchange) : undefined,
    profile?.sector ? `Sector ${profile.sector}` : undefined,
    profile?.industry ? `Industry ${profile.industry}` : undefined,
  ].filter((part): part is string => !!part);
  if (profileParts.length > 0) lines.push(cliStyles.muted(profileParts.join(METADATA_SEPARATOR)));

  const before = lines.length;
  const metrics = fundamentalsReportMetrics(financials, view);
  appendMetricSection(lines, view === "valuation" ? "Valuation" : "Fundamentals", metricLines(metrics));
  const fund = fundFactsNote(symbol, financials.exchange || quote?.exchangeName, financials);
  if (lines.length === before) lines.push("", cliStyles.muted([`No ${view} reported for ${financials.symbol}.`, fund].filter(Boolean).join(" ")));
  else if (fund) lines.push(cliStyles.muted(fund));
  for (const note of fundamentalsNotes(atRegularSessionPrice(financials), metrics, quote?.currency)) lines.push(cliStyles.muted(note));
  if (view === "fundamentals") {
    for (const note of statementFilingsNotes(financials.statementFilings)) lines.push(cliStyles.muted(note));
    const bank = financials.bank ? bankSection(financials.bank, symbol, latestStatementDate(financials)) : null;
    if (bank) {
      appendMetricSection(lines, "Bank", bank.lines);
      for (const note of bank.notes) lines.push(cliStyles.muted(note));
    } else if (financials.bankNote) {
      lines.push("", renderSection("Bank"), cliStyles.muted(financials.bankNote));
    }
    appendTextSection(lines, "Description", profile?.description);
  }
  return lines.join("\n");
}

/** The newest statement period, YYYY-MM-DD. */
function latestStatementDate(financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">): string | null {
  return [...financials.quarterlyStatements, ...financials.annualStatements].map((row) => row.date).sort().at(-1) ?? null;
}

/**
 * `fundamentals` and `valuation` for `--csv` and `--ndjson`: the metrics as
 * `Metric,Value` with each unit in its label, and for `fundamentals` the
 * company profile the text prints around them.
 */
export function fundamentalsReportTables(
  financials: FundamentalsReportData,
  view: "fundamentals" | "valuation",
  freshness: ReportFreshness,
): CliReportTables {
  const metrics = fundamentalsReportMetrics(financials, view);
  const fund = fundFactsNote(financials.quote?.symbol ?? financials.symbol, financials.exchange || financials.quote?.exchangeName, financials);
  const tables = [exportEntriesTable(
    view === "valuation" ? "Valuation" : "Fundamentals",
    metrics.map((metric) => ({ label: metric.label, value: metric.value, formatted: metric.text, unit: metric.unit })),
  )];
  const bank = view === "fundamentals" && financials.bank
    ? bankSection(financials.bank, financials.quote?.symbol ?? financials.symbol, latestStatementDate(financials))
    : null;
  if (bank) tables.push(exportEntriesTable("Bank", bank.entries));
  if (view === "fundamentals") {
    const quote = financials.quote;
    const profile = financials.profile;
    tables.push(exportEntriesTable("Profile", [
      { label: "Symbol", value: quote?.symbol ?? financials.symbol },
      { label: "Name", value: quote?.name },
      { label: "Exchange", value: financials.exchange ? exchangeLabel(financials.exchange) : undefined },
      { label: "Sector", value: profile?.sector },
      { label: "Industry", value: profile?.industry },
      { label: "Description", value: profile?.description?.trim() },
    ].filter((entry) => typeof entry.value === "string" && entry.value.trim().length > 0)));
  }
  return {
    tables,
    footer: reportFooterLines({
      freshness,
      notes: [
        ...metrics.length === 0
          ? [`No ${view} reported for ${financials.symbol}.`]
          : fundamentalsNotes(atRegularSessionPrice(financials), metrics, financials.quote?.currency),
        ...fund ? [fund] : [],
        ...view === "fundamentals" ? statementFilingsNotes(financials.statementFilings) : [],
        ...bank?.notes ?? [],
        ...!bank && view === "fundamentals" && financials.bankNote ? [financials.bankNote] : [],
      ],
    }),
  };
}

/** "Euronext Paris (EPA)": the venue the report is for, named in full when the app knows it. */
function listingVenueLabel(
  listingExchange: string | undefined,
  quote: TickerFinancials["quote"],
  financials: TickerFinancials,
  tickerFile: TickerRecord | null,
): string {
  const exchangeName = quote?.exchangeName ?? financials.quoteMetadata?.listingExchangeName ?? tickerFile?.metadata.exchange;
  // A KOSDAQ code saved on KRX is reported from KOSDAQ, where its quote is read.
  const venue = canonicalExchange(quote?.tradingExchangeName || listingExchange || quote?.listingExchangeName || exchangeName);
  return isKnownExchangeCode(venue) ? exchangeLabel(venue) : exchangeShortName(exchangeName, quote?.fullExchangeName);
}

export async function buildTickerReport({
  symbol,
  listingExchange,
  tickerFile,
  financials,
  config,
  toBase,
  notes,
  quoteNote,
  listingNote,
  recentNews = [],
  recentSecFilings = [],
  futuresContract = null,
  distributions = null,
  statementFilings = null,
}: {
  symbol: string;
  /** The filings behind the latest statements, and a newer quarter's results release. */
  statementFilings?: StatementFilingsReport | null;
  /** The distributions a forward yield is read with (loadForwardYieldDistributions). */
  distributions?: ForwardYieldDistributions | null;
  /** The exchange the command named, as a canonical code. */
  listingExchange?: string;
  /** A futures symbol's contract terms and latest confirmed settlement. */
  futuresContract?: FuturesContractTermsPayload | null;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
  notes?: string;
  /** Why there is no quote, when a source said; "Quote unavailable." otherwise. */
  quoteNote?: string;
  /** "CAR = Avis Budget Group, NASDAQ (also XETRA, ASX)", for a bare symbol several companies list. */
  listingNote?: string;
  recentNews?: NewsArticle[];
  recentSecFilings?: SecFilingItem[];
}): Promise<string> {
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const priceReturns = computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory);
  const profile = financials.profile;
  const name = quote?.name || tickerFile?.metadata.name || symbol;
  const baseQuoteOptions = quoteFormatOptions(quote, tickerFile?.metadata.assetCategory, financials.quoteMetadata?.instrumentType);
  // Pad money prices to the currency's minor unit so a range reads £35.10 - £35.485, never past it (JPY has none).
  const quoteOptions = withCurrencyMinorDigits(baseQuoteOptions, quote?.currency);
  const lines: string[] = [];

  lines.push(`${cliStyles.accent(quote?.symbol ?? symbol)} ${cliStyles.bold(name)}`);
  if (!quote) lines.push(cliStyles.muted(quoteNote ?? QUOTE_UNAVAILABLE));

  const quoteCurrency = quote?.currency || financials.quoteMetadata?.currency || tickerFile?.metadata.currency;
  // An index's level is in points, as `history` heads its bars, not in the currency its members trade in.
  const indexLevel = isIndexLevel(quote?.instrumentType?.trim() || financials.quoteMetadata?.instrumentType?.trim() || tickerFile?.metadata.assetCategory);
  const summaryParts = [
    listingVenueLabel(listingExchange, quote, financials, tickerFile) || undefined,
    indexLevel ? INDEX_POINTS_LABEL : quoteCurrency ? `Currency ${quoteCurrency}` : undefined,
    quoteMarketStateLabel(quote) ?? undefined,
    quote?.dataSource ? `Source ${quote.dataSource.toUpperCase()}` : undefined,
  ].filter((part): part is string => !!part);
  if (summaryParts.length > 0) {
    lines.push(cliStyles.muted(summaryParts.join(METADATA_SEPARATOR)));
  }
  if (listingNote) lines.push(cliStyles.muted(listingNote));

  const instrumentType = instrumentTypeLabel(quote?.instrumentType?.trim()
    || financials.quoteMetadata?.instrumentType?.trim()
    || tickerFile?.metadata.assetCategory, name, { detail: true });
  const metadataParts = [
    instrumentType ? `Type ${instrumentType}` : undefined,
    (tickerFile?.metadata.sector || profile?.sector) ? `Sector ${tickerFile?.metadata.sector || profile?.sector}` : undefined,
    (tickerFile?.metadata.industry || profile?.industry) ? `Industry ${tickerFile?.metadata.industry || profile?.industry}` : undefined,
  ].filter((part): part is string => !!part);
  if (metadataParts.length > 0) {
    lines.push(cliStyles.muted(metadataParts.join(METADATA_SEPARATOR)));
  }

  const portfolioNames = tickerFile ? formatPortfolioNames(config, tickerFile.metadata.portfolios) : [];
  const watchlistNames = tickerFile ? formatWatchlistNames(config, tickerFile.metadata.watchlists) : [];
  const membershipParts = [
    portfolioNames.length > 0
      ? `Portfolios ${portfolioNames.join(", ")}`
      : undefined,
    watchlistNames.length > 0
      ? `Watchlists ${watchlistNames.join(", ")}`
      : undefined,
  ].filter((part): part is string => !!part);
  if (membershipParts.length > 0) {
    lines.push(cliStyles.muted(membershipParts.join(METADATA_SEPARATOR)));
  }

  // Market cap and the multiples are measured at the regular session price the Quote section heads with.
  const priced = atRegularSessionPrice(financials);
  const capitalization = selectMarketCapitalization(priced.quote, priced.fundamentals);
  const convertedMarketCap = capitalization ? await toBase(capitalization.value, capitalization.currency) : Number.NaN;
  const marketCapText = capitalization
    ? Number.isFinite(convertedMarketCap)
      ? `${formatCompact(convertedMarketCap)} ${config.baseCurrency}`
      : `${formatCompact(capitalization.value)} ${capitalization.currency}`
    : "—";
  // Shown in the same currency as the market cap, so the two can be compared.
  const enterpriseValue = reportedEnterpriseValue(priced.fundamentals);
  const evCurrency = enterpriseValueCurrency(quote, fundamentals);
  // A minor unit such as GBp stays as reported: the converter would read it as the major currency.
  const convertedEnterpriseValue = enterpriseValue != null && evCurrency && /^[A-Z]{3}$/.test(evCurrency)
    ? await toBase(enterpriseValue, evCurrency) : Number.NaN;
  const enterpriseValueText = Number.isFinite(convertedEnterpriseValue)
    ? `${formatCompact(convertedEnterpriseValue)} ${config.baseCurrency}`
    : formatReportedMoney(enterpriseValue, evCurrency);

  if (quote) {
    // As the Overview reads it: the regular session, then the extended-hours print against its close.
    const session = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote);
    const extendedRow = (kind: "PRE" | "POST") => extended?.session === kind
      ? colorBySign(
        `${formatMarketPriceWithCurrency(extended.price, quote.currency, quoteOptions)} (${formatPercentRaw(extended.changePercent)})`,
        extended.change,
      )
      : "—";
    const volume = reportedQuoteVolume(quote);
    // A futures price is its latest trade; the exchange settlement is its own row, dated by its session.
    appendMetricSection(lines, "Quote", [
      ["Last", colorBySign(formatMarketPriceWithCurrency(session.price, quote.currency, quoteOptions), session.change)],
      ...futuresContract
        ? [["Settle", futuresSettleText(futuresContract, quote)] as [string, string]]
        : [],
      ["Change", colorBySign(`${formatMarketChangeWithCurrency(session.change, quote.currency, quoteOptions, session.price)} (${formatPercentRaw(session.changePercent)})`, session.change)],
      ["Open", quote.open != null ? formatMarketPriceWithCurrency(quote.open, quote.currency, quoteOptions) : "—"],
      ["Day Range", quote.low != null || quote.high != null
        ? formatPriceRange(quote.low, quote.high, quote.currency, quoteOptions)
        : "—"],
      ["52W Range", quote.low52w != null || quote.high52w != null
        ? formatPriceRange(quote.low52w, quote.high52w, quote.currency, quoteOptions)
        : "—"],
      ["Bid / Ask", bidAskText(quote, quoteOptions)],
      // An index's and a perpetual's 0 means none is counted, not no trades: no Volume row.
      ["Volume", volume != null ? formatNumber(volume, 0) : "—"],
      ["Updated", formatTimestamp(quoteHeadlineTime(quote))],
    ]);

    if (futuresContract) appendMetricSection(lines, "Contract", futuresContractMetrics(futuresContract, quote.symbol ?? symbol));

    appendMetricSection(lines, "Extended Hours", [
      [EXTENDED_SESSION_LABELS.PRE, extendedRow("PRE")],
      [EXTENDED_SESSION_LABELS.POST, extendedRow("POST")],
    ]);
  }

  const metrics = fundamentalsMetrics(quote, priced.fundamentals, profile, { text: marketCapText }, priceReturns, fundamentalsCurrency(financials),
    { text: enterpriseValueText }, distributions);
  const beforeFundamentals = lines.length;
  appendMetricSection(lines, "Fundamentals", metricLines(metrics));
  for (const note of fundamentalsNotes(priced, metrics, quote?.currency)) lines.push(cliStyles.muted(note));
  // Where a fund's facts would go: under its fundamentals, or in their place.
  const fund = fundFactsNote(quote?.symbol ?? symbol,
    quote?.tradingExchangeName || listingExchange || quote?.listingExchangeName || quote?.exchangeName || tickerFile?.metadata.exchange, financials, tickerFile);
  if (fund) lines.push(...lines.length === beforeFundamentals ? [""] : [], cliStyles.muted(fund));

  if (capitalization?.provenance.kind === "fundamentals") {
    lines.push(cliStyles.muted(`Market cap: ${describeFundamentalMarketCap(capitalization.provenance)}.`));
  }

  const reportedCurrency = financials.financialCurrency?.trim();
  const statements = [...financials.annualStatements, ...financials.quarterlyStatements];
  const fallbackCurrency = reportedCurrency && statements.every((row) => !row.currency?.trim() || row.currency.trim() === reportedCurrency)
    ? reportedCurrency : undefined;
  const statementCurrency = (row: FinancialStatement) => row.currency?.trim() || fallbackCurrency;
  const latestAnnual = latestFinancialPeriod(financials.annualStatements, row => row.date);
  if (latestAnnual) {
    appendMetricSection(lines, `Latest Annual (${statementPeriodText(latestAnnual.date, statementFilings?.latestAnnual ?? null)})`,
      buildStatementMetrics(latestAnnual, statementCurrency(latestAnnual)));
  }

  const latestQuarter = latestFinancialPeriod(financials.quarterlyStatements, row => row.date);
  if (latestQuarter) {
    appendMetricSection(lines, `Latest Quarter (${statementPeriodText(latestQuarter.date, statementFilings?.latestQuarter ?? null)})`,
      buildStatementMetrics(latestQuarter, statementCurrency(latestQuarter)));
  }
  // The statements stop a quarter short of the results the company has released.
  if (statementFilings?.resultsRelease && (latestAnnual || latestQuarter)) lines.push(cliStyles.muted(resultsReleaseText(statementFilings.resultsRelease)));

  appendTextSection(lines, "Description", profile?.description);

  appendTextSection(lines, "Notes", notes, true);

  appendFeedSection(lines, "Recent News", recentNews.map((item) => ({
    title: item.title,
    meta: [
      item.source,
      (() => {
        const publishedAt = parseDisplayDate(item.publishedAt as Date | string | number | undefined);
        return publishedAt ? formatTimestamp(publishedAt.getTime()) : "";
      })(),
    ],
    body: item.summary,
    link: item.url,
  })));

  appendFeedSection(lines, "Recent SEC Filings", recentSecFilings.map((filing) => ({
    title: (() => {
      const filingDate = formatShortDate(filing.filingDate as Date | string | number | undefined, { fallback: "" });
      return filingDate ? `Form ${filing.form}${METADATA_SEPARATOR}${filingDate}` : `Form ${filing.form}`;
    })(),
    meta: [
      filing.items ? `Items ${filing.items}` : "",
      getFilingDescription(filing) ?? "",
      filing.primaryDocument ? `Primary Document ${filing.primaryDocument}` : "",
    ],
    link: filing.filingUrl,
  })));

  await appendTickerPositions(lines, tickerFile, quote, config, toBase);

  return lines.join("\n");
}

function buildTickerStructuredData({
  symbol,
  listing,
  tickerFile,
  financials,
  config,
  notes,
  recentNews,
  recentSecFilings,
  futuresContract,
  distributions,
  statementFilings,
}: {
  symbol: string;
  listing: CliListing;
  statementFilings: StatementFilingsReport | null;
  futuresContract: FuturesContractTermsPayload | null;
  distributions: ForwardYieldDistributions | null;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  notes: string;
  recentNews: NewsArticle[];
  recentSecFilings: SecFilingItem[];
}) {
  const quote = financials.quote;
  const priceReturns = computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory);
  const identity = listingIdentity(listing, quote);
  // Market cap and the multiples at the regular session price, as the text report gives them.
  const priced = atRegularSessionPrice(financials);
  return {
    symbol,
    listing: { symbol: identity.symbol, exchange: identity.exchange || null, name: identity.name },
    quote: quote ? {
      symbol: quote.symbol,
      instrumentType: quote.instrumentType,
      name: quote.name,
      // Last and Change as the text report reads them, then the extended print from that close.
      ...getQuoteSessionFields(quote),
      priceBasis: quote.priceBasis ?? null,
      currency: quote.currency,
      marketCap: priced.quote?.marketCap ?? null,
      volume: quote.volume ?? null,
      exchangeName: quote.exchangeName ?? "",
      fullExchangeName: quote.fullExchangeName ?? "",
      marketState: quote.marketState ?? "",
      dataSource: quote.dataSource ?? "",
      providerId: quote.providerId ?? "",
      lastUpdated: quote.lastUpdated ? new Date(quote.lastUpdated).toISOString() : "",
    } : null,
    quoteMetadata: financials.quoteMetadata,
    // Only for futures: the contract the symbol prices, its terms and its latest confirmed settlement.
    ...futuresContract ? { futuresContract } : {},
    ticker: tickerFile ? {
      ticker: tickerFile.metadata.ticker,
      name: tickerFile.metadata.name ?? "",
      exchange: tickerFile.metadata.exchange ?? "",
      assetCategory: tickerFile.metadata.assetCategory ?? "",
      sector: tickerFile.metadata.sector ?? "",
      industry: tickerFile.metadata.industry ?? "",
      portfolios: formatPortfolioNames(config, tickerFile.metadata.portfolios),
      watchlists: formatWatchlistNames(config, tickerFile.metadata.watchlists),
      positions: tickerFile.metadata.positions,
    } : null,
    fundamentals: financials.fundamentals || priceReturns.return1Y != null || priceReturns.return3Y != null ? exportedDividendFundamentals(exportedFundamentals({
      ...priced.fundamentals,
      ...priceReturns,
    })!, distributions) : undefined,
    profile: financials.profile,
    financialCurrency: financials.financialCurrency ?? null,
    latestAnnual: latestFinancialPeriod(financials.annualStatements, row => row.date) ?? null,
    latestQuarter: latestFinancialPeriod(financials.quarterlyStatements, row => row.date) ?? null,
    annualStatementCount: financials.annualStatements.length,
    quarterlyStatementCount: financials.quarterlyStatements.length,
    // The form and filed date of the latest periods' filings, and a newer quarter's results released before its statements.
    statementFilings,
    notes,
    recentNews: recentNews.map((item) => ({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt instanceof Date ? item.publishedAt.toISOString() : item.publishedAt,
      url: item.url,
      summary: item.summary ?? "",
    })),
    recentSecFilings: recentSecFilings.map((filing) => ({
      form: filing.form,
      filingDate: filing.filingDate instanceof Date ? filing.filingDate.toISOString() : filing.filingDate,
      accessionNumber: filing.accessionNumber,
      filingUrl: filing.filingUrl,
      primaryDocumentUrl: filing.primaryDocumentUrl ?? "",
      description: getFilingDescription(filing) ?? "",
    })),
  };
}

const QUOTE_UNAVAILABLE = "Quote unavailable.";

/** Asks for the quote the report lacks once more, for the reason the data service gave when it had none. */
async function quoteUnavailableNote(dataProvider: MarketContext["dataProvider"], symbol: string, exchange: string): Promise<string> {
  try {
    await dataProvider.getQuote(symbol, exchange);
  } catch (error) {
    return providerMissReason(error) ?? QUOTE_UNAVAILABLE;
  }
  return QUOTE_UNAVAILABLE;
}

export async function ticker(symbol: string, dependencies: TickerCommandDependencies = {}) {
  const initMarketDataFn = dependencies.initMarketData ?? initMarketData;
  const failCommand = dependencies.fail ?? fail;
  await withMarketData(initMarketDataFn, async ({ config, store, dataProvider, dataDir, statementSources }) => {
    let listing: CliListing;
    try {
      listing = await resolveCliListing(symbol, dependencies.exchange, { store, dataProvider });
    } catch (error) {
      if (error instanceof ListingArgError) failCommand(error.message, error.details);
      throw error;
    }
    // A named listing goes by its key (SAN:EPA); a bare symbol by its saved listing, as before.
    const normalized = listing.key;
    const tickerFile = listing.saved;
    const { symbol: requestSymbol, exchange } = listing.request;
    const toBase = createBaseConverter(dataProvider, config.baseCurrency);
    // A bare symbol's venues load beside its research, to name the company it was read as when several list it.
    const venues = loadBareVenues(listing, { store, dataProvider });
    // So does what became of the symbol, read from the research's quote as `history` reads it: a
    // company that moved (HFC became DINO), with nothing new listed there, has no profile of its own.
    const researchQuote = Promise.withResolvers<Quote | null>();
    const fate = listingFateLoader(listing, { dataProvider }, researchQuote.promise);
    const request: ListingDataRequest = { command: "ticker", noun: "research", fate };
    /** Nothing to show: a company that moved is under its new symbol. */
    const failIfMovedAway = async () => {
      researchQuote.resolve(null);
      const moved = movedAwayChange((await fate()).change);
      if (moved) failMovedSymbol(moved, request);
    };

    let financials: TickerFinancials | null = null;
    try {
      financials = await dataProvider.getTickerFinancials(requestSymbol, exchange);
    } catch (error) {
      // A known exchange the symbol is not listed on: say where it is.
      await failIfNotTraded(listing, { store, dataProvider }, { fail: failCommand });
      await failIfMovedAway();
      const reason = error instanceof Error ? error.message : String(error);
      // A symbol no listing carries is not a failed fetch, and the message already names it.
      if (isNotATickerMessage(reason)) failCommand(reason);
      failCommand(`Failed to fetch data for ${normalized}.`, reason);
    }

    const hasResearchData = financials && (
      financials.quote
      || Object.values(financials.profile ?? {}).some(value => value?.trim())
      || Object.entries(financials.fundamentals ?? {}).some(([key, value]) =>
        key !== "return1Y" && key !== "return3Y" && typeof value === "number" && Number.isFinite(value))
      || financials.quoteMetadata?.instrumentType?.trim()
      || financials.quoteMetadata?.currency?.trim()
      || financials.quoteMetadata?.listingExchangeName?.trim()
      || Object.values(computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory)).some(value => value != null)
      || financials.annualStatements.length > 0
      || financials.quarterlyStatements.length > 0
    );
    if (!financials || (!hasResearchData && !tickerFile?.metadata.positions.some((position) => position.shares !== 0))) {
      await failIfNotTraded(listing, { store, dataProvider }, { fail: failCommand });
      await failIfMovedAway();
      failCommand(`No research data available for ${normalized}.`);
    }
    const resolvedFinancials = financials as TickerFinancials;
    const quote = resolvedFinancials.quote;
    // The quote is the old line's (stopped, or named for the company that left): the profile and figures are another security's.
    researchQuote.resolve(quote ?? null);
    const { moved } = await fate();
    if (moved) failMovedSymbol(moved, request);

    const notesFiles = new NotesFiles(dataDir);
    const listingName = listingIdentity(listing, quote).name;
    // The forward yield's distributions, read beside the rest when its basis or its lapse needs them; they never fail the report.
    const distributions = loadForwardYieldDistributions(dataProvider, { symbol: requestSymbol, exchange }, resolvedFinancials.fundamentals,
      { declared: !dependencies.printResult });
    const statementFilings = loadStatementFilings(statementSources, { symbol: requestSymbol, exchange }, {
      quarter: latestFinancialPeriod(resolvedFinancials.quarterlyStatements, (row) => row.date),
      annual: latestFinancialPeriod(resolvedFinancials.annualStatements, (row) => row.date),
    });
    const [notesResult, newsResult, secFilingsResult] = await Promise.allSettled([
      notesFiles.load(tickerFile?.metadata.ticker ?? normalized),
      dataProvider.getNews({
        feed: "ticker",
        // Still set for news plugins that read the deprecated scope.
        scope: "ticker",
        ticker: requestSymbol,
        exchange: exchange || quote?.exchangeName || "",
        tickerTier: "primary",
        limit: NEWS_ITEM_LIMIT,
      }),
      // Outside the US the lookup checks the SEC registrant against the listing's company,
      // and refuses another company's filings.
      shouldFetchSecFilings(requestSymbol, exchange, tickerFile, resolvedFinancials) && dataProvider.getSecFilings
        ? dataProvider.getSecFilings(requestSymbol, SEC_FILING_LIMIT, exchange || quote?.exchangeName || "",
          listingName ? { listingName } : undefined)
        : Promise.resolve([]),
    ]);

    const futuresContract = await cliFuturesContract(quote?.symbol ?? requestSymbol, quote?.instrumentType, dependencies.futuresContract);
    const notes = notesResult.status === "fulfilled" ? notesResult.value : "";
    const recentNews = newsResult.status === "fulfilled" ? newsResult.value : [];
    const recentSecFilings = secFilingsResult.status === "fulfilled" ? secFilingsResult.value : [];

    // The quote is the feed in this report; without one, the fundamentals date it.
    const freshness = quote ? quotesFreshness([quote]) : fundamentalsFreshness(resolvedFinancials);
    const quoteNote = quote ? undefined : await quoteUnavailableNote(dataProvider, requestSymbol, exchange);
    const [choiceNote] = await listingChoiceNotes(listing, { store, dataProvider }, quote, venues);
    // A bare coin ticker read as a fund says where the coin is, as `quote` does; a named listing was meant.
    const coinNote = listing.exchange ? null
      : notTheCoinNote(listing.symbol, quote ?? (tickerFile ? { name: tickerFile.metadata.name, instrumentType: tickerFile.metadata.assetCategory } : null));
    const listingNote = [choiceNote, coinNote].filter((note): note is string => !!note).join("\n") || undefined;
    if (dependencies.printResult) {
      const warnings = [choiceNote, coinNote, quoteNote].filter((note): note is string => !!note);
      dependencies.printResult({
        freshness,
        warnings: warnings.length > 0 ? warnings : undefined,
        data: buildTickerStructuredData({
          symbol: normalized,
          listing,
          tickerFile,
          financials: resolvedFinancials,
          config,
          notes,
          recentNews,
          recentSecFilings,
          futuresContract,
          distributions: await distributions,
          statementFilings: await statementFilings,
        }),
      });
      return;
    }

    console.log(await buildTickerReport({
        symbol: normalized,
        listingExchange: listing.exchange,
        tickerFile,
        financials: resolvedFinancials,
        config,
        toBase,
        notes,
        quoteNote,
        listingNote,
        recentNews,
        recentSecFilings,
        futuresContract,
        distributions: await distributions,
        statementFilings: await statementFilings,
    }));
    if (freshness) console.log(`\n${cliFreshnessFooter(freshness)}`);
  });
}
