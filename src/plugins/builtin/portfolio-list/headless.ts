import { createBaseConverter } from "../../../cli/base-converter";
import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneRow,
  HeadlessRowsResult,
} from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import {
  findCollection,
  loadCollectionQuotes,
  valuePortfolioAllocation,
  valuePortfolioPositions,
  type CollectionMatch,
} from "./cli/render";
import {
  CASH_SYMBOL,
  describeTargetSum,
  formatAllocationDrift,
  formatAllocationWeight,
  formatTradeUnits,
} from "./allocation";
import { currencyMinorDigits, formatMarketPrice, formatMarketQuantity } from "../../../market-data/market/format";
import { resolvePortfolioTotalsCurrency } from "./summary/totals";
import { quoteFreshnessFields } from "../shared/report-freshness";

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;
/** Collection ids an unknown-name error lists, so the caller can retry with one. */
const LISTED_COLLECTION_IDS = 12;

const amount = (value: unknown) => formatNumber(typeof value === "number" ? value : undefined, 2);
const signedAmount = (value: unknown) => (
  typeof value === "number" && Number.isFinite(value) ? `${value > 0 && /[1-9]/.test(amount(value)) ? "+" : ""}${amount(value)}` : formatNumber(undefined)
);
const percent = (value: unknown) => formatPercentRaw(typeof value === "number" ? value : undefined);
const weight = (value: unknown) => formatAllocationWeight(typeof value === "number" ? value : null);
const drift = (value: unknown) => formatAllocationDrift(typeof value === "number" ? value : null);
const quantity = (value: unknown, row: HeadlessPaneRow) => (
  typeof value === "number" ? formatMarketQuantity(value, { assetCategory: textOf(row.assetCategory) }) : formatNumber(undefined)
);
const tradeUnits = (value: unknown, row: HeadlessPaneRow) => (
  typeof value === "number" ? formatTradeUnits(value, { units: finite(row.shares) ?? 0, assetCategory: textOf(row.assetCategory) }) : formatNumber(undefined)
);
/** Money per unit at the currency's minor digits: $230.00, not 230. */
const unitMoney = (currencyKey: string) => (value: unknown, row: HeadlessPaneRow) => (
  typeof value === "number"
    ? formatMarketPrice(value, { assetCategory: textOf(row.assetCategory), minimumFractionDigits: Math.min(2, currencyMinorDigits(textOf(row[currencyKey]))) })
    : formatNumber(undefined)
);

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const POSITION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "shares", header: "Qty", align: "right", format: quantity },
  { key: "avgCost", header: "Avg Cost", align: "right", format: unitMoney("positionCurrency"), description: "Per unit, in the position's currency." },
  { key: "price", header: "Last", align: "right", format: unitMoney("priceCurrency"), description: "In the quote's currency." },
  { key: "priceCurrency", header: "Ccy" },
  { key: "changePercent", header: "Chg", align: "right", format: percent },
  { key: "marketValue", header: "Mkt Val", align: "right", format: amount, description: "In the portfolio's currency; negative for shorts." },
  { key: "unrealizedPnl", header: "P&L", align: "right", format: amount, description: "Unrealized, in the portfolio's currency." },
  { key: "weight", header: "Weight", align: "right", format: weight, description: "Percent of the total value, cash included; unpriced holdings are left out." },
];

