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
  exposureLine,
  weightBasisLine,
  extendedQuoteFields,
  extendedSessionsOf,
  findCollection,
  listingLabel,
  loadCollectionQuotes,
  holdsFutures,
  portfolioDayMove,
  valuationTimeText,
  valuePortfolioAllocation,
  valuePortfolioPositions,
  costAtTodaysRateNotes,
  type CollectionMatch,
  type PortfolioValuation,
} from "./cli/render";
import { valuationBasisLabel, type PortfolioValuationBasis } from "../../../portfolio/valuation-basis";
import { futuresQuantityText, isFuturesTicker } from "../../../portfolio/futures-positions";
import { dailyFuturesHistory, loadPortfolioFuturesTerms } from "../../../portfolio/futures-terms";
import { loadPurchaseDateCostFx } from "../../../portfolio/cost-fx";
import { EXTENDED_SESSION_LABELS, quoteHeadlineTime, type ExtendedSession } from "../../../market-data/market/status";
import {
  BROKER_ACCOUNT_MISSING_NOTE,
  CASH_SYMBOL,
  describeTargetSum,
  formatAllocationDrift,
  formatAllocationWeight,
  formatTradeUnits,
  lotWeight,
  type PortfolioAllocation,
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
/** Shares, or a future's contracts and what each one is: 1,000 × 100 oz. */
const quantity = (value: unknown, row: HeadlessPaneRow) => {
  if (typeof value !== "number") return formatNumber(undefined);
  const text = formatMarketQuantity(value, { assetCategory: textOf(row.assetCategory) });
  const size = textOf(row.contractSize) ?? (typeof row.contractMultiplier === "number" ? formatMarketQuantity(row.contractMultiplier) : undefined);
  return size ? futuresQuantityText(text, { size }) : text;
};
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

/** The weight of a book that holds a short: a share of its gross exposure. */
const GROSS_WEIGHT_DESCRIPTION = "Percent of gross exposure, longs plus shorts at their absolute value, as the book holds a short; negative for a short, cash and unpriced holdings left out.";

/** Last, after the targets: when the price each row is valued at is from. */
const VALUATION_TIME_COLUMN: HeadlessPaneColumn = {
  key: "valuationAsOf",
  header: "As of (UTC)",
  // Exports keep the ISO time.
  textFormat: (value, row) => valuationTimeText(value, undefined, row.valuationPriceKind === "settle" ? "settle" : undefined),
  shrink: false,
  description: "When the price the row is valued at is from: its print, or the regular close with --close (a future's settlement).",
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

/**
 * What a report cannot price, said for each cause. A holding without a market
 * value is out of the totals and weights; one with a value but no cost is in
 * them, and only its P&L is unknown.
 */
function unavailableFigureErrors(
  { unavailableMarketValue, unavailablePnl, unavailableCost, unknownContractSize, unsettled }:
    Pick<PortfolioValuation, "unavailableMarketValue" | "unavailablePnl" | "unavailableCost" | "unknownContractSize" | "unsettled">,
): string[] {
  // A future without its contract size or settlement is said once, for that cause.
  const explained = (symbol: string) => unknownContractSize.has(symbol) || unsettled.has(symbol);
  const noValue = [...unavailableMarketValue].filter((symbol) => !explained(symbol));
  const pnlOnly = [...unavailablePnl].filter((symbol) => !unavailableMarketValue.has(symbol) && !explained(symbol));
  const noCost = pnlOnly.filter((symbol) => unavailableCost.has(symbol));
  const noPnl = pnlOnly.filter((symbol) => !unavailableCost.has(symbol));
  const them = (symbols: readonly string[]) => (symbols.length === 1 ? "it" : "them");
  const unsized = [...unknownContractSize];
  const unpriced = [...unsettled];
  return [
    ...(unsized.length ? [`No contract size for ${unsized.join(", ")}, so ${unsized.length === 1 ? "its" : "their"} value, cost and P&L are unknown; totals and weights leave ${them(unsized)} out.`] : []),
    ...(unpriced.length ? [`No confirmed settlement for ${unpriced.join(", ")}, so ${unpriced.length === 1 ? "it is" : "they are"} not valued at the close; totals and weights leave ${them(unpriced)} out.`] : []),
    ...(noValue.length ? [`No market value for ${noValue.join(", ")}; totals and weights leave ${them(noValue)} out.`] : []),
    ...(noCost.length ? [`No cost for ${noCost.join(", ")}, so ${noCost.length === 1 ? "its" : "their"} P&L is unknown; totals and weights still count ${them(noCost)}.`] : []),
    ...(noPnl.length ? [`P&L unavailable for ${noPnl.join(", ")}; totals and weights still count ${them(noPnl)}.`] : []),
  ];
}

/** What a position line fills in; every other column of it prints blank. */
const POSITION_LINE_KEYS = new Set(["symbol", "shares", "marketValue", "weight", "targetWeight", "drift", "tradeShares", "tradeValue"]);

/**
 * The text report of a ticker held in several lots. Each lot weighs by its own
 * value, and a line under its lots gives the whole position: its shares, value,
 * weight, target, drift and trade, which no single lot owns. Null when no
 * ticker has several lots, so the report is the rows as they are. JSON and CSV
 * keep one row per lot.
 */
function withPositionLines(
  rows: readonly HeadlessPaneRow[],
  columns: HeadlessPaneColumn[],
  positions: ReadonlyMap<string, PortfolioAllocation["rows"][number]>,
): { rows: HeadlessPaneRow[]; columns: HeadlessPaneColumn[] } | null {
  const lotted = (row: HeadlessPaneRow): row is HeadlessPaneRow & { lots: number } => typeof row.lots === "number";
  if (!rows.some(lotted)) return null;
  const lastLot = new Map<string, number>();
  rows.forEach((row, index) => { if (lotted(row)) lastLot.set(String(row.symbol), index); });
  return {
    rows: rows.flatMap((row, index): HeadlessPaneRow[] => {
      if (!lotted(row)) return [row];
      const symbol = String(row.symbol);
      const lot = { ...row, weight: row.lotWeight, targetWeight: null, drift: null, tradeShares: null, tradeValue: null };
      const whole = positions.get(symbol);
      if (!whole || lastLot.get(symbol) !== index) return [lot];
      return [lot, {
        positionLots: row.lots, symbol, exchange: row.exchange, assetCategory: row.assetCategory, shares: whole.units,
        marketValue: whole.marketValue, weight: whole.weight, targetWeight: whole.targetWeight, drift: whole.drift,
        tradeShares: whole.tradeUnits, tradeValue: whole.tradeValue,
      }];
    }),
    columns: columns.map((column) => {
      const text = (value: unknown, row: HeadlessPaneRow) => (column.textFormat ?? column.format)?.(value, row) ?? textOf(value) ?? formatNumber(undefined);
      if (column.key === "symbol") {
        return { ...column, textFormat: (value, row) => typeof row.positionLots === "number" ? `${text(value, row)} (${row.positionLots} lots)` : text(value, row) };
      }
      return POSITION_LINE_KEYS.has(column.key) ? column : { ...column, textFormat: (value, row) => typeof row.positionLots === "number" ? "" : text(value, row) };
    }),
  };
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
  const futuresHeld = tickers.filter((ticker) => isFuturesTicker(ticker)
    && ticker.metadata.positions.some((position) => position.portfolio === target.id && position.shares !== 0));
  const [quotes, futures, purchaseDateFx] = await Promise.all([
    loadCollectionQuotes(tickers, target, ctx.marketData, { datesChangeBasis: basis === "regular-close" }),
    loadPortfolioFuturesTerms(futuresHeld, {
      settlement: basis === "regular-close",
      sources: { history: dailyFuturesHistory(ctx.marketData) },
    }),
    loadPurchaseDateCostFx(tickers, { into: currency, history: ctx.apiClient, portfolioId: target.id }),
  ]);
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
    futures,
    purchaseDateFx,
  });
  const { allocation, cash } = await valuePortfolioAllocation({ valuation, portfolio: resolved.portfolio, account: resolved.account, toBase });
  ctx.signal.throwIfAborted();

  const allocationBySymbol = new Map(allocation.rows.map((row) => [row.symbol, row]));
  const held = valuation.positions.filter((entry) => entry.position);
  const gross = held.reduce((sum, entry) => sum + Math.abs(finite(entry.row.marketValue) ?? 0), 0);
  const sum = (key: string) => held.reduce((total, entry) => total + (finite(entry.row[key]) ?? 0), 0);
  const seen = new Set<string>();
  const extendedSessions = extendedSessionsOf(held.map(({ extended }) => extended?.session));
  const lotCounts = new Map<string, number>();
  // What a position is worth sorts its lots together; one lot without a market value leaves the whole position last.
  const positionExposure = new Map<string, number>();
  for (const { ticker, row } of held) {
    const symbol = ticker.metadata.ticker;
    const value = finite(row.marketValue);
    lotCounts.set(symbol, (lotCounts.get(symbol) ?? 0) + 1);
    positionExposure.set(symbol, positionExposure.get(symbol) === -1 || value == null ? -1 : (positionExposure.get(symbol) ?? 0) + Math.abs(value));
  }
  // Largest position first, its lots together, the largest lot first; a position without a market value sorts last.
  const ordered = [...held].sort((left, right) => (
    positionExposure.get(right.ticker.metadata.ticker)! - positionExposure.get(left.ticker.metadata.ticker)!
    || left.ticker.metadata.ticker.localeCompare(right.ticker.metadata.ticker)
    || exposure(finite(right.row.marketValue)) - exposure(finite(left.row.marketValue))
  ));
  const rows = ordered
    .map(({ ticker, headline, extended, row, valuation: priced, futures: contract, position }) => {
      const marketValue = finite(row.marketValue);
      // A ticker held in several lots carries its allocation, the whole position's, on its first row.
      const figures = seen.has(ticker.metadata.ticker) ? undefined : allocationBySymbol.get(ticker.metadata.ticker);
      seen.add(ticker.metadata.ticker);
      const lots = lotCounts.get(ticker.metadata.ticker) ?? 0;
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
        // Only on a ticker held in several lots: `lots` says the allocation on its first row is the whole position's, `lotWeight` is this lot's own share.
        ...(lots > 1 ? { lots, lotWeight: lotWeight(marketValue, allocation.weightBase) } : {}),
        // Only on a future: `shares` counts contracts, each `contractMultiplier` units of the price, as the exchange sizes it.
        ...(contract && position ? { contractMultiplier: position.multiplier ?? null, contractSize: contract.size?.size ?? null } : {}),
      };
    });
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
  const errors = unavailableFigureErrors(valuation);
  const broker = !!(target.portfolio.brokerId || target.portfolio.brokerInstanceId);
  const showTargets = allocation.targetSum != null;
  const targetNote = describeTargetSum(allocation.targetSum, allocation.weightBasis);
  const imported = importedFromText(target.portfolio);
  const dayMove = basis === "regular-close" ? portfolioDayMove(valuation) : null;
  const notices = [
    ...(imported ? [imported] : []),
    // At the close, Mkt Val is Last times the shares; the day's move from the close before gets its own line.
    ...(basis === "regular-close" ? [dayMoveLine(dayMove, currency)] : []),
    ...(held.length > 0 ? [exposureLine(valuation.exposure, currency)] : []),
    ...[weightBasisLine(allocation, currency)].filter((line): line is string => !!line),
    ...(rows.length > limit
      ? [`${rows.length - limit} more position${rows.length - limit === 1 ? "" : "s"} not shown; totals include every position.`]
      : []),
    ...(targetNote ? [targetNote] : []),
    ...(target.portfolio.brokerInstanceId && !resolved.account ? [BROKER_ACCOUNT_MISSING_NOTE] : []),
    ...costAtTodaysRateNotes(valuation, (symbols) => [...symbols].join(", ")),
  ];

  const positionColumns = allocation.weightBasis === "gross"
    ? POSITION_COLUMNS.map((column) => column.key === "weight" ? { ...column, description: GROSS_WEIGHT_DESCRIPTION } : column)
    : POSITION_COLUMNS;
  const columns = withListingLabels(
    withExtendedColumns([...positionColumns, ...(showTargets ? TARGET_COLUMNS : []), VALUATION_TIME_COLUMN], extendedSessions),
    tickers,
  );
  const lotted = withPositionLines(shown, columns, allocationBySymbol);

  return {
    // Dated by the prices the value uses, and the oldest of them in exports, with the basis in the closing line.
    freshness: {
      source: broker ? "Your broker account and Gloom Cloud" : "Local portfolio and Gloom Cloud",
      observedKey: "valuationAsOf",
      citeOldest: true,
      note: `priced at ${valuationBasisLabel(basis, { futures: holdsFutures(valuation) })}`,
    },
    columns,
    rows: shown,
    ...(lotted ? { textColumns: lotted.columns, textRows: lotted.rows } : {}),
    complete: errors.length === 0,
    ...(errors.length ? { errors } : {}),
    metadata: {
      collection: { kind: "portfolio", id: target.id, name: target.name, broker },
      ...(target.portfolio.importedFrom ? { importedFrom: target.portfolio.importedFrom } : {}),
      currency,
      valuationBasis: basis,
      positions: rows.length,
      totals: {
        marketValue: sum("marketValue"),
        grossMarketValue: gross,
        // The priced holdings on each side: longs, and shorts as a negative value.
        longMarketValue: valuation.exposure.long,
        shortMarketValue: valuation.exposure.short,
        costBasis: sum("costBasis"),
        unrealizedPnl: valuation.totalPnl,
        cash: allocation.cash ? finite(allocation.cash.value) : null,
        total: allocation.total,
        // At the regular close, the holdings' move from the close before.
        ...(basis === "regular-close" ? { dayChange: dayMove?.change ?? null, dayChangePercent: dayMove?.changePercent ?? null, dayChangeBasis: dayMove?.basis ?? null } : {}),
      },
      // Only on a book that holds a short: its weights are shares of `weightBase`, its gross exposure, not of the total.
      ...(allocation.weightBasis === "gross" ? { weightBasis: allocation.weightBasis, weightBase: allocation.weightBase } : {}),
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
    "Positions held in a portfolio, broker or manual: symbol, exchange, shares, average cost, last price, market value, unrealized P&L, weight of the total with cash (of the gross exposure for a book that holds a short) and when each row's price is from, largest first, then the cash line and totals. Values are at the latest print, extended hours included, or at the regular close with close. With target weights set, each row adds its target, drift and the trade to reach it. For a watchlist, its tickers with quotes. Takes a portfolio or watchlist ID; the first portfolio when omitted.",
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
