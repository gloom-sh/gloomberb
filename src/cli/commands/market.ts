import type { CliCommandDef } from "../../types/plugin";
import { TIME_RANGES, type TimeRange } from "../../time-series/range";
import type { EarningsEvent, QuoteBatchResult, SecFilingItem } from "../../types/data-provider";
import type { NewsArticle, NewsFeed, NewsQuery } from "../../news/types";
import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  OptionsChain,
  PricePoint,
  TickerFinancials,
} from "../../types/financials";
import { formatMarketPriceWithCurrency } from "../../market-data/market/format";
import { formatCompact } from "../../utils/format";
import { withCliServices, withMarketData } from "../context";
import { isoDate, parsePositiveInt, requireArg, takeOption } from "./command-utils";

const VALID_RANGES = new Set<TimeRange>(TIME_RANGES);
const VALID_NEWS_FEEDS = new Set<NewsFeed>(["latest", "top", "breaking", "ticker", "sector", "topic"]);

type QuoteCliRecord = Omit<QuoteBatchResult, "error"> & { error: string | null };
type FinancialsCliData = TickerFinancials & {
  symbol: string;
  exchange: string;
  providerId: string | null;
};

function parseRange(value: string | undefined): TimeRange {
  const range = (value ?? "1Y").toUpperCase() as TimeRange;
  return VALID_RANGES.has(range) ? range : "1Y";
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

function quoteColumns() {
  return [
    { key: "symbol", header: "Symbol" },
    { key: "name", header: "Name" },
    { key: "price", header: "Last", align: "right" as const },
    { key: "changePercent", header: "Chg%", align: "right" as const },
    { key: "currency", header: "Cur" },
    { key: "source", header: "Source" },
    { key: "updatedAt", header: "Updated" },
  ];
}

function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  return error instanceof Error ? error.message : String(error);
}

function quoteRows(results: QuoteCliRecord[]) {
  return results.map((result) => {
    const quote = result.quote;
    return {
      symbol: result.target.symbol,
      name: quote?.name ?? "",
      price: quote ? formatMarketPriceWithCurrency(quote.price, quote.currency) : "",
      rawPrice: quote?.price ?? null,
      change: quote?.change ?? null,
      changePercent: quote?.changePercent == null ? null : Number(quote.changePercent.toFixed(2)),
      currency: quote?.currency ?? "",
      providerId: quote?.providerId ?? "",
      source: quote?.dataSource ?? quote?.providerId ?? "",
      updatedAt: quote?.lastUpdated ? new Date(quote.lastUpdated).toISOString() : "",
      error: result.error ?? "",
    };
  });
}

function historyRows(points: PricePoint[]) {
  return points.map((point) => ({
    date: isoDate(point.date).slice(0, 10),
    open: point.open ?? null,
    high: point.high ?? null,
    low: point.low ?? null,
    close: point.close,
    volume: point.volume ?? null,
  }));
}

