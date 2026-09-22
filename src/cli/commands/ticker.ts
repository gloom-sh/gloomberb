import { formatReportedMoney } from "../../utils/reported-money";
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import { formatPriceEarnings } from "../../utils/price-earnings";
import { describeFundamentalMarketCap, selectMarketCapitalization } from "../../utils/market-capitalization";
import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercent,
} from "../../utils/format";
import { formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity, formatMarketChangeWithCurrency, quoteFormatOptions } from "../../market-data/market/format";
import {
  cliStyles,
  cliTerminalWidth,
  colorBySign,
  renderSection,
  renderStats,
  wrapText,
  type CliStatEntry,
} from "../../utils/cli-output";
import { exchangeShortName, marketStateLabel } from "../../market-data/market/status";
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
  formatNullableCompact,
  formatPortfolioNames,
  formatSignedCurrency,
  formatSignedPercentRaw,
  formatTimestamp,
  formatWatchlistNames,
} from "../helpers";
import { NotesFiles } from "../../plugins/builtin/notes/files";
import { isUsEquityTicker } from "../../utils/sec";

const NEWS_ITEM_LIMIT = 5;
const SEC_FILING_LIMIT = 5;
// Prose such as a company description stays readable on wide terminals.
const MAX_PROSE_WIDTH = 100;
const METADATA_SEPARATOR = "  ·  ";

interface TickerCommandDependencies {
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
    ["Diluted Shares", formatNullableCompact(statement.dilutedShares)],
  ];
}

function appendTextSection(lines: string[], title: string, content: string | undefined) {
  const text = content?.trim();
  if (!text) return;
  lines.push("");
  lines.push(renderSection(title));
  lines.push(wrapProse(text));
}

function normalizeTimestamp(value: Date | string | number | undefined): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  if (typeof value === "string" || typeof value === "number") {
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  return null;
}

function formatFeedDate(value: Date | string | number | undefined): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp == null) return "";
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

