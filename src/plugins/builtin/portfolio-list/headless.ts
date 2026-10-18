import { createBaseConverter } from "../../../cli/base-converter";
import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneRow,
  HeadlessRowsResult,
} from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import type { Quote } from "../../../types/financials";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import {
  collectionQuoteHeadline,
  dayMoveLine,
  extendedQuoteFields,
  extendedSessionsOf,
  findCollection,
  listingLabel,
  loadCollectionQuotes,
  portfolioDayMove,
  valuationTimeText,
  valuePortfolioAllocation,
  valuePortfolioPositions,
  type CollectionMatch,
} from "./cli/render";
import { VALUATION_BASIS_LABELS, type PortfolioValuationBasis } from "../../../portfolio/valuation-basis";
import { EXTENDED_SESSION_LABELS, quoteHeadlineTime, type ExtendedSession } from "../../../market-data/market/status";
import {
  BROKER_ACCOUNT_MISSING_NOTE,
  CASH_SYMBOL,
  describeTargetSum,
  formatAllocationDrift,
  formatAllocationWeight,
  formatTradeUnits,
} from "../../../portfolio/allocation";
import { currencyPriceMinDigits, formatMarketPrice, formatMarketQuantity } from "../../../market-data/market/format";
import { resolvePortfolioTotalsCurrency } from "./summary/totals";
import { quoteFreshnessFields } from "../shared/report-freshness";
import { importedFromText } from "./imported-from";
import { describeCollections } from "../../../portfolio/collection-name";
import { currentListingName } from "../../../tickers/listing-name";
import { REPORT_ROWS } from "../shared/headless-options";

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;

const amount = (value: unknown) => formatNumber(typeof value === "number" ? value : undefined, 2);
/** Market values and trades in whole units, as `portfolio show` prints them. */
const wholeAmount = (value: unknown) => formatNumber(typeof value === "number" ? value : undefined, 0);
const signedAmount = (value: unknown) => (
  typeof value === "number" && Number.isFinite(value) ? `${value > 0 && /[1-9]/.test(wholeAmount(value)) ? "+" : ""}${wholeAmount(value)}` : formatNumber(undefined)
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
    ? formatMarketPrice(value, { assetCategory: textOf(row.assetCategory), minimumFractionDigits: currencyPriceMinDigits(textOf(row[currencyKey])) })
    : formatNumber(undefined)
);

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const POSITION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "exchange", header: "Exchange" },
  { key: "shares", header: "Qty", align: "right", format: quantity },
  { key: "avgCost", header: "Avg Cost", align: "right", format: unitMoney("positionCurrency"), description: "Per unit, in the position's currency." },
  { key: "price", header: "Last", align: "right", format: unitMoney("priceCurrency"), description: "In the quote's currency." },
  { key: "priceCurrency", header: "Ccy" },
  { key: "changePercent", header: "Chg", align: "right", format: percent },
  { key: "marketValue", header: "Mkt Val", align: "right", format: wholeAmount, description: "In the portfolio's currency; negative for shorts." },
  { key: "unrealizedPnl", header: "P&L", align: "right", format: amount, description: "Unrealized, in the portfolio's currency." },
  { key: "weight", header: "Weight", align: "right", format: weight, description: "Percent of the total value, cash included; unpriced holdings are left out." },
];

/** Last, after the targets: when the price each row is valued at is from. */
const VALUATION_TIME_COLUMN: HeadlessPaneColumn = {
  key: "valuationAsOf",
  header: "As of (UTC)",
  // Exports keep the ISO time.
  textFormat: (value) => valuationTimeText(value),
  shrink: false,
  description: "When the price the row is valued at is from: its print, or the regular close with --close.",
};

/** Shown once the portfolio has a target weight. */
const TARGET_COLUMNS: HeadlessPaneColumn[] = [
  { key: "targetWeight", header: "Target", align: "right", format: weight, description: "Target weight, in percent." },
  { key: "drift", header: "Drift", align: "right", format: drift, description: "Weight minus target, in percentage points." },
  { key: "tradeShares", header: "Trade", align: "right", format: tradeUnits, description: "Units to buy (+) or sell (-) to reach the target at the current price." },
  { key: "tradeValue", header: "Trade Value", align: "right", format: signedAmount, description: "The trade in the portfolio's currency." },
];

/** The pre-market or after-hours print and its move from the regular close, for the rows that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${unitMoney("priceCurrency")(value, row)} ${percent(row.extendedChangePercent)}`
      : formatNumber(undefined),
    description: "Measured from the regular close in Last.",
  };
}

/** `columns` with an extended column after Chg for each session a row has a print for. */
function withExtendedColumns(columns: HeadlessPaneColumn[], sessions: readonly ExtendedSession[]): HeadlessPaneColumn[] {
  if (sessions.length === 0) return columns;
  const at = columns.findIndex((column) => column.key === "changePercent") + 1;
  return [...columns.slice(0, at), ...sessions.map(extendedColumn), ...columns.slice(at)];
}

