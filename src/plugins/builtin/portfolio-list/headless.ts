import { createBaseConverter } from "../../../cli/base-converter";
import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessRowsResult,
} from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import {
  findCollection,
  loadCollectionQuotes,
  valuePortfolioPositions,
  type CollectionMatch,
} from "./cli/render";
import { resolvePortfolioTotalsCurrency } from "./summary/totals";

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;
/** Collection ids an unknown-name error lists, so the caller can retry with one. */
const LISTED_COLLECTION_IDS = 12;

const amount = (value: unknown) => formatNumber(typeof value === "number" ? value : undefined, 2);
const percent = (value: unknown) => formatPercentRaw(typeof value === "number" ? value : undefined);
const share = (value: unknown) => (
  typeof value === "number" && Number.isFinite(value) ? `${formatNumber(value, 2)}%` : formatNumber(undefined)
);

const POSITION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "shares", header: "Qty", align: "right" },
  { key: "avgCost", header: "Avg Cost", align: "right", description: "Per unit, in the position's currency." },
  { key: "price", header: "Last", align: "right", description: "In the quote's currency." },
  { key: "priceCurrency", header: "Ccy" },
  { key: "changePercent", header: "Chg", align: "right", format: percent },
  { key: "marketValue", header: "Mkt Val", align: "right", format: amount, description: "In the portfolio's currency; negative for shorts." },
  { key: "unrealizedPnl", header: "P&L", align: "right", format: amount, description: "Unrealized, in the portfolio's currency." },
  { key: "weight", header: "Weight", align: "right", format: share, description: "Percent of the portfolio's gross market value." },
];

const WATCHLIST_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "exchange", header: "Exchange" },
  { key: "price", header: "Last", align: "right" },
  { key: "priceCurrency", header: "Ccy" },
  { key: "changePercent", header: "Chg", align: "right", format: percent },
];

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function exposure(marketValue: number | null): number {
  return marketValue == null ? -1 : Math.abs(marketValue);
}

function rowLimit(value: unknown): number {
  const limit = Math.trunc(Number(value ?? DEFAULT_ROW_LIMIT));
  return Number.isFinite(limit) ? Math.min(MAX_ROW_LIMIT, Math.max(1, limit)) : DEFAULT_ROW_LIMIT;
}

function bySymbol(left: TickerRecord, right: TickerRecord): number {
  return left.metadata.ticker.localeCompare(right.metadata.ticker);
}

function resolveTarget(rawArgument: string, ctx: HeadlessPaneContext): CollectionMatch {
  const config = ctx.config;
  const raw = rawArgument.trim();
  if (!raw) {
    const portfolio = config.portfolios[0];
    if (portfolio) return { kind: "portfolio", id: portfolio.id, name: portfolio.name, portfolio };
    const watchlist = config.watchlists[0];
    if (watchlist) return { kind: "watchlist", id: watchlist.id, name: watchlist.name };
    throw new Error("No portfolios or watchlists are set up.");
  }
  const match = findCollection(config, raw);
  if (match) return match;
  const ids = [...config.portfolios, ...config.watchlists].map(({ id }) => id);
  const listed = ids.slice(0, LISTED_COLLECTION_IDS).join(", ");
  throw new Error(
    ids.length
      ? `Unknown portfolio or watchlist "${raw}". IDs: ${listed}${ids.length > LISTED_COLLECTION_IDS ? ` and ${ids.length - LISTED_COLLECTION_IDS} more` : ""}.`
      : `Unknown portfolio or watchlist "${raw}". No portfolios or watchlists are set up.`,
  );
}

