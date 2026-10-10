import { formatShortDate, parseDisplayDate } from "../../utils/datetime-format";
import { formatReportedMoney } from "../../utils/reported-money";
import { fundamentalsCurrency, reportedEnterpriseValue } from "../../utils/fundamentals";
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import { exportedFundamentals, formatPriceEarnings, priceEarningsOnEarnings } from "../../utils/price-earnings";
import { describeFundamentalMarketCap, selectMarketCapitalization } from "../../utils/market-capitalization";
import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "../../utils/format";
import { formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity, formatMarketChangeWithCurrency, quoteFormatOptions, withCurrencyMinorDigits } from "../../market-data/market/format";
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
  marketStateLabel,
} from "../../market-data/market/status";
import type { AppConfig } from "../../types/config";
import type { FinancialStatement, TickerFinancials } from "../../types/financials";
import { computeTickerPriceReturns } from "../../market-data/ticker-price-returns";
import type { SecFilingItem } from "../../types/data-provider";
import type { NewsArticle } from "../../news/types";
import type { TickerRecord } from "../../types/ticker";
import type { CliCommandContext } from "../../types/plugin";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl } from "../../plugins/builtin/portfolio-list/position-metrics";
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
import { canonicalExchange, exchangeLabel, isKnownExchangeCode } from "../../utils/exchanges";
import { failIfNotTraded, ListingArgError, listingIdentity, resolveCliListing, type CliListing } from "../listing-arg";
import { isNotATickerMessage } from "../not-a-ticker";
import { sharesOutstandingInReceipts } from "../../utils/depositary-receipt";
import { cliFreshnessFooter } from "../result";
import { providerMissReason } from "../../sources/provider-errors";
import { exportEntriesTable, reportFooterLines, type CliReportTables } from "../report-tables";
import type { ReportFreshness } from "../pane-functions/freshness";
import { fundamentalsFreshness, quotesFreshness } from "../freshness";

const NEWS_ITEM_LIMIT = 5;
const SEC_FILING_LIMIT = 5;
// Prose such as a company description stays readable on wide terminals.
const MAX_PROSE_WIDTH = 100;
const METADATA_SEPARATOR = "  ·  ";

interface TickerCommandDependencies {
  /** `--exchange`: the listing, for a symbol that trades in several places. */
  exchange?: string;
  initMarketData?: () => Promise<MarketContext>;
  fail?: (message: string, details?: string) => never;
  printResult?: CliCommandContext["printResult"];
}

