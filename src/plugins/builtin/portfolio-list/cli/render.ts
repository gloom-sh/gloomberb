import { createBaseConverter } from "../../../../cli/base-converter";
import { withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers } from "../../../../cli/helpers";
import {
  cliStyles,
  colorBySign,
  renderSection,
  renderTable,
} from "../../../../utils/cli-output";
import { formatCompact, formatPercentRaw } from "../../../../utils/format";
import { currencyMinorDigits, formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity, quoteFormatOptions } from "../../../../market-data/market/format";
import { resolvePriceBasis } from "../../../../market-data/market/price-basis";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl } from "../position-metrics";
import { resolvePortfolioTotalsCurrency } from "../summary/totals";
import { exchangeShortName, getActiveQuoteDisplay } from "../../../../market-data/market/status";
import type { AppConfig } from "../../../../types/config";
import type { DataProvider } from "../../../../types/data-provider";
import type { CliCommandContext } from "../../../../types/plugin";
import type { MarketContext } from "../../../../cli/types";
import type { Portfolio, TickerPosition, TickerRecord } from "../../../../types/ticker";
import { instrumentFromTicker } from "../../../../market-data/request-types";
import { toMarketDataContext } from "../../../../market-data/selectors";
import { cliFreshnessFooter } from "../../../../cli/result";
import { quotesFreshness } from "../../../../cli/freshness";
import type { BrokerAccount } from "../../../../types/trading";
import {
  CASH_SYMBOL,
  buildPortfolioAllocation,
  describeTargetSum,
  formatAllocationDrift,
  formatAllocationMoney,
  formatAllocationWeight,
  formatTradeUnits,
  hasTargetWeights,
  resolvePortfolioCash,
  type AllocationHolding,
  type PortfolioAllocation,
} from "../allocation";
import { findCachedPortfolioAccount } from "../cached-account";

/** Money prices pad to the currency's minor unit ($337.90, not $337.9), as the ticker view does. */
function priceFormatOptions(quote: Parameters<typeof quoteFormatOptions>[0] & { currency?: string }, assetCategory?: string) {
  const options = quoteFormatOptions(quote, assetCategory);
  return resolvePriceBasis(options.priceBasis, options.assetCategory) === "per-unit"
    ? { ...options, minimumFractionDigits: Math.min(2, currencyMinorDigits(quote?.currency)) }
    : options;
}

export function renderCollectionOverview(config: AppConfig, tickers: TickerRecord[]): string {
  const blocks: string[] = [];

  blocks.push(renderSection("Portfolios"));
  if (config.portfolios.length === 0) {
    blocks.push(cliStyles.muted("No portfolios configured."));
  } else {
    blocks.push(renderTable(
      [
        { header: "Portfolio" },
        { header: "Currency" },
        { header: "Tickers", align: "right" },
      ],
      config.portfolios.map((portfolio) => [
        portfolio.name,
        resolvePortfolioTotalsCurrency(portfolio, config.baseCurrency),
        String(countCollectionTickers(tickers, "portfolios", portfolio.id)),
      ]),
    ));
  }

  blocks.push("");
  blocks.push(renderSection("Watchlists"));
  if (config.watchlists.length === 0) {
    blocks.push(cliStyles.muted("No watchlists configured."));
  } else {
    blocks.push(renderTable(
      [
        { header: "Watchlist" },
        { header: "Tickers", align: "right" },
      ],
      config.watchlists.map((watchlist) => [
        watchlist.name,
        String(countCollectionTickers(tickers, "watchlists", watchlist.id)),
      ]),
    ));
  }

  return blocks.join("\n");
}

export async function showCollection(name: string, ctx: CliCommandContext) {
  await withMarketData(ctx, (context) => showCollectionWithMarketData(name, ctx, context));
}

/** A portfolio or watchlist named by its id or its name, either in any case. */
export type CollectionMatch =
  | { kind: "portfolio"; id: string; name: string; portfolio: Portfolio }
  | { kind: "watchlist"; id: string; name: string };

