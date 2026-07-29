import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercent,
} from "../../utils/format";
import { formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity } from "../../market-data/market/format";
import {
  cliStyles,
  colorBySign,
  renderSection,
  renderStat,
} from "../../utils/cli-output";
import { exchangeShortName, marketStateLabel } from "../../market-data/market/status";
import type { AppConfig } from "../../types/config";
import type { FinancialStatement, TickerFinancials } from "../../types/financials";
import type { SecFilingItem } from "../../types/data-provider";
import type { NewsArticle } from "../../news/types";
import type { TickerRecord } from "../../types/ticker";
import type { CliCommandContext } from "../../types/plugin";
import { createBaseConverter } from "../base-converter";
import { initMarketData, withMarketData } from "../context";
import { fail } from "../errors";
import type { MarketContext } from "../types";
import {
  formatBidAsk,
  formatNullableCompact,
  formatPortfolioNames,
  formatSignedCurrency,
  formatSignedPercentRaw,
  formatStatementValue,
  formatTimestamp,
  formatWatchlistNames,
} from "../helpers";
import { NotesFiles } from "../../plugins/builtin/notes/files";
import { isUsEquityTicker } from "../../utils/sec";

const NEWS_ITEM_LIMIT = 5;
const SEC_FILING_LIMIT = 5;

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
  for (const [label, value] of populated) {
    lines.push(renderStat(label, value));
  }
}

function buildStatementMetrics(statement: FinancialStatement): Array<[string, string]> {
  return [
    ["Revenue", formatStatementValue(statement.totalRevenue)],
    ["Gross Profit", formatStatementValue(statement.grossProfit)],
    ["Operating Income", formatStatementValue(statement.operatingIncome)],
    ["Net Income", formatStatementValue(statement.netIncome)],
    ["EBITDA", formatStatementValue(statement.ebitda)],
    ["Operating Cash Flow", formatStatementValue(statement.operatingCashFlow)],
    ["Free Cash Flow", formatStatementValue(statement.freeCashFlow)],
    ["Cash", formatStatementValue(statement.cashAndCashEquivalents)],
    ["Total Assets", formatStatementValue(statement.totalAssets)],
    ["Total Liabilities", formatStatementValue(statement.totalLiabilities)],
    ["Total Debt", formatStatementValue(statement.totalDebt)],
    ["Equity", formatStatementValue(statement.totalEquity)],
    ["Diluted EPS", formatStatementValue(statement.eps, "eps")],
    ["Diluted Shares", formatStatementValue(statement.dilutedShares)],
  ];
}