function shouldFetchSecFilings(tickerFile: TickerRecord | null, financials: TickerFinancials): boolean {
  if (isUsEquityTicker(tickerFile)) {
    return true;
  }

  const quote = financials.quote;
  if (!quote || quote.currency.toUpperCase() !== "USD") {
    return false;
  }

  const exchangeHints = [
    tickerFile?.metadata.exchange,
    quote.exchangeName,
    quote.fullExchangeName,
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toUpperCase();

  return /(NASDAQ|NYSE|AMEX|ARCA|IEX|BATS|PINK|OTC|NMS)/.test(exchangeHints);
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

function fundamentalsMetrics(
  fundamentals: TickerFinancials["fundamentals"],
  marketCapText: string,
  priceReturns: { return1Y?: number | null; return3Y?: number | null },
): Array<[string, string]> {
  return [
    ["Market Cap", marketCapText],
    ["Enterprise Value", formatNullableCompact(fundamentals?.enterpriseValue)],
    ["P/E (TTM)", formatPriceEarnings(fundamentals?.trailingPE, 2)],
    ["Forward P/E", formatPriceEarnings(fundamentals?.forwardPE, 2)],
    ["PEG", fundamentals?.pegRatio != null ? formatNumber(fundamentals.pegRatio, 2) : "—"],
    ["EPS", formatReportedMoney(fundamentals?.eps, fundamentals?.financialCurrency, true)],
    [`Dividend Yield${fundamentals?.dividendYieldBasis ? ` (${fundamentals.dividendYieldBasis})` : ""}`, fundamentals?.dividendYield != null ? formatFractionPercentCell(fundamentals.dividendYield) : "—"],
    ["Revenue", formatReportedMoney(fundamentals?.revenue, fundamentals?.financialCurrency)],
    ["Net Income", formatReportedMoney(fundamentals?.netIncome, fundamentals?.financialCurrency)],
    ["Operating Cash Flow", formatReportedMoney(fundamentals?.operatingCashFlow, fundamentals?.financialCurrency)],
    ["Free Cash Flow", formatReportedMoney(fundamentals?.freeCashFlow, fundamentals?.financialCurrency)],
    // Levels, not changes, so they carry no sign.
    ["Operating Margin", fundamentals?.operatingMargin != null ? formatFractionPercentCell(fundamentals.operatingMargin) : "—"],
    ["Profit Margin", fundamentals?.profitMargin != null ? formatFractionPercentCell(fundamentals.profitMargin) : "—"],
    ["Revenue Growth", fundamentals?.revenueGrowth != null ? colorBySign(formatPercent(fundamentals.revenueGrowth), fundamentals.revenueGrowth) : "—"],
    ["Last Quarter Growth", fundamentals?.lastQuarterGrowth != null ? colorBySign(formatPercent(fundamentals.lastQuarterGrowth), fundamentals.lastQuarterGrowth) : "—"],
    ["1Y Return", priceReturns.return1Y != null ? colorBySign(formatPercent(priceReturns.return1Y), priceReturns.return1Y) : "—"],
    ["3Y Return", priceReturns.return3Y != null ? colorBySign(formatPercent(priceReturns.return3Y), priceReturns.return3Y) : "—"],
    ["Shares Outstanding", formatNullableCompact(fundamentals?.sharesOutstanding)],
  ];
}

const VALUATION_METRICS = new Set(["Market Cap", "Enterprise Value", "P/E (TTM)", "Forward P/E", "PEG", "EPS"]);

/** Text for `gloomberb fundamentals` and `gloomberb valuation`: the ticker report's fundamentals without the rest. */
export function renderFundamentalsReport(
  financials: TickerFinancials & { symbol: string },
  view: "fundamentals" | "valuation",
): string {
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const profile = financials.profile;
  const capitalization = selectMarketCapitalization(quote, fundamentals);
  const marketCapText = capitalization
    ? `${formatCompact(capitalization.value)} ${capitalization.currency}`
    : "—";
  const metrics = fundamentalsMetrics(fundamentals, marketCapText, computeTickerPriceReturns(financials));
  const symbol = quote?.symbol ?? financials.symbol;
  const name = quote?.name && quote.name !== symbol ? ` ${cliStyles.bold(quote.name)}` : "";
  const lines = [`${cliStyles.accent(symbol)}${name}`];
  const profileParts = [
    profile?.sector ? `Sector ${profile.sector}` : undefined,
    profile?.industry ? `Industry ${profile.industry}` : undefined,
  ].filter((part): part is string => !!part);
  if (profileParts.length > 0) lines.push(cliStyles.muted(profileParts.join(METADATA_SEPARATOR)));

  const shown = view === "valuation"
    ? metrics.filter(([label]) => VALUATION_METRICS.has(label) || label.startsWith("Dividend Yield"))
    : metrics;
  const before = lines.length;
  appendMetricSection(lines, view === "valuation" ? "Valuation" : "Fundamentals", shown);
  if (lines.length === before) lines.push("", cliStyles.muted(`No ${view} reported for ${financials.symbol}.`));
  if (view === "fundamentals") appendTextSection(lines, "Description", profile?.description);
  return lines.join("\n");
}

export async function buildTickerReport({
  symbol,
  tickerFile,
  financials,
  config,
  toBase,
  notes,
  recentNews = [],
  recentSecFilings = [],
}: {
  symbol: string;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
  notes?: string;
  recentNews?: NewsArticle[];
  recentSecFilings?: SecFilingItem[];
}): Promise<string> {
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const priceReturns = computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory);
  const profile = financials.profile;
  const name = quote?.name || tickerFile?.metadata.name || symbol;
  const quoteOptions = quoteFormatOptions(quote, tickerFile?.metadata.assetCategory, financials.quoteMetadata?.instrumentType);
  const lines: string[] = [];

  lines.push(`${cliStyles.accent(quote?.symbol ?? symbol)} ${cliStyles.bold(name)}`);
  if (!quote) lines.push(cliStyles.muted("Quote unavailable."));

  const summaryParts = [
    exchangeShortName(quote?.exchangeName ?? financials.quoteMetadata?.listingExchangeName ?? tickerFile?.metadata.exchange, quote?.fullExchangeName) || undefined,
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

  if (quote) {
    appendMetricSection(lines, "Quote", [
      ["Last", colorBySign(formatMarketPriceWithCurrency(quote.price, quote.currency, quoteOptions), quote.change)],
      ["Change", colorBySign(`${formatMarketChangeWithCurrency(quote.change, quote.currency, quoteOptions)} (${formatSignedPercentRaw(quote.changePercent)})`, quote.change)],
      ["Open", quote.open != null ? formatMarketPriceWithCurrency(quote.open, quote.currency, quoteOptions) : "—"],
      ["Day Range", quote.low != null || quote.high != null
        ? `${quote.low != null ? formatMarketPriceWithCurrency(quote.low, quote.currency, quoteOptions) : "—"} - ${quote.high != null ? formatMarketPriceWithCurrency(quote.high, quote.currency, quoteOptions) : "—"}`
        : "—"],
      ["52W Range", quote.low52w != null || quote.high52w != null
        ? `${quote.low52w != null ? formatMarketPriceWithCurrency(quote.low52w, quote.currency, quoteOptions) : "—"} - ${quote.high52w != null ? formatMarketPriceWithCurrency(quote.high52w, quote.currency, quoteOptions) : "—"}`
        : "—"],
      ["Bid / Ask", formatBidAsk(quote.bid, quote.ask, quote.bidSize, quote.askSize, quote.currency, quoteOptions.assetCategory, quote.priceBasis)],
      ["Volume", quote.volume != null ? formatNumber(quote.volume, 0) : "—"],
      ["Updated", formatTimestamp(quote.lastUpdated)],
    ]);

    appendMetricSection(lines, "Extended Hours", [
      ["Pre-Market", quote.preMarketPrice != null
        ? colorBySign(
          `${formatMarketPriceWithCurrency(quote.preMarketPrice, quote.currency, quoteOptions)} (${quote.preMarketChangePercent != null ? formatSignedPercentRaw(quote.preMarketChangePercent) : "—"})`,
          quote.preMarketChange ?? 0,
        )
        : "—"],
      ["After Hours", quote.postMarketPrice != null
        ? colorBySign(
          `${formatMarketPriceWithCurrency(quote.postMarketPrice, quote.currency, quoteOptions)} (${quote.postMarketChangePercent != null ? formatSignedPercentRaw(quote.postMarketChangePercent) : "—"})`,
          quote.postMarketChange ?? 0,
        )
        : "—"],
    ]);
  }

  appendMetricSection(lines, "Fundamentals", fundamentalsMetrics(fundamentals, marketCapText, priceReturns));

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

  appendTextSection(lines, "Notes", notes);

  appendFeedSection(lines, "Recent News", recentNews.map((item) => ({
    title: item.title,
    meta: [
      item.source,
      (() => {
        const publishedAt = normalizeTimestamp(item.publishedAt as Date | string | number | undefined);
        return publishedAt == null ? "" : formatTimestamp(publishedAt);
      })(),
    ],
    body: item.summary,
    link: item.url,
  })));

  appendFeedSection(lines, "Recent SEC Filings", recentSecFilings.map((filing) => ({
    title: (() => {
      const filingDate = formatFeedDate(filing.filingDate as Date | string | number | undefined);
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
  tickerFile,
  financials,
  config,
  notes,
  recentNews,
  recentSecFilings,
}: {
  symbol: string;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  notes: string;
  recentNews: NewsArticle[];
  recentSecFilings: SecFilingItem[];
}) {
  const quote = financials.quote;
  const priceReturns = computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory);
  return {
    symbol,
    quote: quote ? {
      symbol: quote.symbol,
      instrumentType: quote.instrumentType,
      name: quote.name,
      price: quote.price,
      priceBasis: quote.priceBasis ?? null,
      change: quote.change,
      changePercent: quote.changePercent,
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
    fundamentals: financials.fundamentals || priceReturns.return1Y != null || priceReturns.return3Y != null ? {
      ...financials.fundamentals,
      ...priceReturns,
    } : undefined,
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

export async function ticker(symbol: string, dependencies: TickerCommandDependencies = {}) {
  const initMarketDataFn = dependencies.initMarketData ?? initMarketData;
  const failCommand = dependencies.fail ?? fail;
  await withMarketData(initMarketDataFn, async ({ config, store, dataProvider, dataDir }) => {
    const normalized = symbol.trim().toUpperCase();
    const tickerFile = await store.loadTicker(normalized);
    const exchange = tickerFile?.metadata.exchange ?? "";
    const toBase = createBaseConverter(dataProvider, config.baseCurrency);

    let financials: TickerFinancials | null = null;
    try {
      financials = await dataProvider.getTickerFinancials(normalized, exchange);
    } catch (error) {
      failCommand(
        `Failed to fetch data for ${normalized}.`,
        error instanceof Error ? error.message : String(error),
      );
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
      failCommand(`No research data available for ${normalized}.`);
    }
    const resolvedFinancials = financials as TickerFinancials;
    const quote = resolvedFinancials.quote;

    const notesFiles = new NotesFiles(dataDir);
    const [notesResult, newsResult, secFilingsResult] = await Promise.allSettled([
      notesFiles.load(normalized),
      dataProvider.getNews({
        feed: "ticker",
        scope: "ticker",
        ticker: normalized,
        exchange: exchange || quote?.exchangeName || "",
        tickerTier: "primary",
        limit: NEWS_ITEM_LIMIT,
      }),
      shouldFetchSecFilings(tickerFile, resolvedFinancials) && dataProvider.getSecFilings
        ? dataProvider.getSecFilings(normalized, SEC_FILING_LIMIT, exchange || quote?.exchangeName || "")
        : Promise.resolve([]),
    ]);

    const notes = notesResult.status === "fulfilled" ? notesResult.value : "";
    const recentNews = newsResult.status === "fulfilled" ? newsResult.value : [];
    const recentSecFilings = secFilingsResult.status === "fulfilled" ? secFilingsResult.value : [];

    if (dependencies.printResult) {
      dependencies.printResult({
        warnings: quote ? undefined : ["Quote unavailable."],
        data: buildTickerStructuredData({
          symbol: normalized,
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
        tickerFile,
        financials: resolvedFinancials,
        config,
        toBase,
        notes,
        recentNews,
        recentSecFilings,
    }));
  });
}
