import { createBaseConverter } from "../../../../cli/base-converter";
import { withMarketData } from "../../../../cli/scoped-context";
import {
  countCollectionTickers,
  formatSignedCurrency,
} from "../../../../cli/helpers";
import {
  cliStyles,
  colorBySign,
  renderSection,
  renderStats,
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
  const known = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;

  for (const ticker of tickers) {
    const quote = quotes.get(ticker.metadata.ticker);
    const positions = ticker.metadata.positions.filter((position) => position.portfolio === id && position.shares !== 0);
    const displayedQuote = getActiveQuoteDisplay(quote);
    const activeQuote = displayedQuote && Number.isFinite(displayedQuote.price) ? displayedQuote : null;

    if (positions.length === 0) {
      values.push({ ticker, quote, activeQuote, position: null, metrics: null, pnl: null,
        row: { symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange, shares: null, avgCost: null,
          positionCurrency: null, quotePrice: known(activeQuote?.price), quoteCurrency: quote?.currency ?? null,
          costBasis: null, marketValue: null, unrealizedPnl: null, baseCurrency: currency } });
      continue;
    }

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
      values.push({ ticker, quote, activeQuote, position, metrics, pnl,
        row: { symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange,
          shares: metrics.totalShares, avgCost: known(position.avgCost), positionCurrency,
          priceBasis: position.priceBasis ?? null, quantityUnit: metrics.priceBasis === "percent-of-par" ? "face" : null, quotePriceBasis: quote?.priceBasis ?? null,
          quotePrice: known(activeQuote?.price), quoteCurrency, quoteAsOf: quote?.lastUpdated ?? null,
          costBasis: known(direction * costBasisBase), marketValue: currentValueBase == null ? null : known(direction * currentValueBase),
          unrealizedPnl: known(pnl), baseCurrency: currency, dateAcquired: position.dateAcquired ?? null,
          pnlBasis: selectedPnl.basis, brokerUnrealizedPnl: known(position.unrealizedPnl), brokerPnlCurrency: positionCurrency, brokerPnlAsOf: null } });
    }
  }

  return { positions: values, totalPnl, unavailablePnl, unavailableCost, unavailableMarketValue, brokerPnlSymbols };
}

async function showCollectionWithMarketData(
  name: string,
  ctx: CliCommandContext,
  { config, store, dataProvider }: MarketContext,
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

  if (filtered.length === 0 && !structured) {
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

  if (isPortfolio) {
    const {
      positions: valued,
      totalPnl,
      unavailablePnl,
      unavailableCost,
      unavailableMarketValue,
      brokerPnlSymbols,
    } = await valuePortfolioPositions({ tickers: filtered, quotes, portfolioId: id, currency, baseCurrency: config.baseCurrency, toBase });
    const positionsExport = valued.map((entry) => entry.row);
    const rows: string[][] = valued.map(({ ticker, quote, activeQuote, position, metrics, pnl }) => {
      const priceText = quote && activeQuote
        ? colorBySign(formatMarketPriceWithCurrency(activeQuote.price, quote.currency, priceFormatOptions(quote, ticker.metadata.assetCategory)), activeQuote.change)
        : "—";
      const changeText = activeQuote ? colorBySign(formatPercentRaw(activeQuote.changePercent), activeQuote.change) : "—";
      if (!position || !metrics) return [ticker.metadata.ticker, priceText, changeText, "—", "—", "—"];
      const positionCurrency = metrics.positionCurrency;
      return [
        ticker.metadata.ticker,
        priceText,
        changeText,
        formatMarketQuantity(metrics.totalShares, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency }),
        formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis }),
        pnl == null || !Number.isFinite(pnl) ? "—" : colorBySign(formatSignedCurrency(pnl, currency), pnl),
      ];
    });

    const accountingBasis = "Unrealized P&L on current positions; excludes realized trades, distributions and cash flows. This is not account investment return.";
    const manualAccounting = !matchedPortfolio?.brokerId && !matchedPortfolio?.brokerInstanceId
      ? "Manual holdings are snapshots. Reconcile shares and per-share cost after corporate actions using portfolio position set; cash distributions are not credited."
      : null;
    if (structured) {
      ctx.printResult({ data: positionsExport, metadata: {
        portfolioId: id, portfolioName: displayName, baseCurrency: currency,
        totalUnrealizedPnl: unavailablePnl.size > 0 ? null : totalPnl,
        complete: unavailablePnl.size === 0 && unavailableCost.size === 0 && unavailableMarketValue.size === 0,
        unavailableSymbols: [...new Set([...unavailablePnl, ...unavailableCost, ...unavailableMarketValue])],
        unavailableCostSymbols: [...unavailableCost], brokerPnlSymbols: [...brokerPnlSymbols],
        accountingBasis, ...(manualAccounting ? { manualAccounting } : {}),
      }, freshness });
      return;
    }

    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Last", align: "right" },
        { header: "Chg", align: "right" },
        { header: filtered.some(ticker => ticker.metadata.assetCategory?.toUpperCase() === "BOND") || positionsExport.some(row => row.quantityUnit === "face") ? "Qty" : "Shares", align: "right" },
        { header: "Avg Cost", align: "right" },
        { header: "P&L", align: "right" },
      ],
      rows,
    ));
    console.log("");
    console.log(renderStats([[brokerPnlSymbols.size ? "Total P&L (incl. broker snapshots)" : "Total P&L", unavailablePnl.size > 0 ? "—" : colorBySign(formatSignedCurrency(totalPnl, currency), totalPnl)]]));
    if (unavailableCost.size > 0) console.log(cliStyles.muted(`Cost unavailable for ${[...unavailableCost].join(", ")}.`));
    if (unavailablePnl.size > 0) console.log(cliStyles.muted(`P&L unavailable for ${[...unavailablePnl].join(", ")}.`));
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