function appendTextSection(lines: string[], title: string, content: string | undefined) {
  const text = content?.trim();
  if (!text) return;
  lines.push("");
  lines.push(renderSection(title));
  lines.push(text);
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
      lines.push(cliStyles.muted(meta.join("  |  ")));
    }
    if (entry.body?.trim()) {
      lines.push(entry.body.trim());
    }
    if (entry.link?.trim()) {
      lines.push(cliStyles.muted(entry.link.trim()));
    }
    if (index < populated.length - 1) {
      lines.push(cliStyles.muted("-".repeat(24)));
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
  const profile = financials.profile;
  const name = quote?.name || tickerFile?.metadata.name || symbol;
  const lines: string[] = [];

  if (!quote) {
    return "";
  }

  lines.push(`${cliStyles.accent(quote.symbol)} ${cliStyles.bold(name)}`);

  const summaryParts = [
    exchangeShortName(quote.exchangeName, quote.fullExchangeName) || undefined,
    quote.currency ? `Currency ${quote.currency}` : undefined,
    quote.marketState ? marketStateLabel(quote.marketState) : undefined,
    quote.dataSource ? `Source ${quote.dataSource.toUpperCase()}` : undefined,
  ].filter((part): part is string => !!part);
  if (summaryParts.length > 0) {
    lines.push(cliStyles.muted(summaryParts.join("  |  ")));
  }

  const metadataParts = [
    tickerFile?.metadata.assetCategory ? `Type ${tickerFile.metadata.assetCategory}` : undefined,
    (tickerFile?.metadata.sector || profile?.sector) ? `Sector ${tickerFile?.metadata.sector || profile?.sector}` : undefined,
    (tickerFile?.metadata.industry || profile?.industry) ? `Industry ${tickerFile?.metadata.industry || profile?.industry}` : undefined,
  ].filter((part): part is string => !!part);
  if (metadataParts.length > 0) {
    lines.push(cliStyles.muted(metadataParts.join("  |  ")));
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
    lines.push(cliStyles.muted(membershipParts.join("  |  ")));
  }

  const marketCapText = quote.marketCap != null
    ? `${formatCompact(await toBase(quote.marketCap, quote.currency))} ${config.baseCurrency}`
    : "—";

  appendMetricSection(lines, "Quote", [
    ["Last", colorBySign(formatMarketPriceWithCurrency(quote.price, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory }), quote.change)],
    ["Change", colorBySign(`${formatSignedCurrency(quote.change, quote.currency)} (${formatSignedPercentRaw(quote.changePercent)})`, quote.change)],
    ["Open", quote.open != null ? formatMarketPriceWithCurrency(quote.open, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory }) : "—"],
    ["Day Range", quote.low != null || quote.high != null
      ? `${quote.low != null ? formatMarketPriceWithCurrency(quote.low, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory }) : "—"} - ${quote.high != null ? formatMarketPriceWithCurrency(quote.high, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory }) : "—"}`
      : "—"],
    ["52W Range", quote.low52w != null || quote.high52w != null
      ? `${quote.low52w != null ? formatMarketPriceWithCurrency(quote.low52w, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory }) : "—"} - ${quote.high52w != null ? formatMarketPriceWithCurrency(quote.high52w, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory }) : "—"}`
      : "—"],
    ["Bid / Ask", formatBidAsk(quote.bid, quote.ask, quote.bidSize, quote.askSize, quote.currency, tickerFile?.metadata.assetCategory)],
    ["Volume", quote.volume != null ? formatNumber(quote.volume, 0) : "—"],
    ["Updated", formatTimestamp(quote.lastUpdated)],
  ]);

  appendMetricSection(lines, "Extended Hours", [
    ["Pre-Market", quote.preMarketPrice != null
      ? colorBySign(
        `${formatMarketPriceWithCurrency(quote.preMarketPrice, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory })} (${formatSignedPercentRaw(quote.preMarketChangePercent ?? 0)})`,
        quote.preMarketChange ?? 0,
      )
      : "—"],
    ["After Hours", quote.postMarketPrice != null
      ? colorBySign(
        `${formatMarketPriceWithCurrency(quote.postMarketPrice, quote.currency, { assetCategory: tickerFile?.metadata.assetCategory })} (${formatSignedPercentRaw(quote.postMarketChangePercent ?? 0)})`,
        quote.postMarketChange ?? 0,
      )
      : "—"],
  ]);

  appendMetricSection(lines, "Fundamentals", [
    ["Market Cap", marketCapText],
    ["Enterprise Value", formatNullableCompact(fundamentals?.enterpriseValue)],
    ["P/E (TTM)", fundamentals?.trailingPE != null ? formatNumber(fundamentals.trailingPE, 2) : "—"],
    ["Forward P/E", fundamentals?.forwardPE != null ? formatNumber(fundamentals.forwardPE, 2) : "—"],
    ["PEG", fundamentals?.pegRatio != null ? formatNumber(fundamentals.pegRatio, 2) : "—"],
    ["EPS", fundamentals?.eps != null ? formatCurrency(fundamentals.eps, quote.currency) : "—"],
    ["Dividend Yield", fundamentals?.dividendYield != null ? formatPercent(fundamentals.dividendYield) : "—"],
    ["Revenue", formatNullableCompact(fundamentals?.revenue)],
    ["Net Income", formatNullableCompact(fundamentals?.netIncome)],
    ["Operating Cash Flow", formatNullableCompact(fundamentals?.operatingCashFlow)],
    ["Free Cash Flow", formatNullableCompact(fundamentals?.freeCashFlow)],
    ["Operating Margin", fundamentals?.operatingMargin != null ? formatPercent(fundamentals.operatingMargin) : "—"],
    ["Profit Margin", fundamentals?.profitMargin != null ? formatPercent(fundamentals.profitMargin) : "—"],
    ["Revenue Growth", fundamentals?.revenueGrowth != null ? colorBySign(formatPercent(fundamentals.revenueGrowth), fundamentals.revenueGrowth) : "—"],
    ["Last Quarter Growth", fundamentals?.lastQuarterGrowth != null ? colorBySign(formatPercent(fundamentals.lastQuarterGrowth), fundamentals.lastQuarterGrowth) : "—"],
    ["1Y Return", fundamentals?.return1Y != null ? colorBySign(formatPercent(fundamentals.return1Y), fundamentals.return1Y) : "—"],
    ["3Y Return", fundamentals?.return3Y != null ? colorBySign(formatPercent(fundamentals.return3Y), fundamentals.return3Y) : "—"],
    ["Shares Outstanding", formatNullableCompact(fundamentals?.sharesOutstanding)],
  ]);

  const latestAnnual = financials.annualStatements.at(-1);
  if (latestAnnual) {
    appendMetricSection(lines, `Latest Annual (${latestAnnual.date})`, buildStatementMetrics(latestAnnual));
  }

  const latestQuarter = financials.quarterlyStatements.at(-1);
  if (latestQuarter) {
    appendMetricSection(lines, `Latest Quarter (${latestQuarter.date})`, buildStatementMetrics(latestQuarter));
  }

  const description = profile?.description?.trim();
  if (description) {
    lines.push("");
    lines.push(renderSection("Description"));
    lines.push(description);
  }

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
      return filingDate ? `${filing.form} | ${filingDate}` : filing.form;
    })(),
    meta: [
      filing.items ? `Items ${filing.items}` : "",
      getFilingDescription(filing) ?? "",
      filing.primaryDocument ? `Primary Document ${filing.primaryDocument}` : "",
    ],
    link: filing.filingUrl,
  })));

  if (tickerFile && tickerFile.metadata.positions.length > 0) {
    lines.push("");
    lines.push(renderSection("Positions"));
    for (const [index, position] of tickerFile.metadata.positions.entries()) {
      const portfolioName = config.portfolios.find((portfolio) => portfolio.id === position.portfolio)?.name ?? position.portfolio;
      const multiplier = position.multiplier ?? 1;
      const positionCurrency = position.currency ?? quote.currency;
      const costBasisBase = await toBase(position.shares * position.avgCost * multiplier, positionCurrency);
      const marketValueBase = await toBase(Math.abs(position.shares) * quote.price * multiplier, quote.currency);
      const pnl = marketValueBase - costBasisBase;

      lines.push(cliStyles.bold(`${portfolioName} (${position.broker})`));
      lines.push(renderStat(
        "Position",
        `${formatMarketQuantity(position.shares, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier })} ${multiplier > 1 ? "contracts" : "shares"} @ ${formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier })}`,
      ));
      lines.push(renderStat("Cost Basis", formatCurrency(costBasisBase, config.baseCurrency)));
      lines.push(renderStat("Market Value", formatCurrency(marketValueBase, config.baseCurrency)));
      lines.push(renderStat("P&L", colorBySign(formatSignedCurrency(pnl, config.baseCurrency), pnl)));
      if (position.markPrice != null) {
        lines.push(renderStat("Mark", formatMarketPriceWithCurrency(position.markPrice, positionCurrency, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier })));
      }
      if (index < tickerFile.metadata.positions.length - 1) {
        lines.push(cliStyles.muted("-".repeat(24)));
      }
    }
  }

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
  return {
    symbol,
    quote: quote ? {
      symbol: quote.symbol,
      name: quote.name,
      price: quote.price,
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
    fundamentals: financials.fundamentals,
    profile: financials.profile,
    latestAnnual: financials.annualStatements.at(-1) ?? null,
    latestQuarter: financials.quarterlyStatements.at(-1) ?? null,
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

    if (!financials?.quote) {
      failCommand(`No quote data available for ${normalized}.`);
    }
    const resolvedFinancials = financials as TickerFinancials;
    const quote = resolvedFinancials.quote!;

    const notesFiles = new NotesFiles(dataDir);
    const [notesResult, newsResult, secFilingsResult] = await Promise.allSettled([
      notesFiles.load(normalized),
      dataProvider.getNews({
        feed: "ticker",
        scope: "ticker",
        ticker: normalized,
        exchange: exchange || quote.exchangeName || "",
        tickerTier: "primary",
        limit: NEWS_ITEM_LIMIT,
      }),
      shouldFetchSecFilings(tickerFile, resolvedFinancials) && dataProvider.getSecFilings
        ? dataProvider.getSecFilings(normalized, SEC_FILING_LIMIT, exchange || quote.exchangeName || "")
        : Promise.resolve([]),
    ]);

    const notes = notesResult.status === "fulfilled" ? notesResult.value : "";
    const recentNews = newsResult.status === "fulfilled" ? newsResult.value : [];
    const recentSecFilings = secFilingsResult.status === "fulfilled" ? secFilingsResult.value : [];

    if (dependencies.printResult) {
      dependencies.printResult({
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