export function findCollection(config: AppConfig, name: string): CollectionMatch | null {
  const normalized = name.trim().toLowerCase();
  const portfolio = config.portfolios.find((entry) =>
    entry.id.toLowerCase() === normalized || entry.name.toLowerCase() === normalized
  );
  if (portfolio) return { kind: "portfolio", id: portfolio.id, name: portfolio.name, portfolio };
  const watchlist = config.watchlists.find((entry) =>
    entry.id.toLowerCase() === normalized || entry.name.toLowerCase() === normalized
  );
  return watchlist ? { kind: "watchlist", id: watchlist.id, name: watchlist.name } : null;
}

type CollectionQuote = Awaited<ReturnType<DataProvider["getQuote"]>>;

/**
 * Current quotes for a collection's tickers, keyed by symbol. A portfolio
 * quotes each holding's own contract; a failed quote leaves its ticker out so
 * the rest still values.
 */
export async function loadCollectionQuotes(
  tickers: readonly TickerRecord[],
  collection: Pick<CollectionMatch, "kind" | "id">,
  dataProvider: Pick<DataProvider, "getQuote">,
): Promise<Map<string, CollectionQuote>> {
  const isPortfolio = collection.kind === "portfolio";
  const quotes = new Map<string, CollectionQuote>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const instrument = isPortfolio ? instrumentFromTicker(ticker, ticker.metadata.ticker, { portfolioId: collection.id }) : null;
        if (isPortfolio && !instrument) return;
        const quote = await dataProvider.getQuote(ticker.metadata.ticker, ticker.metadata.exchange,
          instrument ? toMarketDataContext(instrument) : undefined);
        quotes.set(ticker.metadata.ticker, quote);
      } catch {
        // Ignore partial quote failures so the rest of the table still renders.
      }
    }),
  );
  return quotes;
}

/** One ticker of a portfolio: a valued position, or the ticker alone when it holds none. */
interface PortfolioPositionValue {
  ticker: TickerRecord;
  quote: CollectionQuote | undefined;
  activeQuote: ReturnType<typeof getActiveQuoteDisplay> | null;
  /** Null for a ticker kept in the portfolio without an open position. */
  position: TickerPosition | null;
  metrics: ReturnType<typeof getPortfolioPositionMetrics> | null;
  /** Unrealized P&L in the portfolio's currency. */
  pnl: number | null;
  /** The `portfolio show --json` row. */
  row: Record<string, unknown>;
}

export interface PortfolioValuation {
  positions: PortfolioPositionValue[];
  /** One per ticker, for weights and targets. */
  holdings: AllocationHolding[];
  totalPnl: number;
  unavailablePnl: Set<string>;
  unavailableCost: Set<string>;
  unavailableMarketValue: Set<string>;
  brokerPnlSymbols: Set<string>;
}

/**
 * Values every position of a portfolio in the portfolio's currency, as
 * `portfolio show` prints it: cost basis, market value and unrealized P&L
 * from the current quote, or the broker's snapshot where that is the basis.
 */