function appendMetricSection(lines: string[], title: string, metrics: Array<[string, string]>) {
  const populated = metrics.filter(([, value]) => value !== "—");
  if (populated.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(renderSection(title));
  lines.push(renderStats(populated));
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
}

type MetricFigure = Omit<FundamentalsMetric, "label">;

/** An amount in the currency the source reported it in; `ccy?` when it named none, as the text says. */
function reportedMoney(value: number | undefined, currency: string | undefined, perShare = false): MetricFigure {
  return { text: formatReportedMoney(value, currency, perShare), value, unit: currency?.trim() || "ccy?" };
}

function percentFigure(fraction: number | null | undefined, format: (value: number) => string): MetricFigure {
  return fraction != null ? { text: format(fraction), value: fraction * 100, unit: "%" } : { text: "—" };
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
): FundamentalsMetric[] {
  const signed = (value: number) => colorBySign(formatPercent(value), value);
  const receipt = fundamentals?.sharesOutstanding != null && sharesOutstandingInReceipts(quote, fundamentals, profile?.description);
  return [
    { label: "Market Cap", ...marketCap },
    { label: "Enterprise Value", ...enterpriseValue },
    // A multiple over a loss is N/M, even beside a positive one the source served from an older period.
    { label: "P/E (TTM)", ...multipleFigure(priceEarningsOnEarnings(fundamentals?.trailingPE, fundamentals?.eps)) },
    { label: "Forward P/E", ...multipleFigure(priceEarningsOnEarnings(fundamentals?.forwardPE, fundamentals?.forwardEps)) },
    { label: "PEG", ...multipleFigure(fundamentals?.pegRatio) },
    // The flows and EPS are one trailing-twelve-month block, the same twelve months for each line.
    { label: "EPS (TTM)", ...reportedMoney(fundamentals?.eps, reportingCurrency, true) },
    {
      label: `Dividend Yield${fundamentals?.dividendYieldBasis ? ` (${fundamentals.dividendYieldBasis})` : ""}`,
      ...percentFigure(fundamentals?.dividendYield, formatFractionPercentCell),
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

function metricLines(metrics: readonly FundamentalsMetric[]): Array<[string, string]> {
  return metrics.map((metric) => [metric.label, metric.text]);
}

const VALUATION_METRICS = new Set(["Market Cap", "Enterprise Value", "P/E (TTM)", "Forward P/E", "PEG", "EPS (TTM)"]);

type FundamentalsReportData = TickerFinancials & { symbol: string; exchange?: string };

/** The lines `fundamentals` or `valuation` reports, the ones with a value. */
function fundamentalsReportMetrics(financials: FundamentalsReportData, view: "fundamentals" | "valuation"): FundamentalsMetric[] {
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const capitalization = selectMarketCapitalization(quote, fundamentals);
  const marketCap: MetricFigure = capitalization
    ? { text: `${formatCompact(capitalization.value)} ${capitalization.currency}`, value: capitalization.value, unit: capitalization.currency }
    : { text: "—" };
  const metrics = fundamentalsMetrics(quote, fundamentals, financials.profile, marketCap, computeTickerPriceReturns(financials), fundamentalsCurrency(financials));
  return (view === "valuation"
    ? metrics.filter(({ label }) => VALUATION_METRICS.has(label) || label.startsWith("Dividend Yield"))
    : metrics).filter((metric) => metric.text !== "—");
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
  appendMetricSection(lines, view === "valuation" ? "Valuation" : "Fundamentals", metricLines(fundamentalsReportMetrics(financials, view)));
  if (lines.length === before) lines.push("", cliStyles.muted(`No ${view} reported for ${financials.symbol}.`));
  if (view === "fundamentals") appendTextSection(lines, "Description", profile?.description);
  return lines.join("\n");
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
  const tables = [exportEntriesTable(
    view === "valuation" ? "Valuation" : "Fundamentals",
    metrics.map((metric) => ({ label: metric.label, value: metric.value, formatted: metric.text, unit: metric.unit })),
  )];
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
      notes: metrics.length === 0 ? [`No ${view} reported for ${financials.symbol}.`] : [],
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
  const venue = canonicalExchange(listingExchange || quote?.listingExchangeName || exchangeName);
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
  recentNews = [],
  recentSecFilings = [],
}: {
  symbol: string;
  /** The exchange the command named, as a canonical code. */
  listingExchange?: string;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
  notes?: string;
  /** Why there is no quote, when a source said; "Quote unavailable." otherwise. */
  quoteNote?: string;
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

  const summaryParts = [
    listingVenueLabel(listingExchange, quote, financials, tickerFile) || undefined,
    (quote?.currency || financials.quoteMetadata?.currency || tickerFile?.metadata.currency)
      ? `Currency ${quote?.currency || financials.quoteMetadata?.currency || tickerFile?.metadata.currency}` : undefined,
    quote?.marketState ? marketStateLabel(quote.marketState) : undefined,
    quote?.dataSource ? `Source ${quote.dataSource.toUpperCase()}` : undefined,
  ].filter((part): part is string => !!part);
  if (summaryParts.length > 0) {
    lines.push(cliStyles.muted(summaryParts.join(METADATA_SEPARATOR)));
  }

  const instrumentType = quote?.instrumentType?.trim()
    || financials.quoteMetadata?.instrumentType?.trim()
    || tickerFile?.metadata.assetCategory;
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

  const capitalization = selectMarketCapitalization(quote, fundamentals);
  const convertedMarketCap = capitalization ? await toBase(capitalization.value, capitalization.currency) : Number.NaN;
  const marketCapText = capitalization
    ? Number.isFinite(convertedMarketCap)
      ? `${formatCompact(convertedMarketCap)} ${config.baseCurrency}`
      : `${formatCompact(capitalization.value)} ${capitalization.currency}`
    : "—";
  // Shown in the same currency as the market cap, so the two can be compared.
  const enterpriseValue = reportedEnterpriseValue(fundamentals);
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
    appendMetricSection(lines, "Quote", [
      ["Last", colorBySign(formatMarketPriceWithCurrency(session.price, quote.currency, quoteOptions), session.change)],
      ["Change", colorBySign(`${formatMarketChangeWithCurrency(session.change, quote.currency, quoteOptions, session.price)} (${formatPercentRaw(session.changePercent)})`, session.change)],
      ["Open", quote.open != null ? formatMarketPriceWithCurrency(quote.open, quote.currency, quoteOptions) : "—"],
      ["Day Range", quote.low != null || quote.high != null
        ? formatPriceRange(quote.low, quote.high, quote.currency, quoteOptions)
        : "—"],
      ["52W Range", quote.low52w != null || quote.high52w != null
        ? formatPriceRange(quote.low52w, quote.high52w, quote.currency, quoteOptions)
        : "—"],
      ["Bid / Ask", formatBidAsk(quote.bid, quote.ask, quote.bidSize, quote.askSize, quote.currency, quoteOptions)],
      ["Volume", quote.volume != null ? formatNumber(quote.volume, 0) : "—"],
      ["Updated", formatTimestamp(quote.lastUpdated)],
    ]);

    appendMetricSection(lines, "Extended Hours", [
      [EXTENDED_SESSION_LABELS.PRE, extendedRow("PRE")],
      [EXTENDED_SESSION_LABELS.POST, extendedRow("POST")],
    ]);
  }

  appendMetricSection(lines, "Fundamentals", metricLines(fundamentalsMetrics(quote, fundamentals, profile, { text: marketCapText }, priceReturns, fundamentalsCurrency(financials), { text: enterpriseValueText })));

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
    appendMetricSection(lines, `Latest Annual (${latestAnnual.date})`, buildStatementMetrics(latestAnnual, statementCurrency(latestAnnual)));
  }

  const latestQuarter = latestFinancialPeriod(financials.quarterlyStatements, row => row.date);
  if (latestQuarter) {
    appendMetricSection(lines, `Latest Quarter (${latestQuarter.date})`, buildStatementMetrics(latestQuarter, statementCurrency(latestQuarter)));
  }

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
}: {
  symbol: string;
  listing: CliListing;
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
      marketCap: quote.marketCap ?? null,
      volume: quote.volume ?? null,
      exchangeName: quote.exchangeName ?? "",
      fullExchangeName: quote.fullExchangeName ?? "",
      marketState: quote.marketState ?? "",
      dataSource: quote.dataSource ?? "",
      providerId: quote.providerId ?? "",
      lastUpdated: quote.lastUpdated ? new Date(quote.lastUpdated).toISOString() : "",
    } : null,
    quoteMetadata: financials.quoteMetadata,
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
    fundamentals: financials.fundamentals || priceReturns.return1Y != null || priceReturns.return3Y != null ? exportedFundamentals({
      ...financials.fundamentals,
      ...priceReturns,
    }) : undefined,
    profile: financials.profile,
    financialCurrency: financials.financialCurrency ?? null,
    latestAnnual: latestFinancialPeriod(financials.annualStatements, row => row.date) ?? null,
    latestQuarter: latestFinancialPeriod(financials.quarterlyStatements, row => row.date) ?? null,
    annualStatementCount: financials.annualStatements.length,
    quarterlyStatementCount: financials.quarterlyStatements.length,
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
  await withMarketData(initMarketDataFn, async ({ config, store, dataProvider, dataDir }) => {
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

    let financials: TickerFinancials | null = null;
    try {
      financials = await dataProvider.getTickerFinancials(requestSymbol, exchange);
    } catch (error) {
      // A known exchange the symbol is not listed on: say where it is.
      await failIfNotTraded(listing, { store, dataProvider }, { fail: failCommand });
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
      failCommand(`No research data available for ${normalized}.`);
    }
    const resolvedFinancials = financials as TickerFinancials;
    const quote = resolvedFinancials.quote;

    const notesFiles = new NotesFiles(dataDir);
    const listingName = listingIdentity(listing, quote).name;
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

    const notes = notesResult.status === "fulfilled" ? notesResult.value : "";
    const recentNews = newsResult.status === "fulfilled" ? newsResult.value : [];
    const recentSecFilings = secFilingsResult.status === "fulfilled" ? secFilingsResult.value : [];

    // The quote is the feed in this report; without one, the fundamentals date it.
    const freshness = quote ? quotesFreshness([quote]) : fundamentalsFreshness(resolvedFinancials);
    const quoteNote = quote ? undefined : await quoteUnavailableNote(dataProvider, requestSymbol, exchange);
    if (dependencies.printResult) {
      dependencies.printResult({
        freshness,
        warnings: quote ? undefined : [quoteNote!],
        data: buildTickerStructuredData({
          symbol: normalized,
          listing,
          tickerFile,
          financials: resolvedFinancials,
          config,
          notes,
          recentNews,
          recentSecFilings,
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
        recentNews,
        recentSecFilings,
    }));
    if (freshness) console.log(`\n${cliFreshnessFooter(freshness)}`);
  });
}