const WATCHLIST_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "exchange", header: "Exchange" },
  { key: "price", header: "Last", align: "right" },
  { key: "priceCurrency", header: "Ccy" },
  { key: "changePercent", header: "Chg", align: "right", format: percent },
];

/**
 * `columns` with the text report's Ticker column naming each listing as
 * `portfolio show` does (SAN:EPA, SAN:NYSE), not by the key it is stored under,
 * which leaves two listings of one symbol looking alike. `textFormat` is text
 * only: JSON and CSV keep the stored key in `symbol`, and the rows stay keyed
 * by it.
 */
function withListingLabels(columns: HeadlessPaneColumn[], tickers: readonly TickerRecord[]): HeadlessPaneColumn[] {
  const labels = new Map(tickers.map((ticker) => [ticker.metadata.ticker, listingLabel(ticker)]));
  return columns.map((column) => column.key !== "symbol" ? column : {
    ...column,
    textFormat: (value, row) => {
      // The cash line is not a listing, even when a ticker is called CASH; its row carries no exchange.
      if (typeof value !== "string" || !("exchange" in row)) return textOf(value) ?? formatNumber(undefined);
      return labels.get(value) ?? value;
    },
  });
}

/** When the price a row shows was observed: in a pre-market nothing has traded in, the close it stands at. */
function headlineTime(quote: Quote | undefined): number | null {
  return quote ? quoteHeadlineTime(quote) : null;
}

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
  const collections = [...config.portfolios, ...config.watchlists];
  throw new Error(
    collections.length
      ? `Unknown portfolio or watchlist "${raw}". Portfolios and watchlists: ${describeCollections(collections)}.`
      : `Unknown portfolio or watchlist "${raw}". No portfolios or watchlists are set up.`,
  );
}