function financialStatementRows(financials: FinancialsCliData) {
  return financials.annualStatements.slice(0, 8).map((statement) => ({
    date: statement.date,
    revenue: statement.totalRevenue ?? statement.operatingRevenue ?? null,
    grossProfit: statement.grossProfit ?? null,
    operatingIncome: statement.operatingIncome ?? null,
    netIncome: statement.netIncome ?? statement.netIncomeCommonStockholders ?? null,
    eps: statement.eps ?? statement.basicEps ?? null,
  }));
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

function corporateActionRows(data: CorporateActionsData) {
  return [
    ...data.earnings.map((event) => ({
      type: "earnings",
      date: event.date,
      detail: event.epsActual == null ? `est ${event.epsEstimate ?? ""}` : `eps ${event.epsActual}`,
    })),
    ...data.dividends.map((event) => ({
      type: "dividend",
      date: event.exDate,
      detail: String(event.amount),
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

async function runQuote(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbols = normalizeSymbols(args);
  if (symbols.length === 0) ctx.fail("Usage: gloomberb quote <symbol...>");

  await withMarketData(ctx, async (market) => {
    const results = await market.dataProvider.getQuotesBatch(
      symbols.map((symbol) => ({ symbol, exchange })),
      { forceRefresh: ctx.cliOptions.refresh },
    );
    const data = results.map((result) => ({
      target: result.target,
      quote: result.quote,
      error: errorMessage(result.error),
    }));
    ctx.printResult({ data }, { rows: quoteRows, columns: quoteColumns() });
  });
}

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const range = parseRange(takeOption(args, "--range"));
  const requestedExchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb history <symbol> [--range 1Y]", ctx);
  await withMarketData(ctx, async (market) => {
    const localTicker = requestedExchange ? null : await market.store.loadTicker(symbol);
    const exchange = requestedExchange || localTicker?.metadata.exchange || "";
    const points = await market.dataProvider.getPriceHistory(symbol, exchange, range);
    const data = historyRows(points);
    ctx.printResult({ data, metadata: { symbol, range, exchange } }, {
      columns: [
        { key: "date", header: "Date" },
        { key: "open", header: "Open", align: "right" },
        { key: "high", header: "High", align: "right" },
        { key: "low", header: "Low", align: "right" },
        { key: "close", header: "Close", align: "right" },
        { key: "volume", header: "Volume", align: "right" },
      ],
    });
  });
}

async function runFinancials(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], fundamentalsOnly = false) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), fundamentalsOnly ? "Usage: gloomberb fundamentals <symbol>" : "Usage: gloomberb financials <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const financials = await market.dataProvider.getTickerFinancials(symbol, exchange, {
      cacheMode: ctx.cliOptions.refresh ? "refresh" : "default",
    });
    const data: FinancialsCliData = {
      symbol,
      exchange,
      providerId: financials.quote?.providerId ?? null,
      ...financials,
    };
    if (fundamentalsOnly) {
      ctx.printResult({ data });
      return;
    }
    ctx.printResult({
      data,
      metadata: {
        symbol,
        providerId: financials.quote?.providerId,
        annualStatements: financials.annualStatements.length,
        quarterlyStatements: financials.quarterlyStatements.length,
        fundamentals: financials.fundamentals,
        profile: financials.profile,
      },
    }, {
      rows: financialStatementRows,
      columns: [
        { key: "date", header: "Date" },
        { key: "revenue", header: "Revenue", align: "right", value: (row) => row.revenue == null ? "" : formatCompact(Number(row.revenue)) },
        { key: "grossProfit", header: "Gross", align: "right", value: (row) => row.grossProfit == null ? "" : formatCompact(Number(row.grossProfit)) },
        { key: "operatingIncome", header: "Op Inc", align: "right", value: (row) => row.operatingIncome == null ? "" : formatCompact(Number(row.operatingIncome)) },
        { key: "netIncome", header: "Net Inc", align: "right", value: (row) => row.netIncome == null ? "" : formatCompact(Number(row.netIncome)) },
        { key: "eps", header: "EPS", align: "right" },
      ],
    });
  });
}

async function runNews(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const feed = parseNewsFeed(takeOption(args, "--feed"));
  const ticker = args[0]?.toUpperCase();
  await withMarketData(ctx, async (market) => {
    const limit = ctx.cliOptions.limit ?? 20;
    const articles = await market.dataProvider.getNews({
      feed: feed ?? (ticker ? "ticker" : "latest"),
      scope: ticker ? "ticker" : "global",
      ticker,
      limit,
    });
    ctx.printResult({ data: articles, metadata: { ticker: ticker ?? null, feed: feed ?? null } }, {
      rows: newsRows,
      columns: [
        { key: "publishedAt", header: "Published" },
        { key: "source", header: "Source" },
        { key: "title", header: "Title" },
        { key: "tickers", header: "Tickers" },
        { key: "url", header: "URL" },
      ],
    });
  });
}

async function runFilings(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const count = parsePositiveInt(takeOption(args, "--count"), ctx.cliOptions.limit ?? 15, "Count", ctx);
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb filings <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const filings = await market.dataProvider.getSecFilings(symbol, count, exchange);
    ctx.printResult({ data: filings, metadata: { symbol } }, {
      rows: filingRows,
      columns: [
        { key: "filingDate", header: "Date" },
        { key: "form", header: "Form" },
        { key: "companyName", header: "Company" },
        { key: "url", header: "URL" },
      ],
    });
  });
}

async function runHolders(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], ownerTypes?: Set<string>) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb holders <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const data = await market.dataProvider.getHolders(symbol, exchange);
    ctx.printResult({ data, metadata: { symbol, summary: data.summary } }, {
      rows: (holderData) => holderRows(holderData, ownerTypes),
      columns: [
        { key: "type", header: "Type" },
        { key: "name", header: "Holder" },
        { key: "reportDate", header: "Date" },
        { key: "shares", header: "Shares", align: "right" },
        { key: "value", header: "Value", align: "right", value: (row) => row.value == null ? "" : formatCompact(Number(row.value)) },
        { key: "percentHeld", header: "% Held", align: "right" },
      ],
    });
  });
}