/** Shown once the portfolio has a target weight. */
const TARGET_COLUMNS: HeadlessPaneColumn[] = [
  { key: "targetWeight", header: "Target", align: "right", format: weight, description: "Target weight, in percent." },
  { key: "drift", header: "Drift", align: "right", format: drift, description: "Weight minus target, in percentage points." },
  { key: "tradeShares", header: "Trade", align: "right", format: tradeUnits, description: "Units to buy (+) or sell (-) to reach the target at the current price." },
  { key: "tradeValue", header: "Trade Value", align: "right", format: signedAmount, description: "The trade in the portfolio's currency." },
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
  const toBase = createBaseConverter(ctx.marketData, currency);
  const valuation = await valuePortfolioPositions({
    tickers,
    quotes,
    portfolioId: target.id,
    currency,
    baseCurrency: ctx.config.baseCurrency,
    toBase,
  });
  const { allocation, cash } = await valuePortfolioAllocation({ valuation, portfolio: resolved.portfolio, account: resolved.account, toBase });
  ctx.signal.throwIfAborted();

  const allocationBySymbol = new Map(allocation.rows.map((row) => [row.symbol, row]));
  const held = valuation.positions.filter((entry) => entry.position);
  const gross = held.reduce((sum, entry) => sum + Math.abs(finite(entry.row.marketValue) ?? 0), 0);
  const sum = (key: string) => held.reduce((total, entry) => total + (finite(entry.row[key]) ?? 0), 0);
  const seen = new Set<string>();
  const rows = held
    .map(({ ticker, activeQuote, row }) => {
      const marketValue = finite(row.marketValue);
      // A ticker held in several lots carries its allocation on its first row.
      const figures = seen.has(ticker.metadata.ticker) ? undefined : allocationBySymbol.get(ticker.metadata.ticker);
      seen.add(ticker.metadata.ticker);
      return {
        ...quoteFreshnessFields(quotes.get(ticker.metadata.ticker)),
        updatedAt: quotes.get(ticker.metadata.ticker)?.lastUpdated ?? null,
        symbol: ticker.metadata.ticker,
        name: ticker.metadata.name ?? null,
        exchange: ticker.metadata.exchange || null,
        assetCategory: ticker.metadata.assetCategory ?? null,
        shares: finite(row.shares),
        avgCost: finite(row.avgCost),
        positionCurrency: row.positionCurrency ?? null,
        price: finite(row.quotePrice),
        priceCurrency: row.quoteCurrency ?? null,
        changePercent: finite(activeQuote?.changePercent),
        marketValue,
        unrealizedPnl: finite(row.unrealizedPnl),
        weight: figures?.weight ?? null,
        targetWeight: figures?.targetWeight ?? null,
        drift: figures?.drift ?? null,
        tradeShares: figures?.tradeUnits ?? null,
        tradeValue: figures?.tradeValue ?? null,
      };
    })
    // Largest exposure first; a position without a market value sorts last.
    .sort((left, right) => (
      exposure(right.marketValue) - exposure(left.marketValue)
      || left.symbol.localeCompare(right.symbol)
    ));
  const shown: HeadlessPaneRow[] = rows.slice(0, limit);
  // The cash line follows the positions, whatever the limit.
  if (allocation.cash) {
    shown.push({
      symbol: CASH_SYMBOL,
      name: cash?.source === "broker" ? "Cash (broker account)" : "Cash",
      priceCurrency: cash?.currency ?? null,
      marketValue: finite(allocation.cash.value),
      weight: allocation.cash.weight,
      targetWeight: allocation.cash.targetWeight,
      drift: allocation.cash.drift,
      tradeShares: null,
      tradeValue: allocation.cash.tradeValue,
    });
  }
  const unavailable = [...new Set([...valuation.unavailableMarketValue, ...valuation.unavailablePnl])];
  const broker = !!(target.portfolio.brokerId || target.portfolio.brokerInstanceId);
  const showTargets = allocation.targetSum != null;
  const targetNote = describeTargetSum(allocation.targetSum);
  const notices = [
    ...(rows.length > limit
      ? [`${rows.length - limit} more position${rows.length - limit === 1 ? "" : "s"} not shown; totals include every position.`]
      : []),
    ...(targetNote ? [targetNote] : []),
  ];

  return {
    freshness: { source: broker ? "Your broker account and Gloom Cloud" : "Local portfolio and Gloom Cloud" },
    columns: showTargets ? [...POSITION_COLUMNS, ...TARGET_COLUMNS] : POSITION_COLUMNS,
    rows: shown,
    complete: unavailable.length === 0,
    ...(unavailable.length
      ? { errors: [`No market value or P&L for ${unavailable.join(", ")}; totals and weights leave them out.`] }
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
        cash: allocation.cash ? finite(allocation.cash.value) : null,
        total: allocation.total,
      },
      ...(cash ? { cash } : {}),
      ...(showTargets ? { targetSum: allocation.targetSum } : {}),
      unpricedCount: allocation.unpriced.length,
      ...(notices.length > 0 ? { notices } : {}),
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
      ...quoteFreshnessFields(quote),
      updatedAt: quote?.lastUpdated ?? null,
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
    freshness: { source: "Local watchlist and Gloom Cloud" },
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
    "Positions held in a portfolio, broker or manual: symbol, quantity, average cost, last price, market value, unrealized P&L and weight of the total with cash, largest first, then the cash line and totals. With target weights set, each row adds its target, drift and the trade to reach it. For a watchlist, its tickers with quotes. Takes a portfolio or watchlist ID; the first portfolio when omitted.",
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