async function portfolioHoldings(
  target: Extract<CollectionMatch, { kind: "portfolio" }>,
  limit: number,
  ctx: HeadlessPaneContext,
  basis: PortfolioValuationBasis,
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
    basis,
  });
  const { allocation, cash } = await valuePortfolioAllocation({ valuation, portfolio: resolved.portfolio, account: resolved.account, toBase });
  ctx.signal.throwIfAborted();

  const allocationBySymbol = new Map(allocation.rows.map((row) => [row.symbol, row]));
  const held = valuation.positions.filter((entry) => entry.position);
  const gross = held.reduce((sum, entry) => sum + Math.abs(finite(entry.row.marketValue) ?? 0), 0);
  const sum = (key: string) => held.reduce((total, entry) => total + (finite(entry.row[key]) ?? 0), 0);
  const seen = new Set<string>();
  const extendedSessions = extendedSessionsOf(held.map(({ extended }) => extended?.session));
  const rows = held
    .map(({ ticker, headline, extended, row, valuation: priced }) => {
      const marketValue = finite(row.marketValue);
      // A ticker held in several lots carries its allocation on its first row.
      const figures = seen.has(ticker.metadata.ticker) ? undefined : allocationBySymbol.get(ticker.metadata.ticker);
      seen.add(ticker.metadata.ticker);
      return {
        ...quoteFreshnessFields(quotes.get(ticker.metadata.ticker)),
        // When the price shown was observed, as `quote` dates it (quoteHeadlineTime).
        updatedAt: headlineTime(quotes.get(ticker.metadata.ticker)),
        symbol: ticker.metadata.ticker,
        // The name the listing's quote gives now, as `quote` names it, else the saved one.
        name: currentListingName(ticker, quotes.get(ticker.metadata.ticker)) ?? ticker.metadata.name ?? null,
        exchange: ticker.metadata.exchange || null,
        assetCategory: ticker.metadata.assetCategory ?? null,
        shares: finite(row.shares),
        avgCost: finite(row.avgCost),
        positionCurrency: row.positionCurrency ?? null,
        // Last and Chg are the regular session; market value and P&L are at `valuationPrice`.
        price: finite(row.quotePrice),
        priceCurrency: row.quoteCurrency ?? null,
        changePercent: finite(headline?.changePercent),
        ...extendedQuoteFields(extended),
        marketValue,
        unrealizedPnl: finite(row.unrealizedPnl),
        weight: figures?.weight ?? null,
        targetWeight: figures?.targetWeight ?? null,
        drift: figures?.drift ?? null,
        tradeShares: figures?.tradeUnits ?? null,
        tradeValue: figures?.tradeValue ?? null,
        ...priced,
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
  const imported = importedFromText(target.portfolio);
  const dayMove = basis === "regular-close" ? portfolioDayMove(valuation) : null;
  const notices = [
    ...(imported ? [imported] : []),
    // At the close, Mkt Val is Last times the shares; the day's move from the close before gets its own line.
    ...(basis === "regular-close" ? [dayMoveLine(dayMove, currency)] : []),
    ...(rows.length > limit
      ? [`${rows.length - limit} more position${rows.length - limit === 1 ? "" : "s"} not shown; totals include every position.`]
      : []),
    ...(targetNote ? [targetNote] : []),
    ...(target.portfolio.brokerInstanceId && !resolved.account ? [BROKER_ACCOUNT_MISSING_NOTE] : []),
  ];

  return {
    // Dated by the prices the value uses, and the oldest of them in exports, with the basis in the closing line.
    freshness: {
      source: broker ? "Your broker account and Gloom Cloud" : "Local portfolio and Gloom Cloud",
      observedKey: "valuationAsOf",
      citeOldest: true,
      note: `priced at ${VALUATION_BASIS_LABELS[basis]}`,
    },
    columns: withListingLabels(
      withExtendedColumns([...POSITION_COLUMNS, ...(showTargets ? TARGET_COLUMNS : []), VALUATION_TIME_COLUMN], extendedSessions),
      tickers,
    ),
    rows: shown,
    complete: unavailable.length === 0,
    ...(unavailable.length
      ? { errors: [`No market value or P&L for ${unavailable.join(", ")}; totals and weights leave them out.`] }
      : {}),
    metadata: {
      collection: { kind: "portfolio", id: target.id, name: target.name, broker },
      ...(target.portfolio.importedFrom ? { importedFrom: target.portfolio.importedFrom } : {}),
      currency,
      valuationBasis: basis,
      positions: rows.length,
      totals: {
        marketValue: sum("marketValue"),
        grossMarketValue: gross,
        costBasis: sum("costBasis"),
        unrealizedPnl: valuation.totalPnl,
        cash: allocation.cash ? finite(allocation.cash.value) : null,
        total: allocation.total,
        // At the regular close, the holdings' move from the close before.
        ...(basis === "regular-close" ? { dayChange: dayMove?.change ?? null, dayChangePercent: dayMove?.changePercent ?? null } : {}),
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
    // As the watchlist pane shows it: the regular session, then any extended print from its close.
    const { headline, extended } = collectionQuoteHeadline(quote);
    return {
      ...quoteFreshnessFields(quote),
      updatedAt: headlineTime(quote),
      symbol: ticker.metadata.ticker,
      name: currentListingName(ticker, quote) ?? ticker.metadata.name ?? null,
      exchange: ticker.metadata.exchange || null,
      price: finite(headline?.price ?? quote?.price),
      priceCurrency: quote?.currency ?? null,
      changePercent: finite(headline ? headline.changePercent : quote?.changePercent),
      ...extendedQuoteFields(extended),
    };
  });
  const shown = rows.slice(0, limit);
  return {
    freshness: { source: "Local watchlist and Gloom Cloud" },
    columns: withListingLabels(
      withExtendedColumns(WATCHLIST_COLUMNS, extendedSessionsOf(shown.map((row) => row.extendedSession))),
      tickers,
    ),
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
    "Positions held in a portfolio, broker or manual: symbol, exchange, shares, average cost, last price, market value, unrealized P&L, weight of the total with cash and when each row's price is from, largest first, then the cash line and totals. Values are at the latest print, extended hours included, or at the regular close with close. With target weights set, each row adds its target, drift and the trade to reach it. For a watchlist, its tickers with quotes. Takes a portfolio or watchlist ID; the first portfolio when omitted.",
  discovery: {
    dataRequirements: ["Local portfolios, watchlists and synced broker positions; current quotes"],
    limitations: ["Unrealized P&L on current positions; excludes realized trades, distributions and cash flows."],
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
      shot: REPORT_ROWS,
      type: "integer",
      defaultValue: DEFAULT_ROW_LIMIT,
      minimum: 1,
      maximum: MAX_ROW_LIMIT,
      description: "Largest positions, or first tickers, to list. Totals cover all of them.",
    },
    {
      key: "close",
      type: "boolean",
      defaultValue: false,
      settingKey: "valueAtClose",
      description: "Value the portfolio at the regular close, not the latest print: Value is Last times the shares.",
    },
  ],
  columns: POSITION_COLUMNS,
  describe: (args) => (args.rawArgument ? `Holdings | ${args.rawArgument}` : "Holdings"),
  async load(args, ctx) {
    const target = resolveTarget(args.rawArgument, ctx);
    const limit = rowLimit(args.options.limit);
    return target.kind === "portfolio"
      ? portfolioHoldings(target, limit, ctx, args.options.close === true ? "regular-close" : "latest-print")
      : watchlistHoldings(target, limit, ctx);
  },
};