async function portfolioHoldings(
  target: Extract<CollectionMatch, { kind: "portfolio" }>,
  limit: number,
  ctx: HeadlessPaneContext,
): Promise<HeadlessRowsResult> {
  const resolved = await ctx.resolvePortfolio?.(target.id);
  if (!resolved) throw new Error(`Holdings for ${target.id} are not available here.`);
  const tickers = [...resolved.tickers].sort(bySymbol);
  const currency = resolvePortfolioTotalsCurrency(target.portfolio, ctx.config.baseCurrency);
  const quotes = await loadCollectionQuotes(tickers, target, ctx.marketData);
  ctx.signal.throwIfAborted();
  const valuation = await valuePortfolioPositions({
    tickers,
    quotes,
    portfolioId: target.id,
    currency,
    baseCurrency: ctx.config.baseCurrency,
    toBase: createBaseConverter(ctx.marketData, currency),
  });
  ctx.signal.throwIfAborted();

  const held = valuation.positions.filter((entry) => entry.position);
  const gross = held.reduce((sum, entry) => sum + Math.abs(finite(entry.row.marketValue) ?? 0), 0);
  const sum = (key: string) => held.reduce((total, entry) => total + (finite(entry.row[key]) ?? 0), 0);
  const rows = held
    .map(({ ticker, activeQuote, row }) => {
      const marketValue = finite(row.marketValue);
      return {
        symbol: ticker.metadata.ticker,
        name: ticker.metadata.name ?? null,
        exchange: ticker.metadata.exchange || null,
        shares: finite(row.shares),
        avgCost: finite(row.avgCost),
        positionCurrency: row.positionCurrency ?? null,
        price: finite(row.quotePrice),
        priceCurrency: row.quoteCurrency ?? null,
        changePercent: finite(activeQuote?.changePercent),
        marketValue,
        unrealizedPnl: finite(row.unrealizedPnl),
        weight: marketValue != null && gross > 0 ? (Math.abs(marketValue) / gross) * 100 : null,
      };
    })
    // Largest exposure first; a position without a market value sorts last.
    .sort((left, right) => (
      exposure(right.marketValue) - exposure(left.marketValue)
      || left.symbol.localeCompare(right.symbol)
    ));
  const shown = rows.slice(0, limit);
  const unavailable = [...new Set([...valuation.unavailableMarketValue, ...valuation.unavailablePnl])];
  const broker = !!(target.portfolio.brokerId || target.portfolio.brokerInstanceId);

  return {
    columns: POSITION_COLUMNS,
    rows: shown,
    complete: unavailable.length === 0,
    ...(unavailable.length
      ? { errors: [`No market value or P&L for ${unavailable.join(", ")}; totals leave them out.`] }
      : {}),
    metadata: {
      collection: { kind: "portfolio", id: target.id, name: target.name, broker },
      currency,
      positions: rows.length,
      totals: {
        marketValue: sum("marketValue"),
        grossMarketValue: gross,
        costBasis: sum("costBasis"),
        unrealizedPnl: valuation.totalPnl,
      },
      ...(rows.length > shown.length
        ? { notices: [`${rows.length - shown.length} more position${rows.length - shown.length === 1 ? "" : "s"} not shown; totals include every position.`] }
        : {}),
    },
  };
}

async function watchlistHoldings(
  target: Extract<CollectionMatch, { kind: "watchlist" }>,
  limit: number,
  ctx: HeadlessPaneContext,
): Promise<HeadlessRowsResult> {
  const members = await ctx.resolveWatchlist?.(target.id);
  if (!members) throw new Error(`Watchlist ${target.id} is not available here.`);
  const tickers = [...members].sort(bySymbol);
  const quotes = await loadCollectionQuotes(tickers, target, ctx.marketData);
  ctx.signal.throwIfAborted();
  const rows = tickers.map((ticker) => {
    const quote = quotes.get(ticker.metadata.ticker);
    return {
      symbol: ticker.metadata.ticker,
      name: ticker.metadata.name ?? null,
      exchange: ticker.metadata.exchange || null,
      price: finite(quote?.price),
      priceCurrency: quote?.currency ?? null,
      changePercent: finite(quote?.changePercent),
    };
  });
  const shown = rows.slice(0, limit);
  return {
    columns: WATCHLIST_COLUMNS,
    rows: shown,
    metadata: {
      collection: { kind: "watchlist", id: target.id, name: target.name },
      tickers: rows.length,
      ...(rows.length > shown.length
        ? { notices: [`${rows.length - shown.length} more ticker${rows.length - shown.length === 1 ? "" : "s"} not shown.`] }
        : {}),
    },
  };
}

/**
 * PF as a report: the positions of a portfolio, broker or manual, valued as
 * `portfolio show` values them, or the tickers of a watchlist with their
 * quotes. Rows are bounded; totals always cover every position.
 */
export const collectionHoldingsHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  description:
    "Positions held in a portfolio, broker or manual: symbol, quantity, average cost, last price, market value, unrealized P&L and weight, largest first, with totals. For a watchlist, its tickers with quotes. Takes a portfolio or watchlist ID; the first portfolio when omitted.",
  discovery: {
    dataRequirements: ["Local portfolios, watchlists and synced broker positions; current quotes"],
    limitations: ["Unrealized P&L on current positions; excludes realized trades, distributions and cash flows"],
  },
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "portfolio-or-watchlist",
    description: "Portfolio or watchlist ID or name. Leave it out for the first portfolio.",
  },
  options: [
    {
      key: "limit",
      type: "integer",
      defaultValue: DEFAULT_ROW_LIMIT,
      minimum: 1,
      maximum: MAX_ROW_LIMIT,
      description: "Largest positions, or first tickers, to list. Totals cover all of them.",
    },
  ],
  columns: POSITION_COLUMNS,
  describe: (args) => (args.rawArgument ? `Holdings | ${args.rawArgument}` : "Holdings"),
  async load(args, ctx) {
    const target = resolveTarget(args.rawArgument, ctx);
    const limit = rowLimit(args.options.limit);
    return target.kind === "portfolio"
      ? portfolioHoldings(target, limit, ctx)
      : watchlistHoldings(target, limit, ctx);
  },
};