export async function valuePortfolioPositions({
  tickers,
  quotes,
  portfolioId,
  currency,
  baseCurrency,
  toBase,
}: {
  tickers: readonly TickerRecord[];
  quotes: ReadonlyMap<string, CollectionQuote>;
  portfolioId: string;
  currency: string;
  baseCurrency: string;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
}): Promise<PortfolioValuation> {
  const id = portfolioId;
  let totalPnl = 0;
  const unavailablePnl = new Set<string>();
  const unavailableCost = new Set<string>();
  const unavailableMarketValue = new Set<string>();
  const brokerPnlSymbols = new Set<string>();
  const values: PortfolioPositionValue[] = [];
  const holdings: AllocationHolding[] = [];
  const known = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;

  for (const ticker of tickers) {
    const quote = quotes.get(ticker.metadata.ticker);
    const positions = ticker.metadata.positions.filter((position) => position.portfolio === id && position.shares !== 0);
    const displayedQuote = getActiveQuoteDisplay(quote);
    const activeQuote = displayedQuote && Number.isFinite(displayedQuote.price) ? displayedQuote : null;

    if (positions.length === 0) {
      const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
      const unitPrice = activeQuote ? known(await toBase(activeQuote.price, quoteCurrency)) : null;
      holdings.push({ symbol: ticker.metadata.ticker, held: false, marketValue: 0, units: 0, unitPrice });
      values.push({ ticker, quote, activeQuote, position: null, metrics: null, pnl: null,
        row: { symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange, shares: null, avgCost: null,
          positionCurrency: null, quotePrice: known(activeQuote?.price), quoteCurrency: quote?.currency ?? null,
          costBasis: null, marketValue: null, unrealizedPnl: null, baseCurrency: currency } });
      continue;
    }

    const holding: AllocationHolding = { symbol: ticker.metadata.ticker, held: true, marketValue: 0, units: 0, unitPrice: null };
    holdings.push(holding);
    for (const position of positions) {
      const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
      const metrics = getPortfolioPositionMetrics({ ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, id, quoteCurrency, undefined, quote);
      const valuationQuote = getPortfolioQuoteDisplay(metrics, quote);
      const positionCurrency = metrics.positionCurrency;
      const costBasisBase = positionCurrency ? await toBase(metrics.totalCost, positionCurrency) : Number.NaN;

      const positionRate = positionCurrency ? await toBase(1, positionCurrency) : Number.NaN;
      const baseMetrics = getPortfolioPositionMetrics({ ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, id, quoteCurrency,
        { currency, convert: value => value * positionRate }, quote);
      const currentValueBase = resolvePortfolioMarketValue(baseMetrics,
        valuationQuote ? await toBase(valuationQuote.price, quoteCurrency) : null)?.gross ?? null;
      const selectedPnl = resolvePortfolioPositionPnl(baseMetrics,
        valuationQuote ? await toBase(valuationQuote.price, quoteCurrency) : null);
      const pnl = selectedPnl.value;
      if (!metrics.hasCostBasis) unavailableCost.add(ticker.metadata.ticker);
      if (known(currentValueBase) === null) unavailableMarketValue.add(ticker.metadata.ticker);
      if (selectedPnl.basis === "broker-snapshot" || selectedPnl.basis === "mixed") brokerPnlSymbols.add(ticker.metadata.ticker);
      if (pnl != null && Number.isFinite(pnl)) totalPnl += pnl;
      else unavailablePnl.add(ticker.metadata.ticker);
      const direction = metrics.totalShares < 0 ? -1 : 1;
      const marketValue = currentValueBase == null ? null : known(direction * currentValueBase);
      holding.marketValue = holding.marketValue == null || marketValue == null ? null : holding.marketValue + marketValue;
      holding.units += metrics.totalShares;
      holding.unitPrice ??= valuationQuote ? known(await toBase(valuationQuote.price, quoteCurrency)) : null;
      values.push({ ticker, quote, activeQuote, position, metrics, pnl,
        row: { symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange,
          shares: metrics.totalShares, avgCost: known(position.avgCost), positionCurrency,
          priceBasis: position.priceBasis ?? null, quantityUnit: metrics.priceBasis === "percent-of-par" ? "face" : null, quotePriceBasis: quote?.priceBasis ?? null,
          quotePrice: known(activeQuote?.price), quoteCurrency, quoteAsOf: quote?.lastUpdated ?? null,
          costBasis: known(direction * costBasisBase), marketValue,
          unrealizedPnl: known(pnl), baseCurrency: currency, dateAcquired: position.dateAcquired ?? null,
          pnlBasis: selectedPnl.basis, brokerUnrealizedPnl: known(position.unrealizedPnl), brokerPnlCurrency: positionCurrency, brokerPnlAsOf: null } });
    }
  }

  return { positions: values, holdings, totalPnl, unavailablePnl, unavailableCost, unavailableMarketValue, brokerPnlSymbols };
}

/** A portfolio's cash line, as `portfolio show` and `fn PF` report it. */
export interface PortfolioCashReport {
  /** In the cash's own currency. */
  amount: number;
  currency: string;
  /** Recorded with `portfolio cash set`, or reported by the broker account. */
  source: "manual" | "broker";
  /** In the portfolio's currency; null when the rate is unavailable. */
  value: number | null;
}

/**
 * Weights, targets and trades for a valued portfolio, with its cash: the
 * broker account's when it reports one, else the amount entered by hand.
 */
export async function valuePortfolioAllocation({
  valuation,
  portfolio,
  account,
  toBase,
}: {
  valuation: Pick<PortfolioValuation, "holdings">;
  portfolio: Portfolio;
  account?: BrokerAccount | null;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
}): Promise<{ allocation: PortfolioAllocation; cash: PortfolioCashReport | null }> {
  const line = resolvePortfolioCash(portfolio, account);
  const value = line && line.currency ? await toBase(line.amount, line.currency) : null;
  const cash = line ? { amount: line.amount, currency: line.currency, source: line.source, value: value != null && Number.isFinite(value) ? value : null } : null;
  const allocation = buildPortfolioAllocation({
    holdings: valuation.holdings,
    cashValue: cash ? cash.value ?? Number.NaN : null,
    targets: portfolio.targetWeights,
  });
  return { allocation, cash };
}

/** Colors a signed figure only when its text shows a nonzero digit. */
function signed(text: string, value: number | null | undefined): string {
  return /[1-9]/.test(text) ? colorBySign(text, value) : text;
}

const NOT_AVAILABLE = "n/a";

async function showCollectionWithMarketData(
  name: string,
  ctx: CliCommandContext,
  { config, store, dataProvider, persistence }: MarketContext,
) {
  const tickers = (await store.loadAllTickers()).sort((left, right) =>
    left.metadata.ticker.localeCompare(right.metadata.ticker)
  );
  const collection = findCollection(config, name);

  if (!collection) {
    ctx.fail(
      `Collection "${name}" was not found.`,
      `Available: ${[...config.portfolios.map((portfolio) => portfolio.name), ...config.watchlists.map((watchlist) => watchlist.name)].join(", ")}`,
    );
  }

  const matchedPortfolio = collection.kind === "portfolio" ? collection.portfolio : undefined;
  const isPortfolio = !!matchedPortfolio;
  const id = collection.id;
  const displayName = collection.name;
  const structured = isPortfolio && ctx.cliOptions?.format != null && ctx.cliOptions.format !== "text";
  const filtered = tickers.filter((ticker) =>
    isPortfolio ? ticker.metadata.portfolios.includes(id) : ticker.metadata.watchlists.includes(id)
  );
  // A portfolio reports in its own currency, as its pane totals; a watchlist in the base currency.
  const currency = resolvePortfolioTotalsCurrency(matchedPortfolio, config.baseCurrency);
  const toBase = createBaseConverter(dataProvider, currency);
  const account = matchedPortfolio ? findCachedPortfolioAccount(config, matchedPortfolio, persistence?.resources) : null;
  const hasCash = !!resolvePortfolioCash(matchedPortfolio, account) || hasTargetWeights(matchedPortfolio);

  if (filtered.length === 0 && !structured && !hasCash) {
    console.log(cliStyles.bold(displayName));
    console.log(cliStyles.muted("No tickers in this collection."));
    return;
  }

  const quotes = await loadCollectionQuotes(filtered, collection, dataProvider);
  // Worst of across the holdings' quotes, as the PORT and watchlist reports state it.
  const broker = !!(matchedPortfolio?.brokerId || matchedPortfolio?.brokerInstanceId);
  const freshness = quotesFreshness(quotes.values(), {
    source: !isPortfolio ? "Local watchlist and Gloom Cloud"
      : broker ? "Your broker account and Gloom Cloud" : "Local portfolio and Gloom Cloud",
  });

  if (!structured) {
    console.log(cliStyles.bold(displayName + (isPortfolio ? ` (${currency})` : "")));
    console.log(cliStyles.muted(`${filtered.length} ticker${filtered.length === 1 ? "" : "s"}`));
    console.log("");
  }

  if (matchedPortfolio) {
    const valuation = await valuePortfolioPositions({ tickers: filtered, quotes, portfolioId: id, currency, baseCurrency: config.baseCurrency, toBase });
    const {
      positions: valued,
      totalPnl,
      unavailablePnl,
      unavailableCost,
      unavailableMarketValue,
      brokerPnlSymbols,
    } = valuation;
    const { allocation, cash } = await valuePortfolioAllocation({ valuation, portfolio: matchedPortfolio, account, toBase });
    const allocationBySymbol = new Map(allocation.rows.map((row) => [row.symbol, row]));
    const showTargets = allocation.targetSum != null;
    // A ticker held in several lots carries its allocation on its first row.
    const firstRows = new Set<string>();
    const positionsExport = valued.map((entry): Record<string, unknown> & {
      weight: number | null; targetWeight: number | null; drift: number | null; tradeShares: number | null; tradeValue: number | null;
    } => {
      const symbol = entry.ticker.metadata.ticker;
      const first = !firstRows.has(symbol);
      firstRows.add(symbol);
      const figures = first ? allocationBySymbol.get(symbol) : undefined;
      return {
        ...entry.row,
        weight: figures?.weight ?? null,
        targetWeight: figures?.targetWeight ?? null,
        drift: figures?.drift ?? null,
        tradeShares: figures?.tradeUnits ?? null,
        tradeValue: figures?.tradeValue ?? null,
      };
    });
    const totalPnlValue = unavailablePnl.size > 0 ? null : totalPnl;
    const cashExport = cash && allocation.cash ? {
      ...cash,
      weight: allocation.cash.weight,
      targetWeight: allocation.cash.targetWeight,
      drift: allocation.cash.drift,
      tradeValue: allocation.cash.tradeValue,
    } : allocation.cash ? {
      amount: 0, currency, source: "manual" as const, value: 0,
      weight: allocation.cash.weight, targetWeight: allocation.cash.targetWeight,
      drift: allocation.cash.drift, tradeValue: allocation.cash.tradeValue,
    } : null;

    const accountingBasis = "Unrealized P&L on current positions; excludes realized trades, distributions and cash flows. This is not account investment return.";
    const manualAccounting = !matchedPortfolio.brokerId && !matchedPortfolio.brokerInstanceId
      ? "Manual holdings are snapshots. Reconcile shares and per-share cost after corporate actions using portfolio position set; cash distributions are not credited."
      : null;
    if (structured) {
      // CSV and NDJSON read the cash and the total as rows; JSON keeps them in the metadata.
      const extraRows: Record<string, unknown>[] = [
        ...(cashExport ? [{ symbol: CASH_SYMBOL, marketValue: cashExport.value, baseCurrency: currency, weight: cashExport.weight,
          targetWeight: cashExport.targetWeight, drift: cashExport.drift, tradeShares: null, tradeValue: cashExport.tradeValue }] : []),
        { symbol: "TOTAL", marketValue: allocation.total, unrealizedPnl: totalPnlValue, baseCurrency: currency,
          weight: allocation.total != null && allocation.total > 0 ? 100 : null, targetWeight: allocation.targetSum },
      ];
      ctx.printResult({ data: positionsExport, metadata: {
        portfolioId: id, portfolioName: displayName, baseCurrency: currency, currency,
        total: allocation.total, cash: cashExport, targetSum: allocation.targetSum,
        unpricedCount: allocation.unpriced.length, unpricedSymbols: allocation.unpriced,
        totalUnrealizedPnl: totalPnlValue,
        complete: unavailablePnl.size === 0 && unavailableCost.size === 0 && unavailableMarketValue.size === 0,
        unavailableSymbols: [...new Set([...unavailablePnl, ...unavailableCost, ...unavailableMarketValue])],
        unavailableCostSymbols: [...unavailableCost], brokerPnlSymbols: [...brokerPnlSymbols],
        accountingBasis, ...(manualAccounting ? { manualAccounting } : {}),
      }, freshness }, { rows: (data) => [...(data as Record<string, unknown>[]), ...extraRows] });
      return;
    }

    const money = (value: number | null | undefined, options?: { signed?: boolean }) => formatAllocationMoney(value, currency, options);
    // Values and trades in whole units keep the table inside 80 columns; prices, costs and P&L keep the minor unit.
    const wholeMoney = (value: number | null | undefined, options?: { signed?: boolean }) => formatAllocationMoney(value, currency, { ...options, whole: true });
    const allocationCells = (
      figures: { weight: number | null; targetWeight: number | null; drift: number | null; tradeValue: number | null; tradeUnits?: number | null } | undefined,
      { unpriced, units, assetCategory }: { unpriced: boolean; units?: number; assetCategory?: string },
    ): string[] => {
      const missing = unpriced ? NOT_AVAILABLE : "—";
      const weight = figures?.weight != null ? formatAllocationWeight(figures.weight) : missing;
      if (!showTargets) return [weight];
      const target = figures?.targetWeight != null ? formatAllocationWeight(figures.targetWeight) : "—";
      const hasTarget = figures?.targetWeight != null;
      const drift = figures?.drift != null ? signed(formatAllocationDrift(figures.drift), figures.drift) : hasTarget ? missing : "—";
      const trade = units == null ? "" : figures?.tradeUnits != null
        ? signed(formatTradeUnits(figures.tradeUnits, { units, assetCategory }), figures.tradeUnits)
        : hasTarget ? missing : "—";
      const tradeValue = figures?.tradeValue != null ? signed(wholeMoney(figures.tradeValue, { signed: true }), figures.tradeValue) : hasTarget ? missing : "—";
      return [weight, target, drift, trade, tradeValue];
    };

    const rows: string[][] = valued.map(({ ticker, quote, activeQuote, position, metrics, pnl, row }, index) => {
      const priceText = quote && activeQuote
        ? colorBySign(formatMarketPriceWithCurrency(activeQuote.price, quote.currency, priceFormatOptions(quote, ticker.metadata.assetCategory)), activeQuote.change)
        : "—";
      const changeText = activeQuote ? colorBySign(formatPercentRaw(activeQuote.changePercent), activeQuote.change) : "—";
      const exported = positionsExport[index]!;
      const figures = exported.weight != null || exported.targetWeight != null || exported.tradeValue != null
        ? { weight: exported.weight, targetWeight: exported.targetWeight, drift: exported.drift, tradeValue: exported.tradeValue, tradeUnits: exported.tradeShares }
        : undefined;
      const symbolUnits = allocationBySymbol.get(ticker.metadata.ticker)?.units ?? 0;
      if (!position || !metrics) {
        return [ticker.metadata.ticker, priceText, changeText, "—", "—", "—",
          ...allocationCells(figures, { unpriced: false, units: symbolUnits, assetCategory: ticker.metadata.assetCategory }), "—"];
      }
      const positionCurrency = metrics.positionCurrency;
      const marketValue = row.marketValue as number | null;
      const unpriced = marketValue == null;
      return [
        ticker.metadata.ticker,
        priceText,
        changeText,
        formatMarketQuantity(metrics.totalShares, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency }),
        formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis }),
        unpriced ? NOT_AVAILABLE : wholeMoney(marketValue),
        ...allocationCells(figures, { unpriced, units: symbolUnits, assetCategory: ticker.metadata.assetCategory }),
        pnl == null || !Number.isFinite(pnl) ? "—" : colorBySign(money(pnl, { signed: true }), pnl),
      ];
    });
    if (cashExport) {
      const label = cashExport.currency && cashExport.currency !== currency ? `${CASH_SYMBOL} ${cashExport.currency}` : CASH_SYMBOL;
      rows.push([label, "", "", "", "", cashExport.value == null ? NOT_AVAILABLE : wholeMoney(cashExport.value),
        ...allocationCells(cashExport, { unpriced: cashExport.value == null }), ""]);
    }
    const total = allocation.total;
    rows.push([
      cliStyles.bold("TOTAL"), "", "", "", "",
      cliStyles.bold(wholeMoney(total)),
      total != null && total > 0 ? formatAllocationWeight(100) : "—",
      ...(showTargets ? [formatAllocationWeight(allocation.targetSum), "", "", ""] : []),
      totalPnlValue == null ? "—" : colorBySign(money(totalPnlValue, { signed: true }), totalPnlValue),
    ]);

    const quantityHeader = filtered.some(ticker => ticker.metadata.assetCategory?.toUpperCase() === "BOND") || positionsExport.some(row => row.quantityUnit === "face") ? "Qty" : "Shares";
    // A narrow terminal drops the cost, then the quote, then P&L, before any of the allocation.
    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Last", align: "right", optional: true, dropPriority: 1 },
        { header: "Chg", align: "right", optional: true, dropPriority: 2 },
        { header: quantityHeader, align: "right" },
        { header: "Avg Cost", align: "right", optional: true, dropPriority: 3 },
        { header: "Value", align: "right" },
        { header: "Weight", align: "right" },
        ...(showTargets
          ? [
            { header: "Target", align: "right" as const },
            { header: "Drift", align: "right" as const },
            { header: "Trade", align: "right" as const },
            { header: "Trade Value", align: "right" as const },
          ]
          : []),
        { header: "P&L", align: "right", optional: true },
      ],
      rows,
    ));
    console.log("");
    const notes: string[] = [];
    if (allocation.unpriced.length > 0) {
      const count = allocation.unpriced.length;
      notes.push(cliStyles.warning(`Total and weights exclude ${count} unpriced holding${count === 1 ? "" : "s"}: ${allocation.unpriced.join(", ")}.`));
    }
    if (cashExport?.source === "broker") notes.push(cliStyles.muted("Cash is the broker account's balance as of its last sync."));
    if (cashExport && cashExport.value == null) {
      notes.push(cliStyles.warning(cashExport.currency
        ? `No ${cashExport.currency}/${currency} rate for the cash, so the total and weights are unavailable.`
        : "The cash's currency is unknown, so the total and weights are unavailable."));
    }
    const targetNote = describeTargetSum(allocation.targetSum);
    if (targetNote) notes.push(cliStyles.muted(targetNote));
    if (brokerPnlSymbols.size > 0) notes.push(cliStyles.muted(`P&L for ${[...brokerPnlSymbols].join(", ")} is the broker's last snapshot.`));
    if (unavailableCost.size > 0) notes.push(cliStyles.muted(`Cost unavailable for ${[...unavailableCost].join(", ")}.`));
    if (unavailablePnl.size > 0) notes.push(cliStyles.muted(`P&L unavailable for ${[...unavailablePnl].join(", ")}.`));
    for (const note of notes) console.log(note);
  } else {
    const rows: string[][] = [];
    for (const ticker of filtered) {
      const quote = quotes.get(ticker.metadata.ticker);
      const priceText = quote
        ? colorBySign(formatMarketPriceWithCurrency(quote.price, quote.currency, priceFormatOptions(quote, ticker.metadata.assetCategory)), quote.change)
        : "—";
      const changeText = quote ? colorBySign(formatPercentRaw(quote.changePercent), quote.change) : "—";
      const marketCapText = quote?.marketCap != null
        ? `${formatCompact(await toBase(quote.marketCap, quote.currency || ticker.metadata.currency || currency))} ${currency}`
        : "—";

      rows.push([
        ticker.metadata.ticker,
        exchangeShortName(quote?.exchangeName, quote?.fullExchangeName) || ticker.metadata.exchange || "—",
        priceText,
        changeText,
        marketCapText,
      ]);
    }

    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Exchange" },
        { header: "Last", align: "right" },
        { header: "Chg", align: "right" },
        { header: "Mkt Cap", align: "right" },
      ],
      rows,
    ));
  }
  if (freshness) console.log(`\n${cliFreshnessFooter(freshness)}`);
}
