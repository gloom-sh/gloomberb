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
import { formatMarketPriceWithCurrency, quoteFormatOptions } from "../../market-data/market/format";
import { getActiveQuoteDisplay, marketStateLabel } from "../../market-data/market/status";
import { formatCompact } from "../../utils/format";
import { withCliServices, withMarketData } from "../context";
import { isoDate, parsePositiveInt, requireArg, takeOption } from "./command-utils";
import { CLI_COMMAND_GROUPS } from "../help";
import {
  formatChangePercentCell,
  formatCountCell,
  formatFractionPercentCell,
} from "../helpers";
import { cliStyles } from "../../utils/cli-output";
import { renderFundamentalsReport } from "./ticker";

const VALID_RANGES = new Set<TimeRange>(TIME_RANGES);
const EXCHANGE_OPTION = {
  flags: "--exchange <code>",
  description: "Listing exchange, for a symbol that trades in several places",
};
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
    { key: "source", header: "Source" },
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
    const options = { ...quoteFormatOptions(quote), minimumFractionDigits: 2 };
    const price = (value: number | undefined) => (
      quote && value != null ? formatMarketPriceWithCurrency(value, quote.currency, options) : ""
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
      dayRange: quote?.low != null && quote.high != null ? `${price(quote.low)}-${price(quote.high)}` : "",
      volume: quote?.volume ?? null,
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

async function runQuote(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], commandName: "quote" | "compare") {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbols = normalizeSymbols(args);
  if (symbols.length === 0) ctx.fail(`Usage: gloomberb ${commandName} <symbol...>`);

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
    ctx.printResult({ data }, { rows: quoteRows, columns: commandName === "compare" ? compareColumns() : quoteColumns() });
  });
}

async function runHistory(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const range = parseRange(takeOption(args, "--range"));
  const requestedExchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb history <symbol> [--range <range>]", ctx);
  await withMarketData(ctx, async (market) => {
    const localTicker = requestedExchange ? null : await market.store.loadTicker(symbol);
    const exchange = requestedExchange || localTicker?.metadata.exchange || "";
    const points = await market.dataProvider.getPriceHistory(symbol, exchange, range, {
      cacheMode: ctx.cliOptions.refresh ? "refresh" : "default",
    });
    const data = historyRows(points);
    ctx.printResult({ data, metadata: { symbol, range, exchange } }, {
      columns: [
        { key: "date", header: "Date" },
        { key: "open", header: "Open", align: "right" },
        { key: "high", header: "High", align: "right" },
        { key: "low", header: "Low", align: "right" },
        { key: "close", header: "Close", align: "right" },
        { key: "volume", header: "Volume", align: "right", format: formatCountCell },
      ],
    });
  });
}

type FinancialsView = "statements" | "fundamentals" | "valuation";

async function runFinancials(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1], view: FinancialsView) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const commandName = view === "statements" ? "financials" : view;
  const symbol = requireArg(args[0]?.toUpperCase(), `Usage: gloomberb ${commandName} <symbol>`, ctx);
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
    if (view !== "statements") {
      ctx.printResult({ data }, { text: (financialsData) => renderFundamentalsReport(financialsData, view) });
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
        { key: "source", header: "Source", maxWidth: 20 },
        { key: "title", header: "Title" },
        { key: "tickers", header: "Tickers", maxWidth: 16 },
        { key: "url", header: "URL", optional: true },
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
        { key: "companyName", header: "Company", maxWidth: 24 },
        { key: "url", header: "URL", optional: true },
      ],
    });
  });
}

async function runHolders(
  rawArgs: string[],
  ctx: Parameters<CliCommandDef["execute"]>[1],
  commandName: string,
  ownerTypes?: Set<string>,
) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange") ?? "";
  const symbol = requireArg(args[0]?.toUpperCase(), `Usage: gloomberb ${commandName} <symbol>`, ctx);
  await withMarketData(ctx, async (market) => {
    const data = await market.dataProvider.getHolders(symbol, exchange);
    ctx.printResult({ data, metadata: { symbol, summary: data.summary } }, {
      rows: (holderData) => holderRows(holderData, ownerTypes),
      columns: [
        { key: "type", header: "Type" },
        { key: "name", header: "Holder" },
        { key: "reportDate", header: "Date" },
        { key: "shares", header: "Shares", align: "right", format: formatCountCell },
        { key: "value", header: "Value", align: "right", value: (row) => row.value == null ? "" : formatCompact(Number(row.value)) },
        { key: "percentHeld", header: "% Held", align: "right", format: formatFractionPercentCell },
      ],
      empty: `No holders reported for ${symbol}.`,
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
  const symbol = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb options <symbol> [--expiration <unix>]", ctx);
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
        { key: "contract", header: "Contract", shrink: false },
        { key: "expiration", header: "Expiry" },
        { key: "strike", header: "Strike", align: "right" },
        { key: "last", header: "Last", align: "right" },
        { key: "bid", header: "Bid", align: "right" },
        { key: "ask", header: "Ask", align: "right" },
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
          format: (value: unknown, row: { stale: boolean }) => (
            row.stale ? cliStyles.warning(`${value ?? ""} stale`.trim()) : String(value ?? "")
          ),
        }] : []),
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
  {
    name: "quote",
    description: "Show the latest price for one or more symbols",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["quote <symbol...>"],
      options: [EXCHANGE_OPTION],
      examples: ["quote AAPL MSFT NVDA", "quote BTC-USD EURUSD=X", "quote AAPL --json"],
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
      examples: ["compare KO PEP", "compare SPY QQQ IWM --csv"],
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
      examples: ["history AAPL", "history AAPL --range 5Y --csv > aapl.csv"],
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
      examples: ["options AAPL", "options AAPL --json"],
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
      examples: ["financials MSFT", "financials MSFT --json"],
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
      examples: ["fundamentals NVDA"],
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
      examples: ["valuation NVDA"],
    },
    execute: (args, ctx) => runFinancials(args, ctx, "valuation"),
  },
  {
    name: "earnings",
    description: "Show upcoming and recent earnings dates",
    help: {
      group: CLI_COMMAND_GROUPS.companyData,
      usage: ["earnings <symbol...>"],
      examples: ["earnings AAPL MSFT GOOGL"],
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
      examples: ["events KO"],
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
      examples: ["analyst TSLA"],
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
      examples: ["holders AAPL"],
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
      examples: ["insider NVDA"],
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
      examples: ["13f AAPL"],
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
      examples: ["filings AAPL", "filings AAPL --count 40 --json"],
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
      ],
      examples: ["news", "news TSLA", "news --feed top --limit 10"],
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