async function runAnalyst(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb analyst <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const data = await market.dataProvider.getAnalystResearch(symbol, exchange);
    ctx.printResult({
      data,
      metadata: {
        symbol,
        recommendationRating: data.recommendationRating,
        priceTarget: data.priceTarget,
        recommendations: data.recommendations,
      },
    }, {
      rows: analystRows,
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
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb events <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const data = await market.dataProvider.getCorporateActions(symbol, exchange);
    ctx.printResult({ data, metadata: { symbol } }, {
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
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb options <symbol>", ctx);
  await withMarketData(ctx, async (market) => {
    const chain = await market.dataProvider.getOptionsChain(
      symbol,
      exchange,
      expiration == null ? undefined : Number(expiration),
    );
    ctx.printResult({ data: chain, metadata: { symbol, expirations: chain.expirationDates } }, {
      rows: optionRows,
      columns: [
        { key: "side", header: "Side" },
        { key: "contract", header: "Contract" },
        { key: "expiration", header: "Expiry" },
        { key: "strike", header: "Strike", align: "right" },
        { key: "last", header: "Last", align: "right" },
        { key: "bid", header: "Bid", align: "right" },
        { key: "ask", header: "Ask", align: "right" },
        { key: "volume", header: "Vol", align: "right" },
        { key: "openInterest", header: "OI", align: "right" },
      ],
    });
  });
}

async function runFx(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const currency = requireArg(rawArgs[0]?.toUpperCase(), "Usage: gloomberb fx <currency>", ctx);
  await withMarketData(ctx, async (market) => {
    const rate = await market.dataProvider.getExchangeRate(currency);
    ctx.printResult({ data: [{ currency, baseCurrency: market.config.baseCurrency, rate }] }, {
      columns: [
        { key: "currency", header: "Currency" },
        { key: "baseCurrency", header: "Base" },
        { key: "rate", header: "Rate", align: "right" },
      ],
    });
  });
}

async function runEarnings(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const symbols = normalizeSymbols([...rawArgs]);
  if (symbols.length === 0) ctx.fail("Usage: gloomberb earnings <symbol...>");
  await withCliServices(ctx, async (services) => {
    const events = await services.dataProvider.getEarningsCalendar(symbols);
    ctx.printResult({ data: events }, {
      rows: earningsRows,
      columns: [
        { key: "date", header: "Date" },
        { key: "symbol", header: "Symbol" },
        { key: "name", header: "Name" },
        { key: "timing", header: "Timing" },
        { key: "epsEstimate", header: "EPS Est", align: "right" },
        { key: "epsActual", header: "EPS", align: "right" },
      ],
    });
  });
}

export const marketDataCliCommands: CliCommandDef[] = [
  { name: "quote", description: "Fetch one or more quotes", help: { usage: ["quote <symbol...>"] }, execute: runQuote },
  { name: "provider-search", description: "Search provider instruments", help: { usage: ["provider-search <query>"] }, execute: async (args, ctx) => {
    const query = args.join(" ");
    if (!query) ctx.fail("Usage: gloomberb provider-search <query>");
    await withMarketData(ctx, async (market) => {
      const results = await market.dataProvider.search(query);
      ctx.printResult({ data: results.slice(0, ctx.cliOptions.limit ?? results.length) });
    });
  } },
  { name: "history", description: "Fetch historical prices", help: { usage: ["history <symbol> [--range 1Y]"] }, execute: runHistory },
  { name: "financials", description: "Fetch annual financial statements", help: { usage: ["financials <symbol>"] }, execute: (args, ctx) => runFinancials(args, ctx, false) },
  { name: "fundamentals", description: "Fetch fundamentals and profile data", help: { usage: ["fundamentals <symbol>"] }, execute: (args, ctx) => runFinancials(args, ctx, true) },
  { name: "news", description: "Fetch market or ticker news", help: { usage: ["news [symbol] [--feed latest|top|ticker]"] }, execute: runNews },
  { name: "filings", description: "Fetch SEC filings", help: { usage: ["filings <symbol>"] }, execute: runFilings },
  { name: "holders", description: "Fetch holder data", help: { usage: ["holders <symbol>"] }, execute: (args, ctx) => runHolders(args, ctx) },
  { name: "insider", description: "Fetch insider holder rows", help: { usage: ["insider <symbol>"] }, execute: (args, ctx) => runHolders(args, ctx, new Set(["insider", "direct"])) },
  { name: "13f", description: "Fetch institutional and fund holder rows", help: { usage: ["13f <symbol>"] }, execute: (args, ctx) => runHolders(args, ctx, new Set(["institution", "fund"])) },
  { name: "analyst", description: "Fetch analyst research and ratings", help: { usage: ["analyst <symbol>"] }, execute: runAnalyst },
  { name: "events", description: "Fetch dividends, splits, and earnings events", help: { usage: ["events <symbol>"] }, execute: runEvents },
  { name: "valuation", description: "Fetch valuation-related fundamentals", help: { usage: ["valuation <symbol>"] }, execute: (args, ctx) => runFinancials(args, ctx, true) },
  { name: "options", description: "Fetch options chain rows", help: { usage: ["options <symbol> [--expiration unix]"] }, execute: runOptions },
  { name: "compare", description: "Compare quotes for several symbols", help: { usage: ["compare <symbol...>"] }, execute: runQuote },
  { name: "fx", description: "Fetch exchange rate into the configured base currency", help: { usage: ["fx <currency>"] }, execute: runFx },
  { name: "earnings", description: "Fetch earnings calendar entries for symbols", help: { usage: ["earnings <symbol...>"] }, execute: runEarnings },
];
